---
'light-my-websocket': minor
---

Refactor `injectWS` to return a thenable `WebSocketChain`. Listener
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
