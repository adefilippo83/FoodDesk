import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import Login from './pages/Login'
import NewOrder from './pages/NewOrder'
import Orders from './pages/Orders'
import AdminMenu from './pages/AdminMenu'
import AdminUsers from './pages/AdminUsers'
import type { ReactNode } from 'react'

/**
 * Route guards here are a convenience so operators are not shown doors they
 * cannot open. They are not the security boundary — the server is.
 */
function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />
}

export default function App() {
  const { user, loading, logout } = useAuth()

  if (loading) return <div className="empty">Loading…</div>
  if (!user) return <Login />

  const isAdmin = user.role === 'admin'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Food<span>Desk</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            New order
          </NavLink>
          <NavLink to="/orders" className={({ isActive }) => (isActive ? 'active' : '')}>
            Orders
          </NavLink>
          {isAdmin && (
            <>
              <NavLink to="/menu" className={({ isActive }) => (isActive ? 'active' : '')}>
                Menu
              </NavLink>
              <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
                Staff
              </NavLink>
            </>
          )}
        </nav>
        <div className="who">
          <strong>{user.displayName}</strong>
          {isAdmin ? 'admin' : 'waiter'}
        </div>
        <button className="btn small" onClick={() => void logout()}>
          Sign out
        </button>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<NewOrder />} />
          <Route path="/orders" element={<Orders />} />
          <Route
            path="/menu"
            element={
              <AdminOnly>
                <AdminMenu />
              </AdminOnly>
            }
          />
          <Route
            path="/users"
            element={
              <AdminOnly>
                <AdminUsers />
              </AdminOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
