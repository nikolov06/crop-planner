import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured } from './lib/supabase'
import Login from './Login'
import Rotation from './pages/Rotation'
import Nomenclatures from './pages/Nomenclatures'
import SeedPlanning from './pages/SeedPlanning'
import PrzPlanning from './pages/PrzPlanning'
import FertPlanning from './pages/FertPlanning'
import TillagePlanning from './pages/TillagePlanning'

type PageKey = 'rotation' | 'seeds' | 'tillage' | 'fert' | 'prz' | 'nomenclatures'

const NAV: { key: PageKey; label: string; sepBefore?: boolean }[] = [
  { key: 'rotation', label: 'Сеитбооборот' },
  { key: 'tillage', label: 'Почвообработка' },
  { key: 'seeds', label: 'Планиране семена' },
  { key: 'fert', label: 'Планиране торове' },
  { key: 'prz', label: 'Продукти за растителна защита' },
  { key: 'nomenclatures', label: 'Номенклатури', sepBefore: true },
]

function pageFromHash(): PageKey {
  const k = window.location.hash.replace('#/', '') as PageKey
  return NAV.some((n) => n.key === k) ? k : 'rotation'
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageKey>(pageFromHash())

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!configured) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>Crop Planner</h1>
          <div className="banner err">
            Липсват или са невалидни настройките за връзка с базата (<code>VITE_SUPABASE_URL</code> и{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>). Локално ги задай в <code>web/.env.local</code> по образеца{' '}
            <code>.env.example</code>; във Vercel — в Environment Variables и направи Redeploy.
          </div>
        </div>
      </div>
    )
  }
  if (!ready) return null
  if (!session) return <Login />

  const go = (k: PageKey) => {
    window.location.hash = `#/${k}`
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Основна навигация">
        <div className="brand">Crop Planner</div>
        {NAV.map((n) => (
          <div key={n.key} style={{ display: 'contents' }}>
            {n.sepBefore && <div className="nav-sep" />}
            <button
              className="nav-item"
              aria-current={page === n.key ? 'page' : undefined}
              onClick={() => go(n.key)}
            >
              {n.label}
            </button>
          </div>
        ))}
        <div className="nav-spacer" />
        <div className="nav-user">{session.user.email}</div>
        <button className="nav-item" onClick={() => supabase.auth.signOut()}>
          Изход
        </button>
      </nav>
      <main className="content">
        {page === 'rotation' && <Rotation />}
        {page === 'seeds' && <SeedPlanning />}
        {page === 'tillage' && <TillagePlanning />}
        {page === 'fert' && <FertPlanning />}
        {page === 'prz' && <PrzPlanning />}
        {page === 'nomenclatures' && <Nomenclatures />}
      </main>
    </div>
  )
}
