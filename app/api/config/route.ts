import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { getActiveProvider, setActiveProvider, AIProvider, isAIProvider } from '@/lib/ai-providers'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [provider, autoAnalysisEnabled] = await Promise.all([
      getActiveProvider(),
      getAutoAnalysisEnabled(),
    ])
    return NextResponse.json({ ai_provider: provider, auto_analysis_enabled: autoAnalysisEnabled })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden cambiar la configuración' }, { status: 403 })
    }

    const body = await req.json() as { ai_provider?: AIProvider; auto_analysis_enabled?: boolean }

    if (body.ai_provider !== undefined) {
      if (!isAIProvider(body.ai_provider)) {
        return NextResponse.json({ error: 'Proveedor inválido' }, { status: 400 })
      }
      await setActiveProvider(body.ai_provider)
    }

    if (body.auto_analysis_enabled !== undefined) {
      await setAutoAnalysisEnabled(body.auto_analysis_enabled)
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error interno'
    console.error('[PATCH /api/config] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function getAutoAnalysisEnabled(): Promise<boolean> {
  try {
    const service = createServiceSupabaseClient()
    const { data } = await service
      .from('app_config')
      .select('value')
      .eq('key', 'auto_analysis_enabled')
      .single()
    return data?.value !== 'false'
  } catch {
    return true // default activo si no hay registro
  }
}

async function setAutoAnalysisEnabled(enabled: boolean): Promise<void> {
  const service = createServiceSupabaseClient()
  const { error } = await service.from('app_config').upsert(
    { key: 'auto_analysis_enabled', value: String(enabled), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  if (error) throw new Error(`Error al guardar auto_analysis_enabled: ${error.message}`)
}
