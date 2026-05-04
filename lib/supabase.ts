import { createBrowserClient } from '@supabase/ssr'

function requirePublicEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_ANON_KEY', value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Falta ${name}. Creá .env.local en la raíz del proyecto con esa variable, reiniciá el servidor (npm run dev) y volvé a intentar.`
    )
  }
  return value.trim()
}

// ── Cliente del Navegador (Client Components únicamente) ─────────────────────
// Este archivo NO importa next/headers — es seguro usarlo en Client Components
export function createBrowserSupabaseClient() {
  const supabaseUrl = requirePublicEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
  const supabaseAnonKey = requirePublicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}
