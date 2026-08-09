import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api, formatMoney, type PublicOrderStatus } from '../api'
import { LangToggle, useI18n } from '../i18n'

/**
 * The customer's live order page: big pickup number, item ticks, and the
 * one question that matters — is it ready yet? Polls every 5 seconds; the
 * public surface deliberately has no SSE.
 */
export default function CustomerStatus() {
  const { t } = useI18n()
  const { token } = useParams<{ token: string }>()
  const [order, setOrder] = useState<PublicOrderStatus | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!token) return
    const timer: { id?: ReturnType<typeof setInterval> } = {}
    const load = () =>
      api
        .publicOrderStatus(token)
        .then(setOrder)
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) {
            setMissing(true)
            if (timer.id) clearInterval(timer.id)
          }
        })
    void load()
    timer.id = setInterval(() => void load(), 5000)
    return () => clearInterval(timer.id)
  }, [token])

  if (missing) {
    return (
      <div className="app">
        <main>
          <div className="empty">
            <p>{t('custOrderNotFound')}</p>
            <Link className="btn" to="/order">
              {t('custNewOrder')}
            </Link>
          </div>
        </main>
      </div>
    )
  }
  if (!order) return <div className="empty">{t('loading')}</div>

  const activeItems = order.items.filter((i) => i.cancelledAt === null)
  const state = order.cancelledAt
    ? 'cancelled'
    : order.paidAt
      ? 'collected'
      : order.completedAt
        ? 'ready'
        : 'preparing'
  const stateLabel = {
    cancelled: t('custStateCancelled'),
    collected: t('custStateCollected'),
    ready: t('custStateReady'),
    preparing: t('custStatePreparing'),
  }[state]

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Food<span>Desk</span>
        </div>
        <LangToggle />
      </header>
      <main>
        <div className="card" style={{ textAlign: 'center', marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            {t('custYourNumber')}
          </p>
          <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.1 }}>
            {String(order.dailyNumber).padStart(3, '0')}
          </div>
          <span
            className={`badge ${state === 'cancelled' ? 'fail' : state === 'preparing' ? '' : 'ok'}`}
            style={{ fontSize: 15, padding: '6px 14px' }}
          >
            {stateLabel}
          </span>
          {state === 'ready' && (
            <p className="muted" style={{ marginBottom: 0 }}>
              {t('custComeCollect')}
            </p>
          )}
        </div>

        <div className="card">
          {order.customerName && (
            <p className="muted" style={{ marginTop: 0 }}>
              {order.customerName} · {order.covers} {t('custPeopleWord')}
            </p>
          )}
          {activeItems.map((i, idx) => (
            <div key={idx} className="row" style={{ alignItems: 'center', margin: '6px 0' }}>
              <span style={{ flex: 1 }}>
                {i.qty} × {i.nameSnapshot}
              </span>
              <span className="line-total" style={{ marginRight: 10 }}>
                €{formatMoney(i.priceCentsSnapshot * i.qty)}
              </span>
              <span className={`badge ${i.doneAt ? 'ok' : ''}`}>
                {i.doneAt ? '✓' : '…'}
              </span>
            </div>
          ))}
          {order.covers > 0 && order.coverChargeCents > 0 && (
            <div className="row muted" style={{ margin: '6px 0' }}>
              <span style={{ flex: 1 }}>
                {order.covers} × {t('coverCharge')}
              </span>
              <span>€{formatMoney(order.covers * order.coverChargeCents)}</span>
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <strong style={{ flex: 1, fontSize: 18 }}>{t('total')}</strong>
            <strong style={{ fontSize: 18 }}>€{formatMoney(order.totalCents)}</strong>
          </div>
          {!order.paidAt && !order.cancelledAt && (
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
              {t('custPayAtPickup')}
            </p>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link className="btn" to="/order">
            {t('custNewOrder')}
          </Link>
        </div>
      </main>
    </div>
  )
}
