import { useEffect, useState } from 'react'
import { ApiError, api, type Role, type User } from '../api'
import { useAuth } from '../auth'

export default function AdminUsers() {
  const { user: me } = useAuth()
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
      setError('Could not load staff.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function add() {
    if (!username.trim()) return setError('Username is required.')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
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
          ? 'That username is already taken.'
          : 'Could not create the account.',
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
          ? 'This is the last admin — promote someone else first.'
          : 'Could not update the account.',
      )
    }
  }

  if (loading) return <div className="empty">Loading…</div>

  return (
    <>
      <h1>Staff</h1>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Add someone</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            placeholder="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: '1 1 130px', width: 'auto' }}
            type="password"
            placeholder="password (8+ chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            className="input"
            style={{ flex: '0 1 130px', width: 'auto' }}
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="operator">Waiter</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn primary" onClick={() => void add()}>
            Add
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          Waiters can take and view their own orders. Admins can also change the menu, prices and
          staff.
        </p>
      </div>

      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'inactive'}>
                <td>
                  {u.displayName}
                  {u.id === me?.id && <span className="muted"> (you)</span>}
                </td>
                <td className="muted">{u.username}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'admin' : ''}`}>
                    {u.role === 'admin' ? 'admin' : 'waiter'}
                  </span>
                </td>
                <td className="num">
                  {u.active ? (
                    <button
                      className="btn small danger"
                      disabled={u.id === me?.id}
                      title={u.id === me?.id ? 'You cannot disable your own account' : undefined}
                      onClick={() => void setActive(u, false)}
                    >
                      Disable
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => void setActive(u, true)}>
                      Enable
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
