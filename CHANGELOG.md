# light-my-websocket

## 0.1.0

### Minor Changes

- [#6](https://github.com/ThisIsMissEm/light-my-websocket/pull/6) [`08126ea`](https://github.com/ThisIsMissEm/light-my-websocket/commit/08126ead368c95dbfd7863f97805e850cb64188e) Thanks [@ThisIsMissEm](https://github.com/ThisIsMissEm)! - Add `.toIterable()` to `WebSocketChain` for race-safe async iteration over
  incoming messages. Queues `'message'` / `'close'` / `'error'` listeners
  through the chain (same pre-handshake guarantee as `.on(...)`), terminates
  on close, throws on error. Iteration triggers `.connect()` if it hasn't
  been called already.

  The optional `transform` argument runs per chunk:

  ```ts
  for await (const frame of chain.toIterable(decodeFrame)) {
    // frame is the decoded type
    if (done(frame)) break
  }
  ```

  Replaces ~30 lines of hand-rolled queue/waiter machinery in consumers that
  need to iterate over a streaming subscription (the atproto event-stream
  test helper is the driving use case). The async generator detaches its
  listeners on early `break` / `throw` via a `finally` block, so consumers
  don't leave dangling listeners on the live WebSocket.

- [#6](https://github.com/ThisIsMissEm/light-my-websocket/pull/6) [`da776c6`](https://github.com/ThisIsMissEm/light-my-websocket/commit/da776c6a53efd0dc46dfeb180182cfbcf42b85fe) Thanks [@ThisIsMissEm](https://github.com/ThisIsMissEm)! - Refactor `injectWS` to return a thenable `WebSocketChain`. Listener
  registrations (`.on` / `.once` / `.addListener` / `.prependListener` /
  `.prependOnceListener`) queue on the chain and are replayed onto the real
  `WebSocket` before the handshake completes, closing the race window where
  server-sent frames during the upgrade could be missed by listeners attached
  after `await injectWS(...)`. RFC 6455 permits the server to send data frames
  immediately after the 101 response with no quiet period, so this race is a
  real spec-permitted condition — not a Node-specific quirk.

  The `onInit` and `onOpen` callback options have been removed — they were
  workarounds for the race the chain now solves at the API level.

  The chain's listener-attachment methods mirror `ws.WebSocket`'s typed event
  overloads, so consumers get the same listener-argument typing (`data: Buffer`,
  etc.) as they would on the live socket. `.catch` and `.finally` round out
  the thenable surface alongside `.then`.

  **Migration:**

  ```ts
  // Before
  const ws = await injectWS(server, '/chat', {
    onInit: (ws) => ws.on('message', handle),
  })

  // After
  const ws = await injectWS(server, '/chat').on('message', handle)
  ```

  `const ws = await injectWS(...)` keeps working unchanged for consumers who
  weren't using `onInit` / `onOpen`. `WebSocketChain` is now exposed as a type
  (interface), not a class — `instanceof WebSocketChain` checks need to be
  replaced with duck-typing (`typeof chain.connect === 'function'`).

## 0.0.3

### Patch Changes

- [`00bf6aa`](https://github.com/ThisIsMissEm/light-my-websocket/commit/00bf6aa770e9cf029d95e0df06b9e6a884738b0d) Thanks [@ThisIsMissEm](https://github.com/ThisIsMissEm)! - Fix release generation

## 0.0.2

### Patch Changes

- [`11e0ef3`](https://github.com/ThisIsMissEm/light-my-websocket/commit/11e0ef35c76a46decd616db1078aa8f8ac37f998) Thanks [@ThisIsMissEm](https://github.com/ThisIsMissEm)! - Switch to staged publishing and fixing provenance errors

## 0.0.1

### Patch Changes

- [`2ccfbde`](https://github.com/ThisIsMissEm/light-my-websocket/commit/2ccfbdedb1ed355ea45344a46b02a209b16e4499) Thanks [@ThisIsMissEm](https://github.com/ThisIsMissEm)! - Initial implementation of light-my-websocket
