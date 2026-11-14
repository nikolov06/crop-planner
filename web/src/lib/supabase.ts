import { createClient } from '@supabase/supabase-js'

const rawUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

// Приема само валиден http(s) адрес; иначе createClient гърми и остава бял екран.
function validUrl(value: string): string | null {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

const url = validUrl(rawUrl)

export const configured = Boolean(url && anon)

// Ако липсват или са невалидни настройките, приложението показва обяснение вместо празна страница.
export const supabase = createClient(url ?? 'http://localhost', anon || 'missing-key')
