import { useState } from 'react'
import { supabase } from './lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(`Грешка при вход: ${error.message}`)
    setBusy(false)
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Crop Planner</h1>
        <label className="field" style={{ flex: 'none' }}>
          Имейл
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 'none' }}>
          Парола
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="banner err" role="alert">{error}</div>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Влизане…' : 'Вход'}
        </button>
      </form>
    </div>
  )
}
