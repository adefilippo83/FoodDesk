import { useEffect, useState } from 'react'
import { api, formatMoney, parseMoney, type Category, type Product } from '../api'
import { useI18n } from '../i18n'

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

  async function load() {
    try {
      const [c, p] = await Promise.all([api.categories(true), api.products(true)])
      setCategories(c)
      setProducts(p)
      setPCategory((cur) => (cur === '' ? (c.find((x) => x.active)?.id ?? '') : cur))
      setError(null)
    } catch {
      setError(t('errLoadMenu'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
                  <th>{t('name')}</th>
                  <th className="num">{t('products')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'inactive'}>
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
          {t('softDeleteHint')}
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
                  <th>{t('name')}</th>
                  <th>{t('category')}</th>
                  <th className="num">{t('price')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'inactive'}>
                    <td>
                      {p.name} {!p.active && <span className="badge">{t('hidden')}</span>}
                    </td>
                    <td className="muted">
                      {categories.find((c) => c.id === p.categoryId)?.name ?? '—'}
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
      </div>
    </>
  )
}
