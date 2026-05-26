import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
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
  t.after(() => {
    for (const c of wss.clients) c.terminate()
    wss.close()
  })
  return { server, wss }
}

function buildRawServer(_t: TestContext, statusLine: string): Server {
  // For non-101 tests: write the status line and end. No WSS attached;
  // injectWS rejects from the regex check, never resolves.
  const server = createServer()
  server.on('upgrade', (_req, socket) => {
    socket.write(`${statusLine}\r\n\r\n`)
    socket.end()
  })
  return server
}

test('await injectWS returns a connected WebSocket', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
  })

  const client = await injectWS(server, '/')
  t.after(() => client.close())

  client.send('hello')
  const [received] = (await once(client, 'message')) as [Buffer]

  assert.equal(received.toString(), 'echo:hello')
})

test('non-101 response rejects with the status code', async (t) => {
  const server = buildRawServer(t, 'HTTP/1.1 401 Unauthorized')
  await assert.rejects(injectWS(server).connect(), /Unexpected server response: 401/u)
})

test('chain.on() catches frames sent during the handshake (no race)', async (t) => {
  // The whole reason the chain exists: a `client.on('message', ...)`
  // registered AFTER `await injectWS(...)` may miss frames the server
  // sent synchronously inside its upgrade handler. Queueing via the
  // chain attaches the listener BEFORE setSocket, so the parser's
  // first emit lands in the consumer's callback.
  const { server } = buildServer(t, (ws) => {
    ws.send('first')
    ws.send('second')
    ws.close()
  })

  const received: string[] = []
  const drained = new Promise<void>((resolve) => {
    injectWS(server)
      .on('message', (data) => {
        received.push((data as Buffer).toString())
      })
      .on('close', () => resolve())
      .connect()
  })
  await drained

  assert.deepEqual(received, ['first', 'second'])
})

test('chain methods are fluent (return the chain)', (t) => {
  const { server } = buildServer(t)
  const chain = injectWS(server)
  const methods = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const
  for (const m of methods) {
    assert.equal(
      chain[m]('message', () => {}),
      chain,
      `${m} should return the chain`
    )
  }
})

test('connect() is idempotent — multiple calls return the same Promise', async (t) => {
  const { server } = buildServer(t)
  const chain = injectWS(server)
  const p1 = chain.connect()
  const p2 = chain.connect()
  assert.equal(p1, p2)
  const ws = await p1
  t.after(() => ws.close())
})

test('awaiting the chain twice resolves to the same WebSocket', async (t) => {
  const { server } = buildServer(t)
  const chain = injectWS(server)
  const ws1 = await chain
  const ws2 = await chain
  assert.equal(ws1, ws2)
  t.after(() => ws1.close())
})

test('chain.once() listener fires exactly once', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.send('first')
    ws.send('second')
    setImmediate(() => ws.close())
  })

  let calls = 0
  const closed = new Promise<void>((resolve) => {
    injectWS(server)
      .once('message', () => calls++)
      .on('close', () => resolve())
      .connect()
  })
  await closed

  assert.equal(calls, 1)
})

test('chain.catch() handles rejection from a non-101 response', async (t) => {
  const server = buildRawServer(t, 'HTTP/1.1 403 Forbidden')

  let caught: unknown
  await injectWS(server).catch((err) => {
    caught = err
  })

  assert.match((caught as Error).message, /Unexpected server response: 403/u)
})

test('chain.toIterable() yields message buffers and ends on close', async (t) => {
  // Same race the `chain.on() catches frames` test covers, expressed via
  // iteration. The whole point of routing through the chain: handshake-time
  // frames land in the queue and survive to the for-await consumer.
  const { server } = buildServer(t, (ws) => {
    ws.send('first')
    ws.send('second')
    ws.close()
  })

  const received: string[] = []
  for await (const chunk of injectWS(server).toIterable()) {
    received.push(chunk.toString())
  }

  assert.deepEqual(received, ['first', 'second'])
})

test('chain.toIterable(transform) yields transformed values', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.send('1')
    ws.send('2')
    ws.send('3')
    ws.close()
  })

  const numbers: number[] = []
  for await (const n of injectWS(server).toIterable((chunk) => Number(chunk.toString()))) {
    numbers.push(n)
  }

  assert.deepEqual(numbers, [1, 2, 3])
})

test('chain.toIterable(transform) supports async transforms', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.send('hello')
    ws.send('world')
    ws.close()
  })

  const out: string[] = []
  for await (const s of injectWS(server).toIterable(async (chunk) => {
    await new Promise((r) => setImmediate(r))
    return chunk.toString().toUpperCase()
  })) {
    out.push(s)
  }

  assert.deepEqual(out, ['HELLO', 'WORLD'])
})

test('chain.toIterable() allows early break', async (t) => {
  const { server } = buildServer(t, (ws) => {
    ws.send('1')
    ws.send('2')
    ws.send('3')
    setImmediate(() => ws.close())
  })

  const collected: string[] = []
  for await (const chunk of injectWS(server).toIterable()) {
    collected.push(chunk.toString())
    if (collected.length === 2) break
  }

  assert.deepEqual(collected, ['1', '2'])
})

test('chain.finally() runs on success', async (t) => {
  const { server } = buildServer(t)
  let ran = false
  const ws = await injectWS(server).finally(() => {
    ran = true
  })
  t.after(() => ws.close())
  assert.equal(ran, true)
})

test('URL with query string reaches the server', async (t) => {
  // Query string is how browser WebSocket clients pass per-request data
  // (auth tokens, room IDs, etc.) — browsers cannot set custom headers
  // on a WebSocket handshake.
  let seenUrl: string | undefined
  const { server } = buildServer(t)
  server.on('upgrade', (req) => {
    seenUrl = req.url
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
  const { server } = buildServer(t)
  server.on('upgrade', (req) => {
    seenTrace = req.headers['x-trace-id']
  })

  const client = await injectWS(server, '/', {
    headers: { 'x-trace-id': 'abc-123' },
  })
  t.after(() => client.close())

  assert.equal(seenTrace, 'abc-123')
})
