import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

// Diagnóstico: prueba un write directo a app_config y verifica que persiste.
// Útil para descartar problemas de RLS / service role.
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Solo admin' }, { status: 403 })
  }

  const service = createServiceSupabaseClient()
  const testKey   = '__diag_write_test'
  const testValue = `ok-${Date.now()}`

  // Estado del service role key (sin exponerlo)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''

  // Leer estado actual de ai_provider
  const { data: currentAiProvider, error: readErr } = await service
    .from('app_config').select('value, updated_at').eq('key', 'ai_provider').maybeSingle()

  // Intentar escribir una clave de prueba
  const { error: writeErr } = await service.from('app_config').upsert(
    { key: testKey, value: testValue, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )

  // Releer la clave de prueba para confirmar que persistió
  const { data: readBack } = await service
    .from('app_config').select('value').eq('key', testKey).maybeSingle()

  // Limpiar la clave de prueba
  await service.from('app_config').delete().eq('key', testKey)

  return NextResponse.json({
    env: {
      hasServiceKey: serviceKey.length > 0,
      serviceKeyLength: serviceKey.length,
      serviceKeyLast4: serviceKey.slice(-4),
      supabaseUrl: supabaseUrl,
    },
    currentAiProvider: {
      value: currentAiProvider?.value ?? null,
      updated_at: currentAiProvider?.updated_at ?? null,
      readError: readErr ? { message: readErr.message, code: readErr.code } : null,
    },
    writeTest: {
      ok: !writeErr && readBack?.value === testValue,
      writeError: writeErr ? { message: writeErr.message, code: writeErr.code, details: writeErr.details, hint: writeErr.hint } : null,
      expectedValue: testValue,
      actualValue: readBack?.value ?? null,
    },
  })
}
