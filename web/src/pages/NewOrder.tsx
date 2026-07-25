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
 * Auto-print fallback when no CUPS printer is configured: the order sheet
 * (foglio ordine), mirroring the server-rendered order.pdf. This deliberately
 * prints HTML, not the PDF: browsers cannot script-print a PDF inside an
 * iframe (Chrome prints the surrounding page instead — which, on a dark
 * theme, comes out as blank sheets). Same-origin HTML iframes print reliably
 * everywhere. The print dialog still appears; browsers never allow fully
 * silent printing.
 */
function autoPrintOrderSheet(
  order: OrderDetail,
  config: AppConfig,
  labels: { orderWord: string; coverCharge: string; total: string; notePrefix: string },
) {
  const esc = escapeHtml
  const text = (s: string) => esc(s).replaceAll('\n', '<br>')
  const money = (cents: number) => `€ ${formatMoney(cents)}`

  const time = new Date(order.createdAt * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const groups: { name: string; items: OrderDetail['items'] }[] = []
  for (const item of order.items) {
    const g = groups.find((x) => x.name === item.categoryNameSnapshot)
    if (g) g.items.push(item)
    else groups.push({ name: item.categoryNameSnapshot, items: [item] })
  }

  const blocks = groups
    .map((g, i) => {
      const alt = config.orderCategoryStyle === 'alternating' && i % 2 === 1
      const sep =
        config.orderCategoryStyle === 'separator' && i > 0 ? '<div class="sep"></div>' : ''
      const lines = g.items
        .map(
          (it) =>
            `<div class="line"><span>${it.qty} × ${esc(it.nameSnapshot)}</span><span>${money(
              it.priceCentsSnapshot * it.qty,
            )}</span></div>` + (it.note ? `<div class="inote">» ${esc(it.note)}</div>` : ''),
        )
        .join('')
      return `${sep}<div class="block${alt ? ' alt' : ''}"><div class="cat">${esc(g.name)}</div>${lines}</div>`
    })
    .join('')

  const coperto =
    order.covers > 0 && order.coverChargeCents > 0
      ? `<div class="line coperto"><span>${order.covers} × ${esc(labels.coverCharge)}</span><span>${money(
          order.covers * order.coverChargeCents,
        )}</span></div>`
      : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 5mm; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #000; background: #fff; margin: 0; }
    img.hf { display: block; max-width: 100%; height: auto; margin: 0 auto 4px; }
    .htext { text-align: center; font-size: ${config.orderHeaderFontSize}pt; color: #333; margin: 0 0 4px; }
    .info { font-size: 17px; font-weight: 800; text-align: center; margin: 2px 0; }
    hr { border: 0; border-top: 2px dashed #000; margin: 8px 0; }
    .block { padding: 3px 5px; }
    .block.alt { background: #f0f0f0; }
    .sep { border-top: 1px solid #999; margin: 5px 0; }
    .cat { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #555; margin: 2px 0; }
    .line { display: flex; justify-content: space-between; gap: 8px; font-size: 15px; margin: 2px 0; }
    .line.coperto { padding: 3px 5px; }
    .inote { font-style: italic; font-size: 12px; margin: 0 0 3px 14px; }
    .total { display: flex; justify-content: space-between; font-size: 18px; font-weight: 800; background: #e5e5e5; padding: 6px; margin-top: 8px; }
    .note { font-style: italic; font-size: 14px; margin: 4px 0; }
    .disclaimer { font-size: ${config.orderDisclaimerFontSize}pt; font-weight: 700; color: #555; text-align: center; margin: 8px 0 0; }
    .ftext { text-align: center; font-size: ${config.orderFooterFontSize}pt; color: #444; margin: 8px 0 0; }
  </style></head><body>
    ${config.orderHeaderImage ? `<img class="hf" style="width:${config.orderHeaderImageWidthPct}%" src="${config.orderHeaderImage}">` : ''}
    ${config.orderHeaderText ? `<p class="htext">${text(config.orderHeaderText)}</p>` : ''}
    <p class="info">${esc(labels.orderWord)} #${String(order.dailyNumber).padStart(3, '0')} · ${order.serviceDay} · ${time}${order.customerName ? ` · ${esc(order.customerName)}` : ''}</p>
    <hr>
    ${coperto}
    ${blocks}
    <div class="total"><span>${esc(labels.total)}</span><span>${money(order.totalCents)}</span></div>
    ${order.note ? `<hr><div class="note">${esc(labels.notePrefix)} ${esc(order.note)}</div>` : ''}
    ${config.orderDisclaimer ? `<p class="disclaimer">${text(config.orderDisclaimer)}</p>` : ''}
    ${config.orderFooterText ? `<p class="ftext">${text(config.orderFooterText)}</p>` : ''}
    ${config.orderFooterImage ? `<img class="hf" style="width:${config.orderFooterImageWidthPct}%" src="${config.orderFooterImage}">` : ''}
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
      window.open(api.orderPdfUrl(order.id), '_blank')
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
        // No coperto configured → no covers to count on this order.
        covers: coverChargeCents > 0 ? covers : 0,
        note: note.trim() || undefined,
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      })
      // Clear straight away — the waiter is already walking to the next table.
      setLines([])
      setCustomerName('')
      setCovers(1)
      setNote('')
      setToast(t('orderSent', { n: order.dailyNumber }))
      // No CUPS printer? Hand the order sheet to the browser's print dialog.
      if (config && !config.printerConfigured) {
        autoPrintOrderSheet(order, config, {
          orderWord: t('cartTitle'),
          coverCharge: t('coverCharge'),
          total: t('total'),
          notePrefix: t('notePrefix'),
        })
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

          {coverChargeCents > 0 && (
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
                <span style={{ fontWeight: 400 }}>
                  {' '}
                  · €{formatMoney(coverChargeCents)} {t('each')}
                </span>
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
                {covers > 0 && (
                  <span className="line-total" style={{ marginLeft: 'auto' }}>
                    €{formatMoney(covers * coverChargeCents)}
                  </span>
                )}
              </div>
            </div>
          )}

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
