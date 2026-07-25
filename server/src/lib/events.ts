import { EventEmitter } from 'node:events'

/**
 * In-process event bus feeding the /api/events SSE stream. One server
 * process by design, so no external broker: anything that changes what a
 * screen shows (new order, cancel, kitchen tap, print state) pings every
 * connected client, which then refetches its own view.
 */
export const ordersBus = new EventEmitter()
// One listener per open screen; a busy venue can have a few dozen.
ordersBus.setMaxListeners(200)

export function notifyOrdersChanged(): void {
  ordersBus.emit('orders')
}
