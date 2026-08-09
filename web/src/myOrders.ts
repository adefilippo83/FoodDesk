/**
 * The customer's own orders, remembered on the device so a refresh or an
 * accidental tab close finds the way back to the status page.
 */
const KEY = 'fd_my_orders'

export type MyOrder = { token: string; dailyNumber: number; at: number }

export function myOrders(): MyOrder[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as MyOrder[]) : []
    // Only today's orders are interesting; prune anything older than a day.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return list.filter((o) => o.at > cutoff)
  } catch {
    return []
  }
}

export function rememberMyOrder(token: string, dailyNumber: number) {
  try {
    const list = myOrders().filter((o) => o.token !== token)
    list.push({ token, dailyNumber, at: Date.now() })
    localStorage.setItem(KEY, JSON.stringify(list.slice(-5)))
  } catch {
    // Private mode without storage: the status URL still works.
  }
}
