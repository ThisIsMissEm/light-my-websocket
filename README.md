# light-my-websocket

> Like [`light-my-request`](https://github.com/fastify/light-my-request), but for WebSockets.

Inject synthetic WebSocket upgrades against a Node `http.Server` **without binding to a port**. Useful for testing WebSocket handlers in-process — fast, deterministic, no port collisions.

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

const client = await injectWS(server, '/chat')

client.send('hello')
client.on('message', (data) => {
  console.log(data.toString()) // "echo:hello"
})
```

No `server.listen()` call needed.

## API

### `injectWS(server, url?, options?)`

- `server: http.Server` — the server whose `'upgrade'` listeners should run.
- `url?: string` — request URL path, including any query string. Default `"/"`.
- `options.headers?: Record<string, string>` — extra request headers. `host` defaults to `"localhost"`; `connection`, `upgrade`, `sec-websocket-version`, and `sec-websocket-key` are set automatically.
- `options.onInit?: (ws) => void` — fires **synchronously**, before the upgrade is emitted, with a detached `WebSocket`. Attach `'message'` / `'error'` / `'close'` listeners here so nothing is missed between handshake completion and `open`.
- `options.onOpen?: (ws) => void` — fires when the client `WebSocket`'s `open` event fires.

Returns `Promise<WebSocket>` that resolves once the handshake completes (HTTP 101). Any other status rejects with `Error("Unexpected server response: <code>")`.

The signature follows the platform convention (`new WebSocket(url)`, `fetch(url)`, `new EventSource(url)`) rather than `light-my-request`'s options-bag form, since URL is effectively the only first-class request property for a WebSocket upgrade.

## How it works

`injectWS` builds a cross-wired Duplex pair via `stream.duplexPair()` that looks like the two ends of a TCP socket. It emits `'upgrade'` on the server with a synthetic `IncomingMessage`, so registered upgrade handlers run normally. When the server writes the HTTP 101 response, `injectWS` attaches the duplex to a detached `ws.WebSocket` via the library's internal `setSocket`, completing the client side of the handshake.

## Credits

- [`@fastify/websocket`](https://github.com/fastify/fastify-websocket) — the `injectWS` pattern.
- [`light-my-request`](https://github.com/fastify/light-my-request) — the broader "inject a synthetic request" approach this is modelled on.

## License

MIT
