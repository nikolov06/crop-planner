import { Suspense, lazy, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured } from './lib/supabase'
import Login from './Login'
import Rotation from './pages/Rotation'
import Nomenclatures from './pages/Nomenclatures'
import SeedPlanning from './pages/SeedPlanning'
import PrzPlanning from './pages/PrzPlanning'
import FertPlanning from './pages/FertPlanning'
import Offers from './pages/Offers'
import Recap from './pages/Recap'
// Картите (Leaflet, shpjs) се зареждат отделно, само при отваряне.
const MapPage = lazy(() => import('./pages/MapPage'))
const Geometries = lazy(() => import('./pages/Geometries'))

type PageKey = 'rotation' | 'seeds' | 'fert' | 'fert-offers' | 'fert-recap' | 'prz' | 'prz-offers' | 'prz-recap' | 'map' | 'geometries' | 'nomenclatures'

type NavItem = { key: PageKey; label: string }
type NavEntry = { sepBefore?: boolean } & ({ key: PageKey; label: string } | { group: string; label: string; children: NavItem[] })

// Менюто е на две нива: модул → екрани (Планиране, Оферти, Рекапитулация)
const NAV: NavEntry[] = [
  { key: 'rotation', label: 'Сеитбооборот' },
  { key: 'seeds', label: 'Планиране семена' },
  { group: 'fert', label: 'Торове', children: [{ key: 'fert', label: 'Планиране' }, { key: 'fert-offers', label: 'Оферти' }, { key: 'fert-recap', label: 'Рекапитулация' }] },
  { group: 'prz', label: 'Растителна защита', children: [{ key: 'prz', label: 'Планиране' }, { key: 'prz-offers', label: 'Оферти' }, { key: 'prz-recap', label: 'Рекапитулация' }] },
  { group: 'map', label: 'Карта', children: [{ key: 'map', label: 'Карта' }, { key: 'geometries', label: 'Геометрии' }] },
  { key: 'nomenclatures', label: 'Номенклатури', sepBefore: true },
]

const PAGES: PageKey[] = NAV.flatMap((n) => ('children' in n ? n.children.map((c) => c.key) : [n.key]))

function pageFromHash(): PageKey {
  // #/rotation?q=… — след „?“ са параметри на страницата (напр. търсене), не част от ключа
  const k = window.location.hash.replace('#/', '').split('?')[0] as PageKey
  return PAGES.includes(k) ? k : 'rotation'
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageKey>(pageFromHash())
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

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
        {NAV.map((n) => {
          if ('children' in n) {
            const active = n.children.some((c) => c.key === page)
            const open = openGroups[n.group] ?? active
            return (
              <div key={n.group} style={{ display: 'contents' }}>
                {n.sepBefore && <div className="nav-sep" />}
                <button
                  className="nav-item nav-group"
                  aria-expanded={open}
                  data-active={active ? 'true' : undefined}
                  onClick={() => setOpenGroups((g) => ({ ...g, [n.group]: !open }))}
                >
                  <span>{n.label}</span>
                  <span className="nav-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                </button>
                {open &&
                  n.children.map((c) => (
                    <button
                      key={c.key}
                      className="nav-item nav-sub"
                      aria-current={page === c.key ? 'page' : undefined}
                      onClick={() => go(c.key)}
                    >
                      {c.label}
                    </button>
                  ))}
              </div>
            )
          }
          return (
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
          )
        })}
        <div className="nav-spacer" />
        <div className="nav-user">{session.user.email}</div>
        <button className="nav-item" onClick={() => supabase.auth.signOut()}>
          Изход
        </button>
      </nav>
      <main className="content">
        {page === 'rotation' && <Rotation />}
        {page === 'seeds' && <SeedPlanning />}
        {page === 'fert' && <FertPlanning />}
        {page === 'prz' && <PrzPlanning />}
        {page === 'fert-offers' && <Offers module="fert" />}
        {page === 'prz-offers' && <Offers module="prz" />}
        {page === 'fert-recap' && <Recap module="fert" />}
        {page === 'prz-recap' && <Recap module="prz" />}
        {(page === 'map' || page === 'geometries') && (
          <Suspense fallback={<span className="muted">Зареждане на картата…</span>}>
            {page === 'map' ? <MapPage /> : <Geometries />}
          </Suspense>
        )}
        {page === 'nomenclatures' && <Nomenclatures />}
      </main>
    </div>
  )
}
