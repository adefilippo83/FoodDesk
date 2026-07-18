export type Role = 'admin' | 'operator'

export type Me = { id: number; username: string; displayName: string; role: Role }
export type Category = { id: number; name: string; sortOrder: number; active: boolean }
export type Product = {
  id: number
  categoryId: number
  name: string
  priceCents: number
  sortOrder: number
  active: boolean
}
export type MenuCategory = {
  id: number
  name: string
  products: { id: number; name: string; priceCents: number }[]
}
export type OrderSummary = {
  id: number
  dailyNumber: number
  serviceDay: string
  tableLabel: string | null
  note: string | null
  totalCents: number
  createdAt: number
  createdByName: string
  printedAt: number | null
  printError: string | null
}
export type OrderItem = {
  id: number
  nameSnapshot: string
  priceCentsSnapshot: number
  categoryNameSnapshot: string
  qty: number
  note: string | null
}
export type OrderDetail = OrderSummary & { items: OrderItem[] }
export type User = {
  id: number
  username: string
  displayName: string
  role: Role
  active: boolean
}

export type DailyReport = {
  serviceDay: string
  ordersCount: number
  revenueCents: number
  avgOrderCents: number
  byProduct: { name: string; qty: number; revenueCents: number }[]
  byCategory: { name: string; qty: number; revenueCents: number }[]
  byWaiter: { name: string; ordersCount: number; revenueCents: number }[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(code)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })

  if (res.status === 204) return undefined as T

  let payload: unknown = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    const code =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `http_${res.status}`
    throw new ApiError(res.status, code, payload)
  }
  return payload as T
}

export const api = {
  me: () => request<Me>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  menu: () => request<MenuCategory[]>('GET', '/api/menu'),

  categories: (includeInactive = false) =>
    request<Category[]>('GET', `/api/categories?includeInactive=${includeInactive}`),
  createCategory: (name: string, sortOrder = 0) =>
    request<Category>('POST', '/api/categories', { name, sortOrder }),
  updateCategory: (id: number, patch: Partial<Pick<Category, 'name' | 'sortOrder' | 'active'>>) =>
    request<Category>('PATCH', `/api/categories/${id}`, patch),
  deleteCategory: (id: number) => request<{ ok: true }>('DELETE', `/api/categories/${id}`),

  products: (includeInactive = false) =>
    request<Product[]>('GET', `/api/products?includeInactive=${includeInactive}`),
  createProduct: (input: { name: string; priceCents: number; categoryId: number }) =>
    request<Product>('POST', '/api/products', input),
  updateProduct: (
    id: number,
    patch: Partial<Pick<Product, 'name' | 'priceCents' | 'categoryId' | 'sortOrder' | 'active'>>,
  ) => request<Product>('PATCH', `/api/products/${id}`, patch),
  deleteProduct: (id: number) => request<{ ok: true }>('DELETE', `/api/products/${id}`),

  createOrder: (input: {
    tableLabel?: string
    note?: string
    items: { productId: number; qty: number; note?: string }[]
  }) => request<OrderDetail>('POST', '/api/orders', input),
  orders: (day?: string) =>
    request<{ serviceDay: string; orders: OrderSummary[] }>(
      'GET',
      day ? `/api/orders?day=${day}` : '/api/orders',
    ),
  order: (id: number) => request<OrderDetail>('GET', `/api/orders/${id}`),
  reprint: (id: number) => request<{ ok: true; printedAt: number }>('POST', `/api/orders/${id}/print`),
  receiptUrl: (id: number) => `/api/orders/${id}/receipt.pdf`,
  kitchenPdfUrl: (id: number) => `/api/orders/${id}/kitchen.pdf`,

  reportDays: () =>
    request<{ serviceDay: string; ordersCount: number; revenueCents: number }[]>(
      'GET',
      '/api/reports/days',
    ),
  dailyReport: (day?: string) =>
    request<DailyReport>('GET', day ? `/api/reports/daily?day=${day}` : '/api/reports/daily'),
  dailyCsvUrl: (day: string) => `/api/reports/daily.csv?day=${day}`,

  users: () => request<User[]>('GET', '/api/users'),
  createUser: (input: { username: string; password: string; displayName: string; role: Role }) =>
    request<User>('POST', '/api/users', input),
  updateUser: (
    id: number,
    patch: Partial<{ displayName: string; password: string; role: Role; active: boolean }>,
  ) => request<User>('PATCH', `/api/users/${id}`, patch),
}

// Set by the language provider so amounts follow the UI language (12,50 vs 12.50).
let moneyLocale = 'it-IT'
export function setMoneyLocale(locale: string) {
  moneyLocale = locale
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat(moneyLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/** Accepts "12", "12.5", "12,50" — returns cents, or null if unparseable. */
export function parseMoney(input: string): number | null {
  const normalized = input.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  return Math.round(Number(normalized) * 100)
}
