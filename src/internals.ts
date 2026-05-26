import { duplexPair, type Duplex } from 'node:stream'
import WebSocket from 'ws'
import type { Server, IncomingMessage, ClientRequest } from 'node:http'
import type { EventEmitter } from 'node:events'

// The synthetic transport never validates Sec-WebSocket-Accept (we just regex
// the status line), so a fixed nonce is safe and saves a syscall per handshake.
// Value lifted from RFC 6455 §1.3.
const SYNTHETIC_SEC_WEBSOCKET_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

const EMPTY_HEAD = Buffer.alloc(0)

// `setSocket` is a documented-internal method on ws.WebSocket: not
// declared in @types/ws, but stable and used by adapters like
// fastify-websocket to complete a handshake against a synthetic socket.
type WebSocketInternal = WebSocket & {
  _isServer: boolean
  setSocket(socket: Duplex, head: Buffer, options: { maxPayload: number }): void
}

// `new WebSocket(null, ..., opts)` constructs a detached instance — no
// URL is dialled. ws 8.10+ reads `autoPong` / `closeTimeout` off the
// options object on this path, so a real object must be passed even
// though @types/ws only types the single-arg `null` overload. We
// attach the duplex as its socket once the handshake completes via
// `setSocket`.
const DetachedWebSocket = WebSocket as unknown as new (
  address: null,
  protocols: undefined,
  options: { autoPong: boolean }
) => WebSocket

const statusCodeReg = /HTTP\/1.1 (\d+)/u

type AttachKind = 'on' | 'once' | 'addListener' | 'prependListener' | 'prependOnceListener'

interface QueuedListener {
  event: string | symbol
  listener: (...args: any[]) => void
  kind: AttachKind
}

// Mirrors @types/ws's `on` / `once` overloads — listeners carry `this: WebSocket`.
interface WsListenerMap {
  'close': (this: WebSocket, code: number, reason: Buffer) => void
  'error': (this: WebSocket, error: Error) => void
  'upgrade': (this: WebSocket, request: IncomingMessage) => void
  'message': (this: WebSocket, data: WebSocket.RawData, isBinary: boolean) => void
  'open': (this: WebSocket) => void
  'ping': (this: WebSocket, data: Buffer) => void
  'pong': (this: WebSocket, data: Buffer) => void
  'redirect': (this: WebSocket, url: string, request: ClientRequest) => void
  'unexpected-response': (
    this: WebSocket,
    request: ClientRequest,
    response: IncomingMessage
  ) => void
}

// Mirrors @types/ws's `addListener` overloads — same shapes as on/once but
// without the `this: WebSocket` binding that EventEmitter's `addListener`
// doesn't expose.
type WsAddListenerMap = {
  [K in keyof WsListenerMap]: OmitThisParameter<WsListenerMap[K]>
}

export interface InjectWSOptions {
  /** Extra request headers. `host` defaults to 'localhost'. */
  headers?: Record<string, string>
}

/**
 * Thenable builder returned by `injectWS`. Listener registrations are queued
 * pre-connect and replayed onto the real `ws.WebSocket` BEFORE the synthetic
 * upgrade is emitted, closing the race window RFC 6455 permits between the
 * 101 response and the first server-sent frame.
 *
 * Awaiting the chain (or calling `.connect()`) triggers the upgrade and
 * resolves with the connected `WebSocket`. Idempotent — re-awaiting or
 * re-calling `.connect()` returns the same `Promise`.
 *
 * Listener-attachment methods mirror `ws.WebSocket`'s typed event overloads,
 * so consumers get the same listener-argument typing they'd get on the live
 * socket.
 */
export interface WebSocketChain extends PromiseLike<WebSocket> {
  on<K extends keyof WsListenerMap>(event: K, listener: WsListenerMap[K]): this
  on(event: string | symbol, listener: (this: WebSocket, ...args: any[]) => void): this

  once<K extends keyof WsListenerMap>(event: K, listener: WsListenerMap[K]): this
  once(event: string | symbol, listener: (this: WebSocket, ...args: any[]) => void): this

