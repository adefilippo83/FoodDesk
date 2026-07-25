import { useEffect, useState } from 'react'
import { api, type KitchenItem, type KitchenOrder } from '../api'
import { useI18n } from '../i18n'

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
  const done = order.items.length > 0 && order.items.every((i) => i.doneAt !== null)
  const age = minutesSince(order.createdAt)

  return (
    <div className={`kds-card ${done ? 'done' : ''} ${!done && age >= 15 ? 'late' : ''}`}>
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
            className={`kds-item ${i.doneAt !== null ? 'done' : ''}`}
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
    // A display, not a page someone refreshes: new orders must just appear.
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const open = orders.filter((o) => o.items.some((i) => i.doneAt === null))
  const completed = orders.filter(
    (o) => o.items.length > 0 && o.items.every((i) => i.doneAt !== null),
  )

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
