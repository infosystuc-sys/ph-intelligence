import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { analyzeConversation } from '@/lib/ai-analyzer'

// Condiciones de análisis automático
const MIN_MESSAGES        = 5           // mínimo para un análisis significativo
const MAX_DAYS_INACTIVE   = 7           // ignorar conversaciones sin actividad > 7 días
const COOLDOWN_AUTO_HOURS = 2           // mínimo entre dos análisis automáticos de la misma conv.
const COOLDOWN_MIN_MINUTES = 30         // mínimo entre cualquier análisis (manual o auto)

export async function POST() {
  try {
    // Verificar sesión activa (cualquier rol puede disparar el auto-análisis)
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ analyzed: false, reason: 'No autorizado' }, { status: 401 })
    }

    const service = createServiceSupabaseClient()
    const now = new Date()

    const twoHoursAgo      = new Date(now.getTime() - COOLDOWN_AUTO_HOURS * 60 * 60 * 1000).toISOString()
    const sevenDaysAgo     = new Date(now.getTime() - MAX_DAYS_INACTIVE * 24 * 60 * 60 * 1000).toISOString()
    const thirtyMinutesAgo = new Date(now.getTime() - COOLDOWN_MIN_MINUTES * 60 * 1000).toISOString()

    // Candidatas: activas, con suficientes mensajes, con actividad reciente,
    // y que no hayan sido auto-analizadas en las últimas 2 horas.
    const { data: candidates, error } = await service
      .from('conversations')
      .select(`
        id,
        last_message_at,
        last_auto_analysis_at,
        ai_analyses ( analyzed_at )
      `)
      .eq('status', 'active')
      .gte('message_count', MIN_MESSAGES)
      .gte('last_message_at', sevenDaysAgo)
      .or(`last_auto_analysis_at.is.null,last_auto_analysis_at.lt.${twoHoursAgo}`)
      .order('last_message_at', { ascending: false })
      .limit(20)

    if (error) {
      console.error('[AutoAnalysis] Error consultando candidatas:', error)
      return NextResponse.json({ analyzed: false, reason: 'Error interno al consultar' }, { status: 500 })
    }

    if (!candidates?.length) {
      return NextResponse.json({ analyzed: false, reason: 'No hay conversaciones pendientes' })
    }

    // Elegir la primera que tenga mensajes nuevos desde el último análisis
    // y que respete el cooldown mínimo de 30 minutos entre cualquier análisis.
    type Candidate = {
      id: string
      last_message_at: string | null
      last_auto_analysis_at: string | null
      ai_analyses: Array<{ analyzed_at: string }> | null
    }

    const candidate = (candidates as Candidate[]).find(conv => {
      const analyses = conv.ai_analyses ?? []
      const lastAnalyzedAt = analyses.length
        ? analyses.reduce((latest, a) =>
            a.analyzed_at > latest ? a.analyzed_at : latest, '')
        : null

      // Sin análisis previo → siempre candidata
      if (!lastAnalyzedAt) return true

      // Respetar cooldown mínimo de 30 minutos
      if (lastAnalyzedAt > thirtyMinutesAgo) return false

      // Solo si hay mensajes nuevos desde el último análisis
      return !!conv.last_message_at && conv.last_message_at > lastAnalyzedAt
    })

    if (!candidate) {
      return NextResponse.json({
        analyzed: false,
        reason: 'Todas las conversaciones ya están al día',
      })
    }

    // Marcar inmediatamente como "en análisis" para evitar que
    // dos llamadas concurrentes procesen la misma conversación.
    await service
      .from('conversations')
      .update({ last_auto_analysis_at: now.toISOString() })
      .eq('id', candidate.id)

    // Ejecutar el análisis (usa el proveedor IA activo: Gemini o Claude)
    const result = await analyzeConversation(candidate.id, 'auto')

    if (!result.success) {
      console.error('[AutoAnalysis] Falló el análisis:', result.error)
      return NextResponse.json({
        analyzed: false,
        conversationId: candidate.id,
        reason: result.error,
      })
    }

    console.log(`[AutoAnalysis] ✓ Conversación ${candidate.id} → análisis ${result.analysisId}`)

    return NextResponse.json({
      analyzed: true,
      conversationId: candidate.id,
      analysisId: result.analysisId,
    })
  } catch (error) {
    console.error('[AutoAnalysis] Error inesperado:', error)
    return NextResponse.json({ analyzed: false, reason: 'Error interno' }, { status: 500 })
  }
}
