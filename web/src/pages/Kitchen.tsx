import { useEffect, useState } from 'react'
import { api, type KitchenItem, type KitchenOrder } from '../api'
import { useI18n } from '../i18n'
import { useOrdersEvents } from '../useOrdersEvents'

function minutesSince(ts: number): number {
  return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60))
}

type TodoGroup = { category: string; items: { name: string; qty: number }[] }

/**
 * The workbench view: everything still to prepare, summed per product and
 * grouped by category ("10× Bistecca"), so each station knows its numbers
 * at a glance. Derived purely from the orders already on screen.
 */
function buildTodo(orders: KitchenOrder[]): TodoGroup[] {
  const groups: TodoGroup[] = []
  for (const o of orders) {
    if (o.cancelledAt !== null) continue
    for (const i of o.items) {
      if (i.doneAt !== null || i.cancelledAt !== null) continue
      let g = groups.find((x) => x.category === i.category)
      if (!g) {
        g = { category: i.category, items: [] }
        groups.push(g)
      }
      const item = g.items.find((x) => x.name === i.name)
      if (item) item.qty += i.qty
      else g.items.push({ name: i.name, qty: i.qty })
    }
  }
  // Biggest workload first within each station.
  for (const g of groups) g.items.sort((a, b) => b.qty - a.qty)
  return groups
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
          <strong>
            {order.customerName}
            {(order.paymentMethod === 'stripe' || order.paymentMethod === 'paypal') && (
              <span className="badge ok" style={{ marginLeft: 6 }}>
                {t('prepaidBadge')}
              </span>
            )}
          </strong>
          <span>
            {new Date(order.createdAt * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' · '}
            {age} min
            {order.covers > 0 ? ` · ${order.covers} ${t('covers').toLowerCase()}` : ''}
            {' · '}
            {order.createdByName ?? t('customerBadge')}
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
  // The workbench bar is collapsible; each tablet remembers its choice.
  const [todoOpen, setTodoOpen] = useState(() => localStorage.getItem('fd_kds_todo') !== 'closed')

  function toggleTodo() {
    setTodoOpen((open) => {
      localStorage.setItem('fd_kds_todo', open ? 'closed' : 'open')
      return !open
    })
  }

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

  const todo = buildTodo(orders)

  return (
    <>
      {error && <div className="error">{error}</div>}

      {/* On wide screens the workbench summary sits in a left sidebar
          (issue #25); on narrow ones it stays as a bar above the grid. */}
      <div className="kds-layout">
        {todo.length > 0 && (
          <div className={`kds-todo ${todoOpen ? '' : 'closed'}`}>
            <button className="kds-todo-toggle" onClick={toggleTodo}>
              {t('kdsTodo')} ·{' '}
              {todo.reduce((n, g) => n + g.items.reduce((m, i) => m + i.qty, 0), 0)}{' '}
              {todoOpen ? '▾' : '▸'}
            </button>
            {todoOpen &&
              todo.map((g) => (
                <div className="kds-todo-group" key={g.category}>
                  <div className="kds-todo-cat">{g.category}</div>
                  <div className="kds-todo-items">
                    {g.items.map((i) => (
                      <span className="kds-todo-item" key={i.name}>
                        <span className="kds-todo-qty">{i.qty}×</span> {i.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        <div className="kds-main">
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
        </div>
      </div>
    </>
  )
}
