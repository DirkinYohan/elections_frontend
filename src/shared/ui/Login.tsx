import { useState, type FormEvent } from 'react'
import type { Session, UserRole } from '../contracts/messages'
import { login } from '../api/auth'

interface LoginProps {
  title: string
  subtitle: string
  role: UserRole
  demoUsers: string[]
  onLogin: (session: Session) => void
}

export function Login({ title, subtitle, role, demoUsers, onLogin }: LoginProps) {
  const [username, setUsername] = useState(demoUsers[0] ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await login(username.trim(), password, role))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login card stack">
      <div>
        <h1>{title}</h1>
        <p className="muted" style={{ margin: 0 }}>{subtitle}</p>
      </div>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Usuario</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>Contraseña</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
      <p className="hint" style={{ margin: 0 }}>
        Cuentas de demostración: {demoUsers.join(', ')} · contraseña <span className="mono">pass123</span>
      </p>
    </main>
  )
}
