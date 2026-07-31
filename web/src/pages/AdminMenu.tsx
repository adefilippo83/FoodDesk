import { useEffect, useRef, useState } from 'react'
import { api, formatMoney, parseMoney, type Category, type Product } from '../api'
import { useI18n } from '../i18n'

/**
 * Pointer-based row dragging: works with mouse and touch alike (HTML5
 * drag-and-drop does not do touch), ~40 lines instead of a library.
 * The handle sets touch-action:none so dragging does not scroll the page.
 */
function useRowDrag(
  getIds: () => number[],
  move: (from: number, to: number) => void,
  commit: () => void,
) {
  const refs = useRef(new Map<number, HTMLTableRowElement>())
  const [dragId, setDragId] = useState<number | null>(null)
  const draggingRef = useRef<number | null>(null)

  const start = (id: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = id
    setDragId(id)

    const onMove = (ev: PointerEvent) => {
      const ids = getIds()
      const from = ids.indexOf(draggingRef.current!)
      if (from < 0) return
      for (let i = 0; i < ids.length; i++) {
        if (i === from) continue
        const el = refs.current.get(ids[i]!)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (ev.clientY > r.top && ev.clientY < r.bottom) {
          move(from, i)
          break
        }
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      draggingRef.current = null
      setDragId(null)
      commit()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { refs, start, dragId }
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

export default function AdminMenu() {
  const { t } = useI18n()
  const [categories, setCategories] = useState<Category[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [newCategory, setNewCategory] = useState('')
  const [pName, setPName] = useState('')
  const [pPrice, setPPrice] = useState('')
  const [pCategory, setPCategory] = useState<number | ''>('')
  const [editing, setEditing] = useState<number | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editingStock, setEditingStock] = useState<number | null>(null)
  const [stockValue, setStockValue] = useState('')

  // Refs so drag callbacks always see the current order, never a stale render.
  const categoriesRef = useRef(categories)
  const productsRef = useRef(products)
  useEffect(() => {
    categoriesRef.current = categories
    productsRef.current = products
  }, [categories, products])

  async function load() {
    try {
      const [c, p] = await Promise.all([api.categories(true), api.products(true)])
      setCategories(c)
      // Keep product rows grouped by category so dragging stays within reason.
      setProducts(sortProducts(p, c))
      setPCategory((cur) => (cur === '' ? (c.find((x) => x.active)?.id ?? '') : cur))
      setError(null)
    } catch {
      setError(t('errLoadMenu'))
    } finally {
      setLoading(false)
    }
  }

  function sortProducts(p: Product[], c: Category[]): Product[] {
    const pos = new Map(c.map((cat, i) => [cat.id, i]))
    return [...p].sort(
      (a, b) => (pos.get(a.categoryId) ?? 0) - (pos.get(b.categoryId) ?? 0) || a.sortOrder - b.sortOrder,
    )
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const catDrag = useRowDrag(
    () => categoriesRef.current.map((c) => c.id),
    (from, to) => setCategories((prev) => arrayMove(prev, from, to)),
    () => {
      void api
        .reorderCategories(categoriesRef.current.map((c) => c.id))
        .catch(() => {
          setError(t('errReorder'))
          void load()
        })
    },
  )

  const prodDrag = useRowDrag(
    () => productsRef.current.map((p) => p.id),
    (from, to) => setProducts((prev) => arrayMove(prev, from, to)),
    () => {
      void api
        .reorderProducts(productsRef.current.map((p) => p.id))
        .catch(() => {
          setError(t('errReorder'))
          void load()
        })
    },
  )

  async function run(action: () => Promise<unknown>, failure: string) {
    try {
      await action()
      await load()
    } catch {
      setError(failure)
    }
  }

  function commitPrice(productId: number) {
    const cents = parseMoney(editPrice)
    setEditing(null)
    if (cents === null) return setError(t('errPriceFormat'))
    setError(null)
    void run(() => api.updateProduct(productId, { priceCents: cents }), t('errUpdatePrice'))
  }

  function commitStock(productId: number) {
    const raw = stockValue.trim()
    setEditingStock(null)
    let value: number | null
    if (raw === '' || raw === '∞') {
      value = null // empty = stop tracking stock for this product
    } else {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0) return setError(t('errStockFormat'))
      value = n
    }
    setError(null)
    void run(() => api.updateProduct(productId, { stockRemaining: value }), t('errUpdateStock'))
  }

  function addProduct() {
    const cents = parseMoney(pPrice)
    if (!pName.trim()) return setError(t('errProductName'))
    if (cents === null) return setError(t('errPriceFormat'))
    if (pCategory === '') return setError(t('errPickCategory'))
    setError(null)
    void run(
      () =>
        api
          .createProduct({ name: pName.trim(), priceCents: cents, categoryId: pCategory })
          .then(() => {
            setPName('')
            setPPrice('')
          }),
      t('errAddProduct'),
    )
  }

  function addCategory() {
    if (!newCategory.trim()) return
    void run(
      () => api.createCategory(newCategory.trim()).then(() => setNewCategory('')),
      t('errAddCategory'),
    )
  }

  if (loading) return <div className="empty">{t('loading')}</div>

  return (
    <>
      <h1>{t('navMenu')}</h1>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t('categories')}</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <input
            className="input"
            placeholder={t('newCategoryPlaceholder')}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addCategory()
            }}
          />
          <button className="btn primary" disabled={!newCategory.trim()} onClick={addCategory}>
            {t('add')}
          </button>
        </div>

        {categories.length === 0 ? (
          <p className="muted">{t('noCategories')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>{t('name')}</th>
                  <th className="num">{t('products')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr
                    key={c.id}
                    ref={(el) => {
                      if (el) catDrag.refs.current.set(c.id, el)
                      else catDrag.refs.current.delete(c.id)
                    }}
                    className={`${c.active ? '' : 'inactive'} ${catDrag.dragId === c.id ? 'dragging' : ''}`}
                  >
                    <td>
                      <span className="drag-handle" onPointerDown={catDrag.start(c.id)}>
                        ≡
                      </span>
                    </td>
                    <td>
                      {c.name} {!c.active && <span className="badge">{t('hidden')}</span>}
                    </td>
                    <td className="num">
                      {products.filter((p) => p.categoryId === c.id && p.active).length}
                    </td>
                    <td className="num">
                      {c.active ? (
                        <button
                          className="btn small danger"
                          onClick={() => void run(() => api.deleteCategory(c.id), t('errHideCategory'))}
                        >
                          {t('hide')}
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          onClick={() =>
                            void run(
                              () => api.updateCategory(c.id, { active: true }),
                              t('errRestoreCategory'),
                            )
                          }
                        >
                          {t('restore')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          {t('dragToReorder')} {t('softDeleteHint')}
        </p>
      </div>

      <div className="card">
        <h2>{t('products')}</h2>

        <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '2 1 160px', width: 'auto' }}
            placeholder={t('productNamePlaceholder')}
            value={pName}
            onChange={(e) => setPName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 90px', width: 'auto' }}
            placeholder={t('pricePlaceholder')}
            inputMode="decimal"
            value={pPrice}
            onChange={(e) => setPPrice(e.target.value)}
          />
          <select
            className="input"
            style={{ flex: '1 1 140px', width: 'auto' }}
            value={pCategory}
            onChange={(e) => setPCategory(Number(e.target.value))}
          >
            {categories
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <button className="btn primary" onClick={addProduct}>
            {t('add')}
          </button>
        </div>

        {products.length === 0 ? (
          <p className="muted">{t('noProducts')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>{t('name')}</th>
                  <th>{t('category')}</th>
                  <th className="num">{t('price')}</th>
                  <th className="num">{t('stock')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr
                    key={p.id}
                    ref={(el) => {
                      if (el) prodDrag.refs.current.set(p.id, el)
                      else prodDrag.refs.current.delete(p.id)
                    }}
                    className={`${p.active ? '' : 'inactive'} ${prodDrag.dragId === p.id ? 'dragging' : ''}`}
                  >
                    <td>
                      <span className="drag-handle" onPointerDown={prodDrag.start(p.id)}>
                        ≡
                      </span>
                    </td>
                    <td>
                      {p.name} {!p.active && <span className="badge">{t('hidden')}</span>}
                    </td>
                    <td>
                      <select
                        className="input"
                        style={{ minHeight: 36, width: 'auto', padding: '0 8px' }}
                        value={p.categoryId}
                        onChange={(e) =>
                          void run(
                            () => api.updateProduct(p.id, { categoryId: Number(e.target.value) }),
                            t('errMoveProduct'),
                          )
                        }
                      >
                        {categories
                          .filter((c) => c.active || c.id === p.categoryId)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="num">
                      {editing === p.id ? (
                        <input
                          className="input"
                          style={{ width: 90, textAlign: 'right' }}
                          inputMode="decimal"
                          autoFocus
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value)}
                          onBlur={() => commitPrice(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitPrice(p.id)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                      ) : (
                        <button
                          className="btn small"
                          title={t('tapToChangePrice')}
                          onClick={() => {
                            setEditing(p.id)
                            setEditPrice((p.priceCents / 100).toFixed(2))
                          }}
                        >
                          €{formatMoney(p.priceCents)}
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {editingStock === p.id ? (
                        <input
                          className="input"
                          style={{ width: 80, textAlign: 'right' }}
                          inputMode="numeric"
                          autoFocus
                          value={stockValue}
                          onChange={(e) => setStockValue(e.target.value)}
                          onBlur={() => commitStock(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitStock(p.id)
                            if (e.key === 'Escape') setEditingStock(null)
                          }}
                        />
                      ) : (
                        <button
                          className="btn small"
                          title={t('stockHint')}
                          onClick={() => {
                            setEditingStock(p.id)
                            setStockValue(p.stockRemaining === null ? '' : String(p.stockRemaining))
                          }}
                        >
                          {p.stockRemaining === null ? '∞' : p.stockRemaining}
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {p.active ? (
                        <button
                          className="btn small danger"
                          onClick={() => void run(() => api.deleteProduct(p.id), t('errRemoveProduct'))}
                        >
                          {t('remove')}
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          onClick={() =>
                            void run(
                              () => api.updateProduct(p.id, { active: true }),
                              t('errRestoreProduct'),
                            )
                          }
                        >
                          {t('restore')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          {t('dragToReorder')}
        </p>
      </div>
    </>
  )
}