  addListener<K extends keyof WsAddListenerMap>(event: K, listener: WsAddListenerMap[K]): this
  addListener(event: string | symbol, listener: (...args: any[]) => void): this

  prependListener(event: string | symbol, listener: (...args: any[]) => void): this
  prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this

  /** Trigger the synthetic upgrade. Idempotent. */
  connect(): Promise<WebSocket>

  then<TResult1 = WebSocket, TResult2 = never>(
    onFulfilled?: ((value: WebSocket) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<WebSocket | TResult>

  finally(onFinally?: (() => void) | null): Promise<WebSocket>
}

export class WebSocketChainImpl implements WebSocketChain {
  #server: Server
  #url: string
  #headers: Record<string, string>
  #queued: QueuedListener[] = []
  #promise: Promise<WebSocket> | null = null

  constructor(server: Server, url: string, options: InjectWSOptions) {
    this.#server = server
    this.#url = url
    this.#headers = options.headers ?? {}
  }

  #enqueue(kind: AttachKind, event: string | symbol, listener: (...args: any[]) => void): this {
    this.#queued.push({ event, listener, kind })
    return this
  }

  on(event: string | symbol, listener: (...args: any[]) => void) {
    return this.#enqueue('on', event, listener)
  }
  once(event: string | symbol, listener: (...args: any[]) => void) {
    return this.#enqueue('once', event, listener)
  }
  addListener(event: string | symbol, listener: (...args: any[]) => void) {
    return this.#enqueue('addListener', event, listener)
  }
  prependListener(event: string | symbol, listener: (...args: any[]) => void) {
    return this.#enqueue('prependListener', event, listener)
  }
  prependOnceListener(event: string | symbol, listener: (...args: any[]) => void) {
    return this.#enqueue('prependOnceListener', event, listener)
  }

  connect(): Promise<WebSocket> {
    return (this.#promise ??= this.#runConnect())
  }

  then<TResult1 = WebSocket, TResult2 = never>(
    onFulfilled?: ((value: WebSocket) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.connect().then(onFulfilled, onRejected)
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<WebSocket | TResult> {
    return this.connect().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<WebSocket> {
    return this.connect().finally(onFinally)
  }

  #runConnect(): Promise<WebSocket> {
    const [serverStream, clientStream] = duplexPair()
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>()

    const ws = new DetachedWebSocket(null, undefined, { autoPong: true })
    const internalWs = ws as WebSocketInternal

    // RFC 6455 frame masking: client→server frames MUST be masked,
    // server→client MUST NOT. The null-address constructor hardcodes
    // `_isServer = true`; flip it so the returned `ws` behaves as a
    // client (masks outgoing, expects unmasked incoming).
    internalWs._isServer = false

    // Replay queued listeners BEFORE setSocket starts the parser, so any
    // frames the server sends during the upgrade reach consumer listeners.
    const emitter = ws as unknown as EventEmitter
    for (const { event, listener, kind } of this.#queued) {
      emitter[kind](event, listener)
    }

    ws.on('open', () => resolve(ws))

    const onData = (chunk: Buffer) => {
      // Detach before setSocket so we don't see post-handshake frames here.
      clientStream.removeListener('data', onData)

      const text = chunk.toString()
      if (text.includes('HTTP/1.1 101 Switching Protocols')) {
        internalWs.setSocket(clientStream, EMPTY_HEAD, { maxPayload: 0 })
      } else {
        const statusCodeText = text.match(statusCodeReg) ?? ['', '500']
        const statusCode = Number(statusCodeText[1])
        reject(new Error(`Unexpected server response: ${statusCode}`))
      }
    }
    clientStream.on('data', onData)

    const req = {
      method: 'GET',
      headers: {
        ...this.#headers,
        'host': 'localhost',
        'connection': 'upgrade',
        'upgrade': 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': SYNTHETIC_SEC_WEBSOCKET_KEY,
      },
      httpVersion: '1.1',
      url: this.#url,
    } satisfies Pick<IncomingMessage, 'method' | 'headers' | 'httpVersion' | 'url'>

    this.#server.emit('upgrade', req, serverStream, EMPTY_HEAD)

    return promise
  }
}
