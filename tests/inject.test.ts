import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { injectWS } from '../src/index.ts'

function buildServer(
  t: TestContext,
  onConnection?: (ws: WebSocket) => void
): { server: Server; wss: WebSocketServer } {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => onConnection?.(ws))
  })
  t.after(() => wss.close())
  return { server, wss }
}

test('successful upgrade round-trips a message', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
  })

  const client = await injectWS(server, '/')
  t.after(() => client.close())

  const received = new Promise<string>((resolve) => {
    client.once('message', (data) => resolve(data.toString()))
  })

  client.send('hello')

  assert.equal(await received, 'echo:hello')
})

test('non-101 response rejects with the status code', async () => {
  const server = createServer()
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.end()
  })

  await assert.rejects(injectWS(server), /Unexpected server response: 401/u)
})

test('onInit fires before onOpen with the same WebSocket instance', async (t) => {
  const { server } = buildServer(t)

  const order: string[] = []
  let initWS: WebSocket | undefined
  let openWS: WebSocket | undefined

  const client = await injectWS(server, '/', {
    onInit: (ws) => {
      order.push('init')
      initWS = ws
    },
    onOpen: (ws) => {
      order.push('open')
      openWS = ws
    },
  })
  t.after(() => client.close())

  assert.deepEqual(order, ['init', 'open'])
  assert.equal(initWS, openWS)
  assert.equal(client, openWS)
})

test('onInit can attach listeners before the handshake completes', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.send('hello-on-open')
  })

  let received: string | undefined
  const client = await injectWS(server, '/', {
    onInit: (ws) => {
      ws.on('message', (data) => {
        received = data.toString()
      })
    },
  })
  t.after(() => client.close())

  await new Promise((r) => setImmediate(r))

  assert.equal(received, 'hello-on-open')
})

test('URL with query string reaches the server', async (t) => {
  // Query string is how browser WebSocket clients pass per-request data
  // (auth tokens, room IDs, etc.) — browsers cannot set custom headers
  // on a WebSocket handshake.
  let seenUrl: string | undefined

  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seenUrl = req.url
    wss.handleUpgrade(req, socket, head, () => {})
  })
  t.after(() => {
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  const client = await injectWS(server, '/chat?token=abc&room=42')
  t.after(() => client.close())

  assert.equal(seenUrl, '/chat?token=abc&room=42')
})

test('custom headers pass through (Node-only — browsers cannot set these)', async (t) => {
  // Arbitrary request headers on the WS upgrade are a Node-side feature.
  // The browser WebSocket API does not expose any way to set them, so
  // production code that relies on them is not portable. Useful for
  // testing server-side handlers that read non-standard headers.
  let seenTrace: string | string[] | undefined

  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seenTrace = req.headers['x-trace-id']
    wss.handleUpgrade(req, socket, head, () => {})
  })
  t.after(() => {
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  const client = await injectWS(server, '/', {
    headers: { 'x-trace-id': 'abc-123' },
  })
  t.after(() => client.close())

  assert.equal(seenTrace, 'abc-123')
})
