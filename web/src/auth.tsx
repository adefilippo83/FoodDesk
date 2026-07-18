import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, type Me } from './api'

type AuthState = {
  user: Me | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((err) => {
        // 401 just means "not signed in yet" — not an error worth surfacing.
        if (!(err instanceof ApiError && err.status === 401)) console.error(err)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setUser(await api.login(username, password))
  }, [])

  const logout = useCallback(async () => {
    await api.logout()
    setUser(null)
  }, [])

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
