import type { FastifyReply, FastifyRequest } from 'fastify'
import { ordersBus } from './events.js'

/**
 * A server-sent-events stream carrying a bare "orders" ping whenever anything
 * about an order changes, so screens refetch immediately instead of leaning on
 * their polling loop. The payload is deliberately empty: the stream says
 * "something moved", the client's own authorized fetch says what.
 *
 * Both the staff stream and the customer's token-scoped one are the same
 * plumbing; only who may open it, and how many, differs.
 */
export function openOrdersStream(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { maxLifetimeMs?: number; onClose?: () => void } = {},
): { close: () => void } {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    // Tells nginx not to buffer this response.
    'x-accel-buffering': 'no',
  })
  raw.write('retry: 3000\n\n')

  const onOrders = () => raw.write('event: orders\ndata: {}\n\n')
  ordersBus.on('orders', onOrders)
  // Comment frames keep idle proxies from timing the stream out.
  const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), 25_000)
  heartbeat.unref()

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    if (lifetime) clearTimeout(lifetime)
    ordersBus.off('orders', onOrders)
    opts.onClose?.()
    raw.end()
  }

  const lifetime = opts.maxLifetimeMs
    ? setTimeout(close, opts.maxLifetimeMs).unref()
    : undefined

  req.raw.on('close', close)
  return { close }
}
