import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { analyzeConversation } from '@/lib/ai-analyzer'

const MIN_MESSAGES        = 5
const MAX_DAYS_INACTIVE   = 7
const COOLDOWN_AUTO_HOURS = 2
const COOLDOWN_MIN_MINUTES = 30

export async function POST() {
  try {
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

    // Conjunto de teléfonos de empleados: excluidos del análisis
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    // ── PRIORIDAD 1: sin ningún análisis previo, ordenadas por más antigua ────
    // Estas tienen prioridad absoluta: conversaciones que nunca fueron evaluadas.
    // Nota: .eq('status', 'active') ya excluye histórico, pending y closed.
    // El .neq adicional es defensa explícita ante cambios futuros en la lógica de status.
    const { data: neverAnalyzed } = await service
      .from('conversations')
      .select('id, client_phone, remote_jid, last_message_at, last_auto_analysis_at')
      .eq('status', 'active')
      .neq('status', 'historico')
      .not('remote_jid', 'ilike', '%@g.us')   // excluir grupos
      .gte('message_count', MIN_MESSAGES)
      .gte('last_message_at', sevenDaysAgo)
      .or(`last_auto_analysis_at.is.null,last_auto_analysis_at.lt.${twoHoursAgo}`)
      .order('created_at', { ascending: true })   // más antiguas primero
      .limit(30)

    type NeverRow = { id: string; client_phone: string; remote_jid: string | null; last_message_at: string | null; last_auto_analysis_at: string | null }

    // Filtrar las que realmente no tienen análisis (ai_analyses vacío)
    // Hacemos un check en lote para no hacer N queries individuales
    const neverAnalyzedFiltered = (neverAnalyzed as NeverRow[] ?? []).filter(c =>
      !employeePhoneSet.has(c.client_phone) && !c.remote_jid?.endsWith('@g.us')
    )
    const candidateIds = neverAnalyzedFiltered.map(c => c.id)

    let priorityCandidate: string | null = null

    if (candidateIds.length > 0) {
      // Obtener todos los IDs que YA tienen al menos un análisis
      const { data: withAnalysis } = await service
        .from('ai_analyses')
        .select('conversation_id')
        .in('conversation_id', candidateIds)

      const analyzedSet = new Set((withAnalysis ?? []).map((a: { conversation_id: string }) => a.conversation_id))

      // El primero que NO aparece en analyzedSet es nuestra prioridad 1
      const firstNever = neverAnalyzedFiltered.find(c => !analyzedSet.has(c.id))
      if (firstNever) {
        priorityCandidate = firstNever.id
      }
    }

    // ── PRIORIDAD 2: con análisis previo pero mensajes nuevos desde entonces ─
    // Solo se usa si no hay candidatas sin análisis.
    if (!priorityCandidate) {
      const { data: candidates, error } = await service
        .from('conversations')
        .select(`
          id,
          client_phone,
          remote_jid,
          last_message_at,
          last_auto_analysis_at,
          ai_analyses ( analyzed_at )
        `)
        .eq('status', 'active')
        .neq('status', 'historico')
        .not('remote_jid', 'ilike', '%@g.us')   // excluir grupos
        .gte('message_count', MIN_MESSAGES)
        .gte('last_message_at', sevenDaysAgo)
        .or(`last_auto_analysis_at.is.null,last_auto_analysis_at.lt.${twoHoursAgo}`)
        .order('last_message_at', { ascending: true })   // más antiguas sin atender primero
        .limit(20)

      if (error) {
        console.error('[AutoAnalysis] Error consultando candidatas:', error)
        return NextResponse.json({ analyzed: false, reason: 'Error interno al consultar' }, { status: 500 })
      }

      type Candidate = {
        id: string
        client_phone: string
        remote_jid: string | null
        last_message_at: string | null
        last_auto_analysis_at: string | null
        ai_analyses: Array<{ analyzed_at: string }> | null
      }

      const found = (candidates as Candidate[]).find(conv => {
        if (employeePhoneSet.has(conv.client_phone)) return false
        if (conv.remote_jid?.endsWith('@g.us'))     return false
        const analyses = conv.ai_analyses ?? []
        const lastAnalyzedAt = analyses.length
          ? analyses.reduce((latest, a) => a.analyzed_at > latest ? a.analyzed_at : latest, '')
          : null

        if (!lastAnalyzedAt) return true
        if (lastAnalyzedAt > thirtyMinutesAgo) return false
        return !!conv.last_message_at && conv.last_message_at > lastAnalyzedAt
      })

      if (!found) {
        return NextResponse.json({ analyzed: false, reason: 'Todas las conversaciones ya están al día' })
      }

      priorityCandidate = found.id
    }

    // Marcar inmediatamente para evitar doble procesamiento concurrente
    await service
      .from('conversations')
      .update({ last_auto_analysis_at: now.toISOString() })
      .eq('id', priorityCandidate)

    const result = await analyzeConversation(priorityCandidate, 'auto')

    if (!result.success) {
      if (result.isRateLimit) {
        // Falla transitoria: liberar el cooldown para que la conversación sea
        // candidata de nuevo en el próximo ciclo del setInterval.
        await service
          .from('conversations')
          .update({ last_auto_analysis_at: null })
          .eq('id', priorityCandidate)
        console.warn(`[AutoAnalysis] Rate limit — conversación ${priorityCandidate} liberada para próximo ciclo`)
      } else {
        console.error('[AutoAnalysis] Falló el análisis:', result.error)
      }
      return NextResponse.json({ analyzed: false, conversationId: priorityCandidate, reason: result.error })
    }

    console.log(`[AutoAnalysis] ✓ Conversación ${priorityCandidate} → análisis ${result.analysisId}`)
    return NextResponse.json({ analyzed: true, conversationId: priorityCandidate, analysisId: result.analysisId })

  } catch (error) {
    console.error('[AutoAnalysis] Error inesperado:', error)
    return NextResponse.json({ analyzed: false, reason: 'Error interno' }, { status: 500 })
  }
}
