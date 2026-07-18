import { useState, type FormEvent } from 'react'
import { ApiError } from '../api'
import { useAuth } from '../auth'

export default function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? 'Wrong username or password.'
          : 'Could not reach the server. Check the Wi-Fi connection.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <div className="logo">
          Food<span>Desk</span>
        </div>
        <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
          Sign in to take orders.
        </p>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Username</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
