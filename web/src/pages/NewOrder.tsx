import { useEffect, useMemo, useRef, useState } from 'react'
import { api, formatMoney, type AppConfig, type MenuCategory, type OrderDetail } from '../api'
import { useI18n } from '../i18n'

type Line = { productId: number; name: string; priceCents: number; qty: number }

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Auto-print fallback when no CUPS printer is configured. This deliberately
 * prints an HTML ticket, not the PDF: browsers cannot script-print a PDF
 * inside an iframe (Chrome prints the surrounding page instead — which, on a
 * dark theme, comes out as blank sheets). Same-origin HTML iframes print
 * reliably everywhere. The print dialog still appears; browsers never allow
 * fully silent printing.
 */
function autoPrintTicket(order: OrderDetail, coversLabel: string) {
  const items = order.items
    .map(
      (i) =>
        `<div class="item">${i.qty} × ${escapeHtml(i.nameSnapshot)}</div>` +
        (i.note ? `<div class="note">» ${escapeHtml(i.note)}</div>` : ''),
    )
    .join('')

  const time = new Date(order.createdAt * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 5mm; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; background: #fff; margin: 0; }
    .num { font-size: 30px; font-weight: 800; text-align: center; margin: 0; }
    .sub { text-align: center; font-size: 15px; margin: 2px 0 0; }
    hr { border: 0; border-top: 2px dashed #000; margin: 10px 0; }
    .item { font-size: 19px; font-weight: 700; margin: 5px 0; }
    .note { font-style: italic; font-size: 14px; margin: 0 0 4px 14px; }
  </style></head><body>
    <p class="num">#${String(order.dailyNumber).padStart(3, '0')}</p>
    <p class="sub">${escapeHtml(order.customerName ?? '')} · ${time}</p>
    ${order.covers > 0 ? `<p class="sub">${escapeHtml(coversLabel)}: ${order.covers}</p>` : ''}
    <hr>
    ${items}
    ${order.note ? `<hr><div class="note">${escapeHtml(order.note)}</div>` : ''}
  </body></html>`

  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.srcdoc = html
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } catch {
      window.open(api.kitchenPdfUrl(order.id), '_blank')
    }
  }
  document.body.appendChild(frame)
  // Keep the frame alive while the print dialog is open.
  setTimeout(() => frame.remove(), 60_000)
}

export default function NewOrder() {
  const { t } = useI18n()
  const [menu, setMenu] = useState<MenuCategory[] | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [customerName, setCustomerName] = useState('')
  const [covers, setCovers] = useState(1)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const customerRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api
      .menu()
      .then((m) => {
        setMenu(m)
        setActiveCat((c) => c ?? m[0]?.id ?? null)
      })
      .catch(() => setError(t('errLoadMenu')))
    api.config().then(setConfig).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const coverChargeCents = config?.coverChargeCents ?? 0
  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0) + covers * coverChargeCents,
    [lines, covers, coverChargeCents],
  )

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
    if (!customerName.trim()) {
      setError(t('errCustomerRequired'))
      customerRef.current?.focus()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const order = await api.createOrder({
        customerName: customerName.trim(),
        covers,
        note: note.trim() || undefined,
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      })
      // Clear straight away — the waiter is already walking to the next table.
      setLines([])
      setCustomerName('')
      setCovers(1)
      setNote('')
      setToast(t('orderSent', { n: order.dailyNumber }))
      // No CUPS printer? Hand the kitchen ticket to the browser's print dialog.
      if (config && !config.printerConfigured) {
        autoPrintTicket(order, t('covers'))
      }
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
            <span>{t('customer')} *</span>
            <input
              ref={customerRef}
              className="input"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t('customerPlaceholder')}
              required
            />
          </label>

          <div className="field">
            <span
              style={{
                display: 'block',
                fontSize: 13,
                color: 'var(--text-dim)',
                marginBottom: 6,
                fontWeight: 600,
              }}
            >
              {t('covers')}
              {coverChargeCents > 0 && (
                <span style={{ fontWeight: 400 }}> · €{formatMoney(coverChargeCents)} cad.</span>
              )}
            </span>
            <div className="qty-controls">
              <button
                className="qty-btn"
                onClick={() => setCovers((c) => Math.max(0, c - 1))}
                aria-label={t('oneLess', { name: t('covers') })}
              >
                −
              </button>
              <span className="qty" style={{ minWidth: 34, fontSize: 18 }}>
                {covers}
              </span>
              <button
                className="qty-btn"
                onClick={() => setCovers((c) => Math.min(99, c + 1))}
                aria-label={t('oneMore', { name: t('covers') })}
              >
                +
              </button>
              {coverChargeCents > 0 && covers > 0 && (
                <span className="line-total" style={{ marginLeft: 'auto' }}>
                  €{formatMoney(covers * coverChargeCents)}
                </span>
              )}
            </div>
          </div>

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
