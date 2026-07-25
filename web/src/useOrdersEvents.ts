import { useEffect, useRef } from 'react'

/**
 * Subscribes to the server's /api/events stream and calls back whenever
 * orders change, so screens refresh instantly instead of waiting for their
 * polling interval. EventSource reconnects by itself; the callers keep a
 * slow poll as the safety net for anything the stream misses.
 */
export function useOrdersEvents(onChange: () => void): void {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  })

  useEffect(() => {
    const es = new EventSource('/api/events')
    const handler = () => cb.current()
    es.addEventListener('orders', handler)
    return () => es.close()
  }, [])
}
