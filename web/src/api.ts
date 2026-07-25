export type Role = 'admin' | 'maitre' | 'operator' | 'kitchen'

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
  customerName: string | null
  covers: number
  cancelledAt: number | null
  cancelledByName: string | null
  completedAt: number | null
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
export type OrderDetail = OrderSummary & { items: OrderItem[]; coverChargeCents: number }

export type KitchenItem = {
  id: number
  qty: number
  name: string
  category: string
  note: string | null
  doneAt: number | null
}
export type KitchenOrder = {
  id: number
  dailyNumber: number
  customerName: string | null
  covers: number
  note: string | null
  createdAt: number
  completedAt: number | null
  createdByName: string
  items: KitchenItem[]
}

export type CategoryStyle = 'alternating' | 'separator'

export type OrderSheetLayout = {
  orderHeaderText: string
  orderHeaderImage: string
  orderFooterText: string
  orderFooterImage: string
  orderDisclaimer: string
  orderCategoryStyle: CategoryStyle
  orderHeaderFontSize: number
  orderFooterFontSize: number
  orderDisclaimerFontSize: number
  orderHeaderImageWidthPct: number
  orderFooterImageWidthPct: number
}

export type AppConfig = OrderSheetLayout & {
  restaurantName: string
  coverChargeCents: number
  printerConfigured: boolean
}

export type PaperSize = 'roll80' | 'a5' | 'a4' | 'letter'

export type AppSettings = OrderSheetLayout & {
  restaurantName: string
  coverChargeCents: number
  paperSize: PaperSize
  pdfLang: 'it' | 'en' | 'es' | 'fr' | 'pt'
  headerText: string
  footerText: string
  logoImage: string
  backgroundImage: string
}
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
  cancelledCount: number
  revenueCents: number
  totalCovers: number
  coverRevenueCents: number
  avgPerCoverCents: number | null
  byProduct: { name: string; qty: number; revenueCents: number }[]
  byCategory: { name: string; qty: number; revenueCents: number }[]
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
    customerName: string
    covers: number
    note?: string
    items: { productId: number; qty: number; note?: string }[]
  }) => request<OrderDetail>('POST', '/api/orders', input),
  cancelOrder: (id: number) => request<OrderSummary>('POST', `/api/orders/${id}/cancel`),
  orders: (day?: string) =>
    request<{ serviceDay: string; orders: OrderSummary[] }>(
      'GET',
      day ? `/api/orders?day=${day}` : '/api/orders',
    ),
  order: (id: number) => request<OrderDetail>('GET', `/api/orders/${id}`),
  reprint: (id: number) => request<{ ok: true; printedAt: number }>('POST', `/api/orders/${id}/print`),
  kitchenOrders: () =>
    request<{ serviceDay: string; orders: KitchenOrder[] }>('GET', '/api/kitchen/orders'),
  setItemDone: (id: number, done: boolean) =>
    request<{ doneAt: number | null; orderCompleted: boolean }>('PUT', `/api/kitchen/items/${id}`, {
      done,
    }),
  config: () => request<AppConfig>('GET', '/api/config'),
  features: () => request<{ kitchenEnabled: boolean }>('GET', '/api/features'),
  settings: () => request<AppSettings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => request<AppSettings>('PUT', '/api/settings', patch),
  settingsPreviewUrl: (kind: 'receipt' | 'order' = 'receipt') =>
    `/api/settings/preview.pdf?kind=${kind}&ts=${Date.now()}`,
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  reorderCategories: (ids: number[]) => request<{ ok: true }>('PUT', '/api/categories/order', { ids }),
  reorderProducts: (ids: number[]) => request<{ ok: true }>('PUT', '/api/products/order', { ids }),
  receiptUrl: (id: number) => `/api/orders/${id}/receipt.pdf`,
  kitchenPdfUrl: (id: number) => `/api/orders/${id}/kitchen.pdf`,
  orderPdfUrl: (id: number) => `/api/orders/${id}/order.pdf`,

  reportDays: () =>
    request<{ serviceDay: string; ordersCount: number; revenueCents: number }[]>(
      'GET',
      '/api/reports/days',
    ),
  dailyReport: (day?: string) =>
    request<DailyReport>('GET', day ? `/api/reports/daily?day=${day}` : '/api/reports/daily'),
  dailyCsvUrl: (day: string) => `/api/reports/daily.csv?day=${day}`,
  dailyPdfUrl: (day: string) => `/api/reports/daily.pdf?day=${day}`,

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
