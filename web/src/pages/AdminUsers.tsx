import { useEffect, useState } from 'react'
import { ApiError, api, type Role, type User } from '../api'
import { useAuth } from '../auth'
import { useI18n } from '../i18n'

export default function AdminUsers() {
  const { user: me } = useAuth()
  const { t } = useI18n()
  const [users, setUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('operator')

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
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username_taken'
          ? t('errUsernameTaken')
          : t('errCreateAccount'),
      )
    }
  }

  async function setActive(u: User, active: boolean) {
    try {
      await api.updateUser(u.id, { active })
      setError(null)
      await load()
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
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            placeholder={t('displayNamePlaceholder')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            type="password"
            placeholder={t('passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            className="input"
            style={{ flex: '0 1 150px', width: 'auto' }}
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="operator">{t('optionWaiter')}</option>
            <option value="admin">{t('optionAdmin')}</option>
          </select>
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
                    {u.role === 'admin' ? t('roleAdmin') : t('roleWaiter')}
                  </span>
                </td>
                <td className="num">
                  {u.active ? (
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
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
