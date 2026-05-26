# light-my-websocket

> Like [`light-my-request`](https://github.com/fastify/light-my-request), but for WebSockets.

Inject synthetic WebSocket upgrades against a Node `http.Server` **without binding to a port**. Useful for testing WebSocket handlers in-process — fast, deterministic, no port collisions, and no listener-attachment race for server-sent handshake frames.

The pattern is taken from [`@fastify/websocket`](https://github.com/fastify/fastify-websocket)'s internal `injectWS` helper, extracted into a standalone, server-framework-agnostic package.

## Install

```sh
pnpm add -D light-my-websocket
```

Requires **Node 22.6+** (uses `node:stream`'s `duplexPair`). `ws` is a peer dependency — you almost certainly already have it via your WebSocket server.

## Usage

```ts
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { injectWS } from 'light-my-websocket'

const server = createServer()
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data}`))
  })
})

const client = await injectWS(server, '/chat').on('message', (data) => {
  console.log(data.toString()) // "echo:hello"
})

client.send('hello')
```

No `server.listen()` call needed.

### Why chain `.on()` before `await`?

`injectWS(...)` returns a **`WebSocketChain`** — a thenable builder. Listener registrations chained on the builder are attached to the real `WebSocket` **before** the synthetic handshake runs, so frames the server sends during the upgrade reach the consumer reliably.

A naive `await injectWS(...)` followed by `client.on('message', ...)` would race: the duplex pair carrying the synthetic socket may have already delivered the first frames by the time the post-`await` code runs, and a freshly-attached listener would miss them. The chain closes that window — it's the library's headline correctness guarantee.

```ts
// ✅ Listeners attached before handshake — frames during upgrade are caught.
const client = await injectWS(server, '/').on('message', handle)

// ⚠ Listener attached after handshake. Fine for echo / request-response
//   patterns where the server only sends in response to a client send.
//   Risky if the server sends anything immediately on connect.
const client = await injectWS(server, '/')
client.on('message', handle)
```

The chain's `.on` / `.once` / `.addListener` mirror `ws.WebSocket`'s typed event overloads, so `data` is correctly typed as `Buffer` (or whatever the event's listener signature specifies) without an extra cast.

### Interactive patterns

The connected `WebSocket` is a real `ws.WebSocket`, so post-`await` it behaves like any other WS client. Combined with Node's built-in `events.once` and `events.on`, you can write linear test flows:

```ts
import { once } from 'node:events'

const log: string[] = []
const client = await injectWS(server, '/chat').on('message', (data) => log.push(data.toString()))

client.send('hello')
const [first] = await once(client, 'message')
client.send('thanks')
```

## API

### `injectWS(server, url?, options?)`

- `server: http.Server` — the server whose `'upgrade'` listeners should run.
- `url?: string` — request URL path, including any query string. Default `"/"`.
- `options.headers?: Record<string, string>` — extra request headers. `host` defaults to `"localhost"`; `connection`, `upgrade`, `sec-websocket-version`, and `sec-websocket-key` are set automatically.

Returns a **`WebSocketChain`**.

### `WebSocketChain`

A thenable builder. Listener-registration methods queue on the chain and are replayed onto the real `WebSocket` immediately before the handshake completes — eliminating the race between handshake completion and consumer listener attachment.

Listener-attachment methods (each returns `this` for chaining):

- `.on(event, listener)` — typed overloads mirror `ws.WebSocket.on`.
- `.once(event, listener)` — typed overloads mirror `ws.WebSocket.once`.
- `.addListener(event, listener)` — typed overloads mirror `ws.WebSocket.addListener` (no `this: WebSocket` binding).
- `.prependListener(event, listener)` — generic EventEmitter signature.
- `.prependOnceListener(event, listener)` — generic EventEmitter signature.

Trigger / promise surface:

- `.connect() → Promise<WebSocket>` — explicit trigger; idempotent. Most consumers `await` the chain instead.
- `.then(onFulfilled, onRejected) → Promise<…>` — awaiting the chain calls `.connect()` and resolves with the connected `WebSocket`.
- `.catch(onRejected) → Promise<…>` — sugar over `.connect().catch(...)`.
- `.finally(onFinally) → Promise<WebSocket>` — sugar over `.connect().finally(...)`.

DOM-style `addEventListener` is not exposed on the chain — call it on the connected `WebSocket` after `await`. `.off()` / `.removeListener()` are also not on the chain (it's append-only); detach on the connected `WebSocket` if needed.

A non-101 response rejects the underlying promise with `Error("Unexpected server response: <code>")`.

## How it works

`injectWS` builds a cross-wired Duplex pair via `stream.duplexPair()` that looks like the two ends of a TCP socket. When the chain is triggered (via `await` or `.connect()`), it constructs a detached `ws.WebSocket`, applies the queued listeners, then emits `'upgrade'` on the server. The server's registered upgrade handlers run as they would for a real upgrade. When the server writes the HTTP 101 response, the chain attaches the duplex to the detached `WebSocket` via the library's internal `setSocket`, completing the client side of the handshake.

The timing subtlety the chain protects against: RFC 6455 permits the server to begin sending data frames immediately after the 101 response — there's no quiet period. In the synthetic transport, the server's `handleUpgrade` callback runs synchronously inside `server.emit('upgrade', …)`, so any `ws.send(...)` it makes lands in the duplex before the client side has parsed the 101. Listeners pre-attached via the chain (before `setSocket`) catch the resulting `'message'` emits; listeners attached after `await` (i.e. after `'open'`) may miss them.

## Credits

- [`@fastify/websocket`](https://github.com/fastify/fastify-websocket) — the `injectWS` pattern.
- [`light-my-request`](https://github.com/fastify/light-my-request) — the broader "inject a synthetic request" approach this is modelled on, including the thenable-builder pattern.

## License

MIT
