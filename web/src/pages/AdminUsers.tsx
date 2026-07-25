import { useEffect, useState } from 'react'
import { ApiError, api, type Role, type User } from '../api'
import { useAuth } from '../auth'
import { useI18n } from '../i18n'

export default function AdminUsers() {
  const { user: me } = useAuth()
  const { t } = useI18n()
  const isMaitre = me?.role === 'maitre'
  // A maître only manages waiters; the server enforces the same rule.
  const canManage = (u: User) => me?.role === 'admin' || u.role === 'operator'
  const roleLabel = (r: Role) =>
    r === 'admin'
      ? t('roleAdmin')
      : r === 'maitre'
        ? t('roleMaitre')
        : r === 'kitchen'
          ? t('roleKitchen')
          : t('roleWaiter')
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [resetting, setResetting] = useState<number | null>(null)
  const [resetValue, setResetValue] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  async function load() {
    try {
      setUsers(await api.users())
      setError(null)
    } catch {
      setError(t('errLoadStaff'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function add() {
    if (!username.trim()) return setError(t('errUsernameRequired'))
    if (password.length < 8) return setError(t('errPasswordShort'))
    try {
      await api.createUser({
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        role,
      })
      setUsername('')
      setDisplayName('')
      setPassword('')
      setError(null)
      await load()
      // The top bar listens: a first kitchen account switches its link on.
      window.dispatchEvent(new Event('fd-users-changed'))
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username_taken'
          ? t('errUsernameTaken')
          : t('errCreateAccount'),
      )
    }
  }

  async function commitReset(id: number) {
    if (resetValue.length < 8) return setError(t('errPasswordShort'))
    try {
      await api.updateUser(id, { password: resetValue })
      setError(null)
      setToast(t('passwordReset'))
      setTimeout(() => setToast(null), 2000)
    } catch {
      setError(t('errUpdateAccount'))
    } finally {
      setResetting(null)
      setResetValue('')
    }
  }

  async function setActive(u: User, active: boolean) {
    try {
      await api.updateUser(u.id, { active })
      setError(null)
      await load()
      window.dispatchEvent(new Event('fd-users-changed'))
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'last_admin'
          ? t('errLastAdmin')
          : t('errUpdateAccount'),
      )
    }
  }

  if (loading) return <div className="empty">{t('loading')}</div>

  return (
    <>
      <h1>{t('navStaff')}</h1>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t('addSomeone')}</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            placeholder={t('usernamePlaceholder')}
            autoCapitalize="none"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            placeholder={t('displayNamePlaceholder')}
            autoComplete="off"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            type="password"
            placeholder={t('passwordPlaceholder')}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!isMaitre && (
            <select
              className="input"
              style={{ flex: '0 1 150px', width: 'auto' }}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="operator">{t('optionWaiter')}</option>
              <option value="kitchen">{t('optionKitchen')}</option>
              <option value="maitre">{t('optionMaitre')}</option>
              <option value="admin">{t('optionAdmin')}</option>
            </select>
          )}
          <button className="btn primary" onClick={() => void add()}>
            {t('add')}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          {t('staffHint')}
        </p>
      </div>

      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('username')}</th>
              <th>{t('role')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'inactive'}>
                <td>
                  {u.displayName}
                  {u.id === me?.id && <span className="muted"> {t('you')}</span>}
                </td>
                <td className="muted">{u.username}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'admin' : ''}`}>
                    {roleLabel(u.role)}
                  </span>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {!canManage(u) ? null : resetting === u.id ? (
                    <span className="row" style={{ display: 'inline-flex', gap: 6 }}>
                      <input
                        className="input"
                        style={{ minHeight: 36, width: 170 }}
                        type="password"
                        autoFocus
                        autoComplete="new-password"
                        placeholder={t('newPassword')}
                        value={resetValue}
                        onChange={(e) => setResetValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitReset(u.id)
                          if (e.key === 'Escape') setResetting(null)
                        }}
                      />
                      <button className="btn small primary" onClick={() => void commitReset(u.id)}>
                        {t('save')}
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn small"
                      onClick={() => {
                        setResetting(u.id)
                        setResetValue('')
                      }}
                    >
                      {t('resetPassword')}
                    </button>
                  )}{' '}
                  {canManage(u) &&
                    (u.active ? (
                      <button
                        className="btn small danger"
                        disabled={u.id === me?.id}
                        title={u.id === me?.id ? t('cantDisableSelf') : undefined}
                        onClick={() => void setActive(u, false)}
                      >
                        {t('disable')}
                      </button>
                    ) : (
                      <button className="btn small" onClick={() => void setActive(u, true)}>
                        {t('enable')}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
