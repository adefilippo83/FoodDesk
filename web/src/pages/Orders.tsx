import { useEffect, useState } from 'react'
import { ApiError, api, formatMoney, type OrderDetail, type OrderSummary } from '../api'
import { useAuth } from '../auth'
import { useI18n } from '../i18n'
import { useOrdersEvents } from '../useOrdersEvents'

function PrintStatus({ order }: { order: OrderSummary }) {
  const { t } = useI18n()
  if (order.printedAt) return <span className="badge ok">{t('badgePrinted')}</span>
  if (order.printError === 'printer_not_configured')
    return (
      <span className="badge" title={t('noPrinterTitle')}>
        {t('badgeNoPrinter')}
      </span>
    )
  if (order.printError)
    return (
      <span className="badge fail" title={order.printError}>
        {t('badgeFailed')}
      </span>
    )
  return <span className="badge">…</span>
}

export default function Orders() {
  const { user } = useAuth()
  const { t } = useI18n()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [serviceDay, setServiceDay] = useState('')
  const [open, setOpen] = useState<OrderDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reprinting, setReprinting] = useState<number | null>(null)
  const [marking, setMarking] = useState<number | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState<number | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [confirmingItemCancel, setConfirmingItemCancel] = useState<number | null>(null)

  async function reprint(id: number) {
    setReprinting(id)
    try {
      await api.reprint(id)
      setError(null)
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'printer_not_configured'
          ? t('errNoPrinter')
          : t('errReprintFailed'),
      )
    } finally {
      setReprinting(null)
      await load()
    }
  }

  async function cancelItem(orderId: number, itemId: number) {
    try {
      await api.cancelOrderItem(orderId, itemId)
      setError(null)
      // Re-fetch: the total changed, and the whole order may have cancelled.
      setOpen(await api.order(orderId))
    } catch {
      setError(t('errCancelItem'))
    } finally {
      setConfirmingItemCancel(null)
      await load()
    }
  }

  async function changeItemQty(orderId: number, itemId: number, qty: number) {
    try {
      await api.updateOrderItemQty(orderId, itemId, qty)
      setError(null)
      setOpen(await api.order(orderId))
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'out_of_stock'
          ? t('errOutOfStock')
          : t('errChangeQty'),
      )
    } finally {
      await load()
    }
  }

  async function cancelOrder(id: number) {
    setCancelling(true)
    try {
      const res = await api.cancelOrder(id)
      // A cancelled online-paid order refunds automatically; if the refund
      // call failed, the money needs a human — say so loudly.
      setError(res.refundFailed ? t('errRefundFailed') : null)
    } catch {
      setError(t('errCancelOrder'))
    } finally {
      setCancelling(false)
      setConfirmingCancel(null)
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
      setError(t('errLoadOrders'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // SSE brings changes instantly; this slow poll is only the safety net.
    const timer = setInterval(() => void load(), 60000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function markPaid(id: number) {
    setMarking(id)
    try {
      await api.markPaid(id)
      await load()
    } catch {
      setError(t('errMarkPaid'))
    } finally {
      setMarking(null)
    }
  }

  useOrdersEvents(() => void load())

  // Held payments are provisional: on screen, but not in the day's money.
  const settled = orders.filter((o) => !o.held)
  const dayTotal = settled.reduce((sum, o) => sum + o.totalCents, 0)

  if (loading) return <div className="empty">{t('loading')}</div>

  return (
    <>
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{t('ordersTitle')}</h1>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {serviceDay} · {settled.length}{' '}
          {settled.length === 1 ? t('orderSingular') : t('orderPlural')} · €{formatMoney(dayTotal)}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {user?.role === 'operator' && (
        <p className="muted" style={{ marginTop: 0 }}>
          {t('showingOwnOrders')}
        </p>
      )}

      {orders.length === 0 ? (
        <div className="empty">{t('noOrdersToday')}</div>
      ) : (
        <div className="card table-scroll">
          <table className="orders-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('customer')}</th>
                <th>{t('colWaiter')}</th>
                <th>{t('colTime')}</th>
                <th className="num">{t('total')}</th>
                <th>{t('colKitchen')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className={o.cancelledAt ? 'cancelled' : o.held ? 'held' : ''}>
                  <td data-label="#">
                    <strong>{String(o.dailyNumber).padStart(3, '0')}</strong>
                  </td>
                  <td data-label={t('customer')}>
                    {o.customerName ?? <span className="muted">—</span>}
                    {o.cancelledAt !== null && (
                      <>
                        <span className="badge fail" style={{ marginLeft: 6 }}>
                          {t('cancelledBadge')}
                        </span>
                        {o.cancelledByName && (
                          <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>
                            {t('cancelledBy', { name: o.cancelledByName })}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td data-label={t('colWaiter')}>
                    {o.createdByName ?? <span className="badge">{t('customerBadge')}</span>}
                  </td>
                  <td data-label={t('colTime')} className="muted">
                    {new Date(o.createdAt * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td data-label={t('total')} className="num">
                    €{formatMoney(o.totalCents)}
                  </td>
                  <td data-label={t('colKitchen')}>
                    <PrintStatus order={o} />
                    {o.completedAt !== null && o.cancelledAt === null && (
                      <span className="badge ok" style={{ marginLeft: 4 }}>
                        {t('readyBadge')}
                      </span>
                    )}
                    {o.held ? (
                      <span className="badge" style={{ marginLeft: 4 }}>
                        {t('paymentInProgress')} · {o.paymentMethod === 'paypal' ? 'PayPal' : 'Stripe'}
                      </span>
                    ) : (
                      o.origin === 'customer' &&
                      o.paidAt === null &&
                      o.cancelledAt === null && (
                        <span className="badge fail" style={{ marginLeft: 4 }}>
                          {t('unpaidBadge')}
                        </span>
                      )
                    )}
                    {o.paymentMethod !== null &&
                      o.paymentMethod !== 'cash' &&
                      o.paidAt !== null &&
                      o.cancelledAt === null && (
                        <span className="badge ok" style={{ marginLeft: 4 }}>
                          {o.paymentMethod === 'paypal' ? 'PayPal' : 'Stripe'} ✓
                        </span>
                      )}
                    {o.refundedAt != null && (
                      <span className="badge" style={{ marginLeft: 4 }}>
                        {t('refundedBadge')}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {o.held ? null : (
                    <>
                    <button className="btn small" onClick={() => void api.order(o.id).then(setOpen)}>
                      {t('view')}
                    </button>{' '}
                    <a
                      className="btn small"
                      href={api.receiptUrl(o.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('receipt')}
                    </a>{' '}
                    <button
                      className="btn small"
                      disabled={reprinting === o.id || o.cancelledAt !== null}
                      onClick={() => void reprint(o.id)}
                    >
                      {reprinting === o.id
                        ? t('printing')
                        : o.printedAt
                          ? t('reprint')
                          : t('print')}
                    </button>{' '}
                    {o.origin === 'customer' && o.paidAt === null && o.cancelledAt === null && (
                      <>
                        <button
                          className="btn small primary"
                          disabled={marking === o.id}
                          onClick={() => void markPaid(o.id)}
                        >
                          {t('markPaid')}
                        </button>{' '}
                      </>
                    )}
                    {(user?.role === 'admin' || user?.role === 'maitre') && o.cancelledAt === null && (
                      confirmingCancel === o.id ? (
                        <button
                          className="btn small danger"
                          disabled={cancelling}
                          onClick={() => void cancelOrder(o.id)}
                          onBlur={() => setConfirmingCancel(null)}
                          autoFocus
                        >
                          {t('confirmCancel')}
                        </button>
                      ) : (
                        <button
                          className="btn small danger"
                          onClick={() => setConfirmingCancel(o.id)}
                        >
                          {t('cancelOrder')}
                        </button>
                      )
                    )}
                    </>
                    )}
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
            style={{
              width: '100%',
              maxWidth: 420,
              // Long orders scroll inside; the action buttons stay reachable.
              maxHeight: 'calc(100dvh - 32px)',
              display: 'flex',
              flexDirection: 'column',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              #{String(open.dailyNumber).padStart(3, '0')}
              {open.customerName ? ` · ${open.customerName}` : ''}
              {open.cancelledAt !== null && (
                <span className="badge fail" style={{ marginLeft: 8 }}>
                  {t('cancelledBadge')}
                  {open.cancelledByName ? ` ${t('cancelledBy', { name: open.cancelledByName })}` : ''}
                </span>
              )}
            </h2>
            <div className="table-scroll" style={{ overflowY: 'auto', minHeight: 0 }}>
              <table>
                <tbody>
                  {open.items.map((i) => (
                    <tr key={i.id} className={i.cancelledAt !== null ? 'cancelled' : ''}>
                      <td className="num" style={{ width: 40 }}>
                        {i.qty}×
                      </td>
                      <td>
                        {i.nameSnapshot}
                        {i.note && (
                          <div className="muted" style={{ fontSize: 13 }}>
                            {i.note}
                          </div>
                        )}
                      </td>
                      <td className="num">€{formatMoney(i.priceCentsSnapshot * i.qty)}</td>
                      <td className="num">
                        {open.cancelledAt === null && i.cancelledAt === null && (
                          <>
                            {i.qty > 1 && (
                              <button
                                className="btn small"
                                title={t('reduceQty')}
                                aria-label={t('reduceQty')}
                                onClick={() => void changeItemQty(open.id, i.id, i.qty - 1)}
                              >
                                −
                              </button>
                            )}{' '}
                            <button
                              className="btn small"
                              title={t('addQty')}
                              aria-label={t('addQty')}
                              onClick={() => void changeItemQty(open.id, i.id, i.qty + 1)}
                            >
                              +
                            </button>{' '}
                            {confirmingItemCancel === i.id ? (
                              <button
                                className="btn small danger"
                                autoFocus
                                onBlur={() => setConfirmingItemCancel(null)}
                                onClick={() => void cancelItem(open.id, i.id)}
                              >
                                {t('confirmCancel')}
                              </button>
                            ) : (
                              <button
                                className="btn small danger"
                                title={t('cancelItem')}
                                aria-label={t('cancelItem')}
                                onClick={() => setConfirmingItemCancel(i.id)}
                              >
                                ✕
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {open.covers > 0 && open.coverChargeCents > 0 && (
              <p style={{ display: 'flex', justifyContent: 'space-between', margin: '8px 0 0' }}>
                <span>
                  {open.covers} × {t('coverCharge')}
                </span>
                <span className="line-total">
                  €{formatMoney(open.covers * open.coverChargeCents)}
                </span>
              </p>
            )}
            {open.note && (
              <p className="muted" style={{ marginBottom: 0 }}>
                {t('notePrefix')} {open.note}
              </p>
            )}
            <div className="cart-total">
              <span>{t('total')}</span>
              <span className="amount">€{formatMoney(open.totalCents)}</span>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <a
                className="btn"
                style={{ flex: 1 }}
                href={api.orderPdfUrl(open.id)}
                target="_blank"
                rel="noreferrer"
              >
                {t('orderPdf')}
              </a>
              <a
                className="btn"
                style={{ flex: 1 }}
                href={api.receiptUrl(open.id)}
                target="_blank"
                rel="noreferrer"
              >
                {t('receiptPdf')}
              </a>
              <a
                className="btn"
                style={{ flex: 1 }}
                href={api.kitchenPdfUrl(open.id)}
                target="_blank"
                rel="noreferrer"
              >
                {t('kitchenPdf')}
              </a>
              <button className="btn" onClick={() => setOpen(null)}>
                {t('close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
