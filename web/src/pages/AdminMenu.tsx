import { useEffect, useState } from 'react'
import { api, formatMoney, parseMoney, type Category, type Product } from '../api'

export default function AdminMenu() {
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
      setError('Could not load the menu.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
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
    if (cents === null) return setError('Price must look like 8 or 8.50.')
    setError(null)
    void run(
      () => api.updateProduct(productId, { priceCents: cents }),
      'Could not update the price.',
    )
  }

  function addProduct() {
    const cents = parseMoney(pPrice)
    if (!pName.trim()) return setError('Give the product a name.')
    if (cents === null) return setError('Price must look like 8 or 8.50.')
    if (pCategory === '') return setError('Pick a category.')
    setError(null)
    void run(
      () =>
        api
          .createProduct({ name: pName.trim(), priceCents: cents, categoryId: pCategory })
          .then(() => {
            setPName('')
            setPPrice('')
          }),
      'Could not add the product.',
    )
  }

  if (loading) return <div className="empty">Loading…</div>

  return (
    <>
      <h1>Menu</h1>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Categories</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <input
            className="input"
            placeholder="New category, e.g. Starters"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !newCategory.trim()) return
              void run(
                () => api.createCategory(newCategory.trim()).then(() => setNewCategory('')),
                'Could not add the category.',
              )
            }}
          />
          <button
            className="btn primary"
            disabled={!newCategory.trim()}
            onClick={() =>
              void run(
                () => api.createCategory(newCategory.trim()).then(() => setNewCategory('')),
                'Could not add the category.',
              )
            }
          >
            Add
          </button>
        </div>

        {categories.length === 0 ? (
          <p className="muted">No categories yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Products</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'inactive'}>
                    <td>
                      {c.name} {!c.active && <span className="badge">hidden</span>}
                    </td>
                    <td className="num">
                      {products.filter((p) => p.categoryId === c.id && p.active).length}
                    </td>
                    <td className="num">
                      {c.active ? (
                        <button
                          className="btn small danger"
                          onClick={() =>
                            void run(() => api.deleteCategory(c.id), 'Could not hide the category.')
                          }
                        >
                          Hide
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          onClick={() =>
                            void run(
                              () => api.updateCategory(c.id, { active: true }),
                              'Could not restore the category.',
                            )
                          }
                        >
                          Restore
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
          Hiding a category also hides its products. Nothing is ever deleted outright, so past
          orders stay intact.
        </p>
      </div>

      <div className="card">
        <h2>Products</h2>

        <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '2 1 160px', width: 'auto' }}
            placeholder="Product name"
            value={pName}
            onChange={(e) => setPName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 90px', width: 'auto' }}
            placeholder="8.50"
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
            Add
          </button>
        </div>

        {products.length === 0 ? (
          <p className="muted">No products yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th className="num">Price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'inactive'}>
                    <td>
                      {p.name} {!p.active && <span className="badge">hidden</span>}
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
                          title="Tap to change the price"
                          onClick={() => {
                            setEditing(p.id)
                            setEditPrice(formatMoney(p.priceCents))
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
                          onClick={() =>
                            void run(() => api.deleteProduct(p.id), 'Could not remove the product.')
                          }
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          onClick={() =>
                            void run(
                              () => api.updateProduct(p.id, { active: true }),
                              'Could not restore the product.',
                            )
                          }
                        >
                          Restore
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
