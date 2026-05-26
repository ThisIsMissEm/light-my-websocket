import type { Server } from 'node:http'
import { WebSocketChainImpl } from './internals.ts'
import type { WebSocketChain, InjectWSOptions } from './internals.ts'

export type { WebSocketChain, InjectWSOptions }

/**
 * Synthetic WebSocket upgrade. Returns a `WebSocketChain` — call `.on(...)`
 * / `.once(...)` to queue listeners, then `await` (or `.connect()`) to
 * trigger the upgrade. The chain replays queued listeners onto the real
 * `WebSocket` BEFORE the handshake completes, so any frames the server
 * sends during the upgrade (e.g. an initial greeting) reach consumer
 * listeners reliably — no race window.
 *
 * The signature follows the platform convention (`new WebSocket(url)`,
 * `fetch(url)`, `new EventSource(url)`) rather than light-my-request's
 * options-bag form, since URL is effectively the only first-class
 * request property for a WebSocket upgrade.
 */
export function injectWS(
  server: Server,
  url: string = '/',
  options: InjectWSOptions = {}
): WebSocketChain {
  return new WebSocketChainImpl(server, url, options)
}
