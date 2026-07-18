import { useEffect, useMemo, useState } from 'react'
import { api, formatMoney, type MenuCategory } from '../api'
import { useI18n } from '../i18n'

type Line = { productId: number; name: string; priceCents: number; qty: number }

export default function NewOrder() {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuCategory[] | null>(null)
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [tableLabel, setTableLabel] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api
      .menu()
      .then((m) => {
        setMenu(m)
        setActiveCat((c) => c ?? m[0]?.id ?? null)
      })
      .catch(() => setError(t('errLoadMenu')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const total = useMemo(() => lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0), [lines])

  function add(product: { id: number; name: string; priceCents: number }) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === product.id)
      if (existing) {
        return prev.map((l) => (l.productId === product.id ? { ...l, qty: l.qty + 1 } : l))
      }
      return [
        ...prev,
        { productId: product.id, name: product.name, priceCents: product.priceCents, qty: 1 },
      ]
    })
  }

  function changeQty(productId: number, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    )
  }

  async function submit() {
    if (lines.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const order = await api.createOrder({
        tableLabel: tableLabel.trim() || undefined,
        note: note.trim() || undefined,
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      })
      // Clear straight away — the waiter is already walking to the next table.
      setLines([])
      setTableLabel('')
      setNote('')
      setToast(t('orderSent', { n: order.dailyNumber }))
    } catch (err) {
      setError(
        err && typeof err === 'object' && 'code' in err && err.code === 'products_unavailable'
          ? t('errProductGone')
          : t('errSendOrder'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (!menu) return <div className="empty">{t('loadingMenu')}</div>

  if (menu.length === 0) {
    return (
      <div className="empty">
        <p>{t('menuEmpty')}</p>
        <p className="muted">{t('menuEmptyHint')}</p>
      </div>
    )
  }

  const current = menu.find((c) => c.id === activeCat) ?? menu[0]

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="order-layout">
        <div>
          <div className="cat-tabs">
            {menu.map((c) => (
              <button
                key={c.id}
                className={c.id === current.id ? 'active' : ''}
                onClick={() => setActiveCat(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          {current.products.length === 0 ? (
            <div className="empty">{t('nothingInCategory', { name: current.name })}</div>
          ) : (
            <div className="product-grid">
              {current.products.map((p) => (
                <button key={p.id} className="product-btn" onClick={() => add(p)}>
                  <span className="name">{p.name}</span>
                  <span className="price">€{formatMoney(p.priceCents)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="card cart">
          <h2>{t('cartTitle')}</h2>

          <label className="field">
            <span>{t('table')}</span>
            <input
              className="input"
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              placeholder={t('tablePlaceholder')}
            />
          </label>

          {lines.length === 0 ? (
            <p className="muted">{t('tapToAdd')}</p>
          ) : (
            <div>
              {lines.map((l) => (
                <div className="cart-line" key={l.productId}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{l.name}</div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      €{formatMoney(l.priceCents)} {t('each')}
                    </div>
                  </div>
                  <div className="line-total">€{formatMoney(l.priceCents * l.qty)}</div>
                  <div className="qty-controls">
                    <button
                      className="qty-btn"
                      onClick={() => changeQty(l.productId, -1)}
                      aria-label={t('oneLess', { name: l.name })}
                    >
                      −
                    </button>
                    <span className="qty">{l.qty}</span>
                    <button
                      className="qty-btn"
                      onClick={() => changeQty(l.productId, 1)}
                      aria-label={t('oneMore', { name: l.name })}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <label className="field" style={{ marginTop: 14 }}>
            <span>{t('kitchenNote')}</span>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('kitchenNotePlaceholder')}
            />
          </label>

          <div className="cart-total">
            <span>{t('total')}</span>
            <span className="amount">€{formatMoney(total)}</span>
          </div>

          <div className="row">
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={lines.length === 0 || submitting}
              onClick={() => void submit()}
            >
              {submitting ? t('sending') : t('sendOrder')}
            </button>
            {lines.length > 0 && (
              <button className="btn danger" onClick={() => setLines([])} disabled={submitting}>
                {t('clear')}
              </button>
            )}
          </div>
        </aside>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
