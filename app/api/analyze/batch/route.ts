import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { analyzeConversation } from '@/lib/ai-analyzer'

export const maxDuration = 60

// Pausa entre análisis para no saturar la API de IA
const DELAY_MS = 3500

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'supervisor'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const limit     = Math.min(parseInt(body.limit ?? '10'), 15)
    const vendorId  = body.vendorId ?? null
    const minHours  = parseInt(body.minHours ?? '6')      // cooldown entre análisis

    const service = createServiceSupabaseClient()
    const since = new Date(Date.now() - minHours * 60 * 60 * 1000).toISOString()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Conversaciones activas con ≥5 mensajes, sin análisis reciente
    let query = service
      .from('conversations')
      .select('id, vendedor_id, message_count, last_message_at, ai_analyses:ai_analyses(analyzed_at)')
      .eq('status', 'active')
      .gte('message_count', 5)
      .gte('last_message_at', sevenDaysAgo)
      .order('last_message_at', { ascending: false })
      .limit(limit * 3) // traer más para poder filtrar las que ya tienen análisis reciente

    if (vendorId) query = query.eq('vendedor_id', vendorId)

    const { data: candidates, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    type CandRow = { id: string; vendedor_id: string; message_count: number; last_message_at: string | null; ai_analyses: Array<{ analyzed_at: string }> }

    const pending = ((candidates ?? []) as CandRow[]).filter(c => {
      const analyses = c.ai_analyses ?? []
      if (!analyses.length) return true
      const latest = analyses.reduce((a, b) => a.analyzed_at > b.analyzed_at ? a : b)
      return latest.analyzed_at < since
    }).slice(0, limit)

    if (!pending.length) {
      return NextResponse.json({ analyzed: 0, failed: 0, skipped: 0, message: 'No hay conversaciones pendientes de análisis' })
    }

    const results: { conversationId: string; success: boolean; analysisId?: string; error?: string }[] = []

    for (const conv of pending) {
      const result = await analyzeConversation(conv.id, 'manual')
      results.push({ conversationId: conv.id, success: result.success, analysisId: result.analysisId, error: result.error })

      // Pausa entre llamadas para respetar rate limits de la API de IA
      if (conv !== pending[pending.length - 1]) {
        await new Promise(r => setTimeout(r, DELAY_MS))
      }
    }

    const analyzed = results.filter(r => r.success).length
    const failed   = results.filter(r => !r.success).length

    return NextResponse.json({ analyzed, failed, skipped: pending.length - results.length, results })
  } catch (err) {
    console.error('Error en /api/analyze/batch:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
