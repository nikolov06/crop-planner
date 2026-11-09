import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && anon)

// Ако липсват настройките, приложението показва обяснение вместо празна страница.
export const supabase = createClient(url || 'http://localhost', anon || 'missing-key')
