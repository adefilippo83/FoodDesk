import { useEffect, useState } from 'react'
import { ApiError, api, formatMoney, type OrderDetail, type OrderSummary } from '../api'
import { useAuth } from '../auth'

function PrintStatus({ order }: { order: OrderSummary }) {
  if (order.printedAt) return <span className="badge ok">printed</span>
  if (order.printError === 'printer_not_configured')
    return (
      <span className="badge" title="No kitchen printer is configured on the server">
        no printer
      </span>
    )
  if (order.printError)
    return (
      <span className="badge fail" title={order.printError}>
        failed
      </span>
    )
  return <span className="badge">…</span>
}

export default function Orders() {
  const { user } = useAuth()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [serviceDay, setServiceDay] = useState('')
  const [open, setOpen] = useState<OrderDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reprinting, setReprinting] = useState<number | null>(null)

  async function reprint(id: number) {
    setReprinting(id)
    try {
      await api.reprint(id)
      setError(null)
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'printer_not_configured'
          ? 'No kitchen printer is configured on the server — open the kitchen PDF and print it from the browser instead.'
          : 'Reprint failed — check the kitchen printer.',
      )
    } finally {
      setReprinting(null)
      await load()
    }
  }

  async function load() {
    try {
      const res = await api.orders()
      setOrders(res.orders)
      setServiceDay(res.serviceDay)
      setError(null)
    } catch {
      setError('Could not load orders.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // Someone else's order should appear without a manual refresh.
    const t = setInterval(() => void load(), 15000)
    return () => clearInterval(t)
  }, [])

  const dayTotal = orders.reduce((sum, o) => sum + o.totalCents, 0)

  if (loading) return <div className="empty">Loading…</div>

  return (
    <>
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Orders</h1>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {serviceDay} · {orders.length} order{orders.length === 1 ? '' : 's'} · €
          {formatMoney(dayTotal)}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {user?.role !== 'admin' && (
        <p className="muted" style={{ marginTop: 0 }}>
          Showing the orders you took today.
        </p>
      )}

      {orders.length === 0 ? (
        <div className="empty">No orders yet today.</div>
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Table</th>
                <th>Waiter</th>
                <th>Time</th>
                <th className="num">Total</th>
                <th>Kitchen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{String(o.dailyNumber).padStart(3, '0')}</strong>
                  </td>
                  <td>{o.tableLabel ?? <span className="muted">—</span>}</td>
                  <td>{o.createdByName}</td>
                  <td className="muted">
                    {new Date(o.createdAt * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="num">€{formatMoney(o.totalCents)}</td>
                  <td>
                    <PrintStatus order={o} />
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn small"
                      onClick={() => void api.order(o.id).then(setOpen)}
                    >
                      View
                    </button>{' '}
                    <a
                      className="btn small"
                      href={api.receiptUrl(o.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Receipt
                    </a>{' '}
                    <button
                      className="btn small"
                      disabled={reprinting === o.id}
                      onClick={() => void reprint(o.id)}
                    >
                      {reprinting === o.id ? 'Printing…' : o.printedAt ? 'Reprint' : 'Print'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.6)',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => setOpen(null)}
        >
          <div
            className="card"
            style={{ width: '100%', maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              Order #{String(open.dailyNumber).padStart(3, '0')}
              {open.tableLabel ? ` · Table ${open.tableLabel}` : ''}
            </h2>
            <div className="table-scroll">
              <table>
                <tbody>
                  {open.items.map((i) => (
                    <tr key={i.id}>
                      <td className="num" style={{ width: 40 }}>
                        {i.qty}×
                      </td>
                      <td>
                        {i.nameSnapshot}
                        {i.note && <div className="muted" style={{ fontSize: 13 }}>{i.note}</div>}
                      </td>
                      <td className="num">€{formatMoney(i.priceCentsSnapshot * i.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {open.note && (
              <p className="muted" style={{ marginBottom: 0 }}>
                Note: {open.note}
              </p>
            )}
            <div className="cart-total">
              <span>Total</span>
              <span className="amount">€{formatMoney(open.totalCents)}</span>
            </div>
            <div className="row">
              <a
                className="btn"
                style={{ flex: 1 }}
                href={api.receiptUrl(open.id)}
                target="_blank"
                rel="noreferrer"
              >
                Receipt PDF
              </a>
              <a
                className="btn"
                style={{ flex: 1 }}
                href={api.kitchenPdfUrl(open.id)}
                target="_blank"
                rel="noreferrer"
              >
                Kitchen PDF
              </a>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
