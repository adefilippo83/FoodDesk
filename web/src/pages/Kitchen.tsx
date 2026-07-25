import { useEffect, useState } from 'react'
import { api, type KitchenItem, type KitchenOrder } from '../api'
import { useI18n } from '../i18n'
import { useOrdersEvents } from '../useOrdersEvents'

function minutesSince(ts: number): number {
  return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60))
}

function OrderCard({
  order,
  onToggle,
}: {
  order: KitchenOrder
  onToggle: (orderId: number, item: KitchenItem) => void
}) {
  const { t } = useI18n()
  const active = order.items.filter((i) => i.cancelledAt === null)
  const done = active.length > 0 && active.every((i) => i.doneAt !== null)
  const cancelled = order.cancelledAt !== null
  const age = minutesSince(order.createdAt)

  return (
    <div
      className={`kds-card ${cancelled ? 'cancelled' : done ? 'done' : age >= 15 ? 'late' : ''}`}
    >
      {cancelled && <div className="kds-cancelled">{t('cancelledBadge')}</div>}
      <div className="kds-head">
        <span className="kds-num">#{String(order.dailyNumber).padStart(3, '0')}</span>
        <div className="kds-meta">
          <strong>{order.customerName}</strong>
          <span>
            {new Date(order.createdAt * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' · '}
            {age} min
            {order.covers > 0 ? ` · ${order.covers} ${t('covers').toLowerCase()}` : ''}
            {' · '}
            {order.createdByName}
          </span>
        </div>
      </div>
      {order.note && <div className="kds-note">» {order.note}</div>}
      <div>
        {order.items.map((i) => (
          <button
            key={i.id}
            className={`kds-item ${
              i.cancelledAt !== null ? 'cancelled' : i.doneAt !== null ? 'done' : ''
            }`}
            disabled={cancelled || i.cancelledAt !== null}
            onClick={() => onToggle(order.id, i)}
          >
            <span className="kds-qty">{i.qty}×</span>
            <span className="kds-name">
              {i.name}
              {i.note && <span className="kds-item-note">» {i.note}</span>}
            </span>
            <span className="kds-check">{i.doneAt !== null ? '✓' : ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function Kitchen() {
  const { t } = useI18n()
  const [orders, setOrders] = useState<KitchenOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await api.kitchenOrders()
      setOrders(res.orders)
      setError(null)
    } catch {
      setError(t('errLoadOrders'))
    }
  }

  useEffect(() => {
    void load()
    // SSE pushes new orders instantly; this slow poll is only the safety net.
    const timer = setInterval(() => void load(), 30000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useOrdersEvents(() => void load())

  // Keep the tablet screen awake for the whole service. The lock is released
  // by the browser whenever the tab is hidden, so re-acquire on return.
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let disposed = false
    const acquire = async () => {
      try {
        if (!disposed && document.visibilityState === 'visible') {
          lock = await navigator.wakeLock.request('screen')
        }
      } catch {
        // Not critical — the tablet's own display settings still apply.
      }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release().catch(() => {})
    }
  }, [])

  function toggle(orderId: number, item: KitchenItem) {
    const done = item.doneAt === null
    // Optimistic: the cook sees the tap land instantly; the poll reconciles.
    setOrders(
      (prev) =>
        prev?.map((o) =>
          o.id !== orderId
            ? o
            : {
                ...o,
                items: o.items.map((i) =>
                  i.id === item.id
                    ? { ...i, doneAt: done ? Math.floor(Date.now() / 1000) : null }
                    : i,
                ),
              },
        ) ?? prev,
    )
    api.setItemDone(item.id, done).catch(() => {
      setError(t('kdsErrUpdate'))
      void load()
    })
  }

  if (orders === null) return <div className="empty">{t('loading')}</div>

  // Cancelled orders stay in the main grid, marked, so the kitchen notices.
  // Cancelled lines never count toward an order's completion.
  const open = orders.filter(
    (o) =>
      o.cancelledAt !== null ||
      o.items.some((i) => i.doneAt === null && i.cancelledAt === null),
  )
  const completed = orders.filter((o) => {
    if (o.cancelledAt !== null) return false
    const active = o.items.filter((i) => i.cancelledAt === null)
    return active.length > 0 && active.every((i) => i.doneAt !== null)
  })

  return (
    <>
      {error && <div className="error">{error}</div>}

      {open.length === 0 ? (
        <div className="empty">{t('kdsNoOrders')}</div>
      ) : (
        <div className="kds-grid">
          {open.map((o) => (
            <OrderCard key={o.id} order={o} onToggle={toggle} />
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <>
          <h2 className="kds-section">
            {t('kdsCompleted')} · {completed.length}
          </h2>
          <div className="kds-grid">
            {completed.map((o) => (
              <OrderCard key={o.id} order={o} onToggle={toggle} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
