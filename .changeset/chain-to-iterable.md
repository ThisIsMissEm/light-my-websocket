---
'light-my-websocket': minor
---

Add `.toIterable()` to `WebSocketChain` for race-safe async iteration over
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
