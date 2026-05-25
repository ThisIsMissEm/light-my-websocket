import { duplexPair, type Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import type { Server, IncomingMessage } from 'node:http'

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

export interface InjectWSOptions {
  /** Extra request headers. `host` defaults to 'localhost'. */
  headers?: Record<string, string>
  /** Lifecycle hook fired before the client WebSocket opens. */
  onInit?: (ws: WebSocket) => void
  onOpen?: (ws: WebSocket) => void
}

const statusCodeReg = /HTTP\/1.1 (\d+)/u

/**
 * Synthetic WebSocket upgrade. Emits 'upgrade' on `server` with a fake
 * IncomingMessage + a cross-wired Duplex pair standing in for the TCP
 * socket. The server's registered 'upgrade' listener(s) run as they
 * would for a real upgrade. The returned `ws.WebSocket` is wired to the
 * client end of the pair.
 *
 * Modelled after fastify-websocket's internal injectWS, with a signature
 * shaped after the platform `WebSocket` / `fetch` / `EventSource`
 * constructors: URL as positional, options as a trailing bag.
 */
export function injectWS(
  server: Server,
  url: string = '/',
  options: InjectWSOptions = {}
): Promise<WebSocket> {
  const [serverStream, clientStream] = duplexPair()
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>()

  const head = Buffer.alloc(0)
  const ws = new DetachedWebSocket(null, undefined, { autoPong: true })
  const internalWs = ws as WebSocketInternal

  // RFC 6455 frame masking: client→server frames MUST be masked,
  // server→client MUST NOT. The null-address constructor hardcodes
  // `_isServer = true`; flip it so the returned `ws` behaves as a
  // client (masks outgoing, expects unmasked incoming).
  internalWs._isServer = false

  typeof options.onInit === 'function' && options.onInit(ws)

  ws.on('open', () => {
    typeof options.onOpen === 'function' && options.onOpen(ws)
    resolve(ws)
  })

  const onData = (chunk: Buffer) => {
    // Detach before setSocket so we don't see post-handshake frames here.
    clientStream.removeListener('data', onData)

    const text = chunk.toString()
    if (text.includes('HTTP/1.1 101 Switching Protocols')) {
      internalWs.setSocket(clientStream, head, {
        maxPayload: 0,
      })
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
      ...options.headers,
      'host': 'localhost',
      'connection': 'upgrade',
      'upgrade': 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'),
    },
    httpVersion: '1.1',
    url,
  } satisfies Pick<IncomingMessage, 'method' | 'headers' | 'httpVersion' | 'url'>

  server.emit('upgrade', req, serverStream, head)
  return promise
}
