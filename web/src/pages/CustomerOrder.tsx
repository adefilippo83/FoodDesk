import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, formatMoney, type PublicMenu } from '../api'
import { LangToggle, useI18n } from '../i18n'
import { rememberMyOrder } from '../myOrders'

/**
 * Customer self-ordering: the public menu + cart page behind the QR code.
 * No login, no staff chrome — big taps, one screen, send.
 */
export default function CustomerOrder() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [data, setData] = useState<PublicMenu | null>(null)
  const [closed, setClosed] = useState(false)
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [qty, setQty] = useState<Record<number, number>>({})
  const [people, setPeople] = useState(1)
  const [payment, setPayment] = useState('counter')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const orderKeyRef = useRef<string | null>(null)

  useEffect(() => {
    api
      .publicMenu()
      .then((m) => {
        setData(m)
        setActiveCat(m.menu[0]?.id ?? null)
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setClosed(true)
        else setError(t('custLoadError'))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lines = useMemo(() => {
    if (!data) return []
    const all = data.menu.flatMap((c) => c.products)
    return Object.entries(qty)
      .map(([id, n]) => ({ product: all.find((p) => p.id === Number(id))!, n }))
      .filter((l) => l.product && l.n > 0)
  }, [data, qty])

  const coverTotal = (data?.coverChargeCents ?? 0) * people
  const total = lines.reduce((sum, l) => sum + l.product.priceCents * l.n, 0) + coverTotal

  const add = (id: number, delta: number) =>
    setQty((q) => {
      const n = Math.max(0, Math.min(99, (q[id] ?? 0) + delta))
      return { ...q, [id]: n }
    })

  async function send() {
    if (!name.trim()) return setError(t('custNameRequired'))
    if (lines.length === 0) return setError(t('custCartEmpty'))
    setSending(true)
    setError(null)
    orderKeyRef.current ??= crypto.randomUUID()
    try {
      const res = await api.publicCreateOrder({
        customerName: name.trim(),
        covers: people,
        note: note.trim() || undefined,
        clientKey: orderKeyRef.current,
        payment,
        items: lines.map((l) => ({ productId: l.product.id, qty: l.n })),
      })
      rememberMyOrder(res.publicToken, res.dailyNumber)
      if (res.paymentUrl) {
        // Off to the provider's hosted checkout; it sends the customer back
        // to the status page, which verifies and releases the order.
        window.location.assign(res.paymentUrl)
        return
      }
      navigate(`/o/${res.publicToken}`)
    } catch (err) {
      orderKeyRef.current = crypto.randomUUID() // fresh key for a changed retry
      setError(
        err instanceof ApiError && err.code === 'venue_busy'
          ? t('custBusy')
          : err instanceof ApiError && (err.code === 'out_of_stock' || err.code === 'products_unavailable')
            ? t('errOutOfStock')
            : t('errSendOrder'),
      )
    } finally {
      setSending(false)
    }
  }

  if (closed) {
    return (
      <div className="app">
        <main>
          <div className="empty">
            <p>{t('custClosed')}</p>
          </div>
        </main>
      </div>
    )
  }
  if (!data) return <div className="empty">{error ?? t('loading')}</div>

  const current = data.menu.find((c) => c.id === activeCat) ?? data.menu[0]

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{data.restaurantName}</div>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
          {t('custTagline')}
        </span>
        <LangToggle />
      </header>
      <main>
        {error && <div className="error">{error}</div>}

        <div className="cat-tabs">
          {data.menu.map((c) => (
            <button
              key={c.id}
              className={c.id === current?.id ? 'active' : ''}
              onClick={() => setActiveCat(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="product-grid">
          {current?.products.map((p) => (
            <button key={p.id} className="product-btn" onClick={() => add(p.id, 1)}>
              <span className="name">{p.name}</span>
              <span className="price">
                €{formatMoney(p.priceCents)}
                {(qty[p.id] ?? 0) > 0 && (
                  <span className="badge ok" style={{ marginLeft: 6 }}>
                    ×{qty[p.id]}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        <section className="card cart" style={{ marginTop: 16 }}>
          <h2>{t('custYourOrder')}</h2>

          <label className="field">
            <span>{t('custYourName')} *</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('custNamePlaceholder')}
              maxLength={60}
            />
          </label>

          <div className="field">
            <span style={{ display: 'block', marginBottom: 6 }}>
              {t('custHowMany')}
              {coverTotal > 0 && (
                <span className="muted"> · €{formatMoney(data.coverChargeCents)} {t('each')}</span>
              )}
            </span>
            <div className="qty-controls">
              <button className="qty-btn" onClick={() => setPeople((n) => Math.max(1, n - 1))}>
                −
              </button>
              <span className="qty" style={{ minWidth: 34, fontSize: 18 }}>
                {people}
              </span>
              <button className="qty-btn" onClick={() => setPeople((n) => Math.min(99, n + 1))}>
                +
              </button>
              {coverTotal > 0 && (
                <span className="line-total" style={{ marginLeft: 'auto' }}>
                  €{formatMoney(coverTotal)}
                </span>
              )}
            </div>
          </div>

          {lines.length === 0 ? (
            <p className="muted">{t('tapToAdd')}</p>
          ) : (
            lines.map((l) => (
              <div key={l.product.id} className="field">
                <div className="row" style={{ alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>{l.product.name}</span>
                  <div className="qty-controls">
                    <button className="qty-btn" onClick={() => add(l.product.id, -1)}>
                      −
                    </button>
                    <span className="qty" style={{ minWidth: 28 }}>{l.n}</span>
                    <button className="qty-btn" onClick={() => add(l.product.id, 1)}>
                      +
                    </button>
                  </div>
                  <span className="line-total" style={{ minWidth: 70, textAlign: 'right' }}>
                    €{formatMoney(l.product.priceCents * l.n)}
                  </span>
                </div>
              </div>
            ))
          )}

          <label className="field">
            <span>{t('kitchenNote')}</span>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('kitchenNotePlaceholder')}
              maxLength={500}
            />
          </label>

          {(data.paymentMethods ?? []).some((m) => m !== 'counter') && (
            <div className="field">
              <span style={{ display: 'block', marginBottom: 6 }}>{t('custPayHow')}</span>
              <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
                {(data.paymentMethods ?? []).map((m) => (
                  <label key={m} className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="payment"
                      checked={payment === m}
                      onChange={() => setPayment(m)}
                    />
                    <span>
                      {m === 'counter'
                        ? t('custPayCounter')
                        : m === 'stripe'
                          ? t('custPayCard')
                          : 'PayPal'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row" style={{ alignItems: 'center', marginTop: 8 }}>
            <strong style={{ fontSize: 18 }}>{t('total')}</strong>
            <strong style={{ marginLeft: 'auto', fontSize: 20 }}>€{formatMoney(total)}</strong>
          </div>

          <button
            className="btn primary"
            style={{ width: '100%', marginTop: 12, minHeight: 52 }}
            disabled={sending || lines.length === 0}
            onClick={() => void send()}
          >
            {sending ? t('sending') : t('custSend')}
          </button>
          <p className="muted" style={{ fontSize: 13, marginTop: 8, textAlign: 'center' }}>
            {payment === 'counter' ? t('custPayAtPickup') : t('custPayRedirectHint')}
          </p>
        </section>
      </main>
    </div>
  )
}
