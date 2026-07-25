import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import { LangToggle, useI18n } from './i18n'
import Kitchen from './pages/Kitchen'
import Login from './pages/Login'
import NewOrder from './pages/NewOrder'
import Orders from './pages/Orders'
import AdminMenu from './pages/AdminMenu'
import AdminUsers from './pages/AdminUsers'
import Reports from './pages/Reports'
import Settings from './pages/Settings'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, api } from './api'

/**
 * Route guards here are a convenience so operators are not shown doors they
 * cannot open. They are not the security boundary — the server is.
 */
function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />
}

/** Admin or maître d' (caposala). */
function ManagerOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === 'admin' || user?.role === 'maitre' ? (
    <>{children}</>
  ) : (
    <Navigate to="/" replace />
  )
}

/** The kitchen display: kitchen accounts, plus admin and maître d'. */
function KitchenAccess({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === 'admin' || user?.role === 'maitre' || user?.role === 'kitchen' ? (
    <>{children}</>
  ) : (
    <Navigate to="/" replace />
  )
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < 8) return setError(t('errPasswordShort'))
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(current, next)
      setDone(true)
      setTimeout(onClose, 1200)
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'wrong_password'
          ? t('errWrongCurrentPassword')
          : t('errChangePassword'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <form
        className="card"
        style={{ width: '100%', maxWidth: 360 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{t('changePassword')}</h2>
        {error && <div className="error">{error}</div>}
        {done ? (
          <p>{t('passwordChanged')}</p>
        ) : (
          <>
            <label className="field">
              <span>{t('currentPassword')}</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>{t('newPassword')}</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </label>
            <div className="row">
              <button className="btn primary" style={{ flex: 1 }} disabled={busy}>
                {t('save')}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                {t('cancel')}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

export default function App() {
  const { user, loading, logout } = useAuth()
  const { t } = useI18n()
  const [showPassword, setShowPassword] = useState(false)
  const [kitchenEnabled, setKitchenEnabled] = useState(false)

  const managerRole = user?.role === 'admin' || user?.role === 'maitre'

  // The Kitchen entry exists only while an active kitchen account does.
  // AdminUsers fires 'fd-users-changed' so the link appears/disappears live.
  useEffect(() => {
    if (!managerRole) return
    const refresh = () =>
      void api
        .features()
        .then((f) => setKitchenEnabled(f.kitchenEnabled))
        .catch(() => {})
    refresh()
    window.addEventListener('fd-users-changed', refresh)
    return () => window.removeEventListener('fd-users-changed', refresh)
  }, [managerRole])

  if (loading) return <div className="empty">{t('loading')}</div>
  if (!user) return <Login />

  const isAdmin = user.role === 'admin'
  const isManager = isAdmin || user.role === 'maitre'
  const isKitchen = user.role === 'kitchen'
  const roleLabel = isAdmin
    ? t('roleAdmin')
    : user.role === 'maitre'
      ? t('roleMaitre')
      : isKitchen
        ? t('roleKitchen')
        : t('roleWaiter')

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Food<span>Desk</span>
        </div>
        <nav className="nav">
          {!isKitchen && (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
                {t('navNewOrder')}
              </NavLink>
              <NavLink to="/orders" className={({ isActive }) => (isActive ? 'active' : '')}>
                {t('navOrders')}
              </NavLink>
            </>
          )}
          {(isKitchen || (isManager && kitchenEnabled)) && (
            <NavLink to="/kitchen" className={({ isActive }) => (isActive ? 'active' : '')}>
              {t('navKitchen')}
            </NavLink>
          )}
          {isManager && (
            <>
              <NavLink to="/menu" className={({ isActive }) => (isActive ? 'active' : '')}>
                {t('navMenu')}
              </NavLink>
              <NavLink to="/users" className={({ isActive }) => (isActive ? 'active' : '')}>
                {t('navStaff')}
              </NavLink>
              <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
                {t('navReports')}
              </NavLink>
            </>
          )}
          {isAdmin && (
            <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
              {t('navSettings')}
            </NavLink>
          )}
        </nav>
        <button
          className="who"
          style={{ background: 'none', border: 0, cursor: 'pointer', textAlign: 'right' }}
          title={t('changePassword')}
          onClick={() => setShowPassword(true)}
        >
          <strong>{user.displayName}</strong>
          {roleLabel}
        </button>
        <LangToggle />
        <button className="btn small" onClick={() => void logout()}>
          {t('signOut')}
        </button>
      </header>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}

      <main>
        <Routes>
          <Route path="/" element={isKitchen ? <Navigate to="/kitchen" replace /> : <NewOrder />} />
          <Route path="/orders" element={<Orders />} />
          <Route
            path="/kitchen"
            element={
              <KitchenAccess>
                <Kitchen />
              </KitchenAccess>
            }
          />
          <Route
            path="/menu"
            element={
              <ManagerOnly>
                <AdminMenu />
              </ManagerOnly>
            }
          />
          <Route
            path="/users"
            element={
              <ManagerOnly>
                <AdminUsers />
              </ManagerOnly>
            }
          />
          <Route
            path="/reports"
            element={
              <ManagerOnly>
                <Reports />
              </ManagerOnly>
            }
          />
          <Route
            path="/settings"
            element={
              <AdminOnly>
                <Settings />
              </AdminOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
