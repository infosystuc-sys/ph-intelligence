import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { looksLikeGreeting, looksLikeReactionOrSticker, crossed24hThresholdToday } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// PostgREST cap-ea .select() a 1000 filas — paginar siempre que la tabla pueda superar eso.
async function fetchAllPaginated<T>(
  service: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await service.from(table).select(columns).range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

// KPIs del dashboard — calculados EN VIVO sobre las conversaciones reales.
// Definiciones (acordadas 11/6/2026):
// - Sin Respuesta +24hs: conversaciones ACTIVAS donde el último mensaje es del
//   CLIENTE, CRUZÓ el umbral de 24hs sin respuesta HOY (no el backlog de días
//   anteriores — ver crossed24hThresholdToday en lib/utils.ts), Y no parece un
//   simple saludo/cierre ni una reacción/sticker (looksLikeGreeting /
//   looksLikeReactionOrSticker — actualizado 20/6/2026).
// - Pipeline Activo: conversaciones con status 'active' únicamente.
// - Score de Calidad: promedio del ÚLTIMO análisis de cada conversación
//   (re-analizar no duplica), promediado por vendedor y entre vendedores.
// - Conversiones estimadas: conversaciones cuyo último análisis es closed_won.
// - Cobertura: TODOS los vendedores cuentan, tengan o no análisis del día.
// - Exclusiones: grupos @g.us, linked-ids @lid, teléfonos de empleados, histórico
//   (en los conteos donde aplica).
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    const service = createServiceSupabaseClient()

    // ── Alcance por rol: qué vendedores ve este usuario ──────────────────────
    let vendorScope: string[] | null = null   // null = todos
    if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service
        .from('users').select('id').eq('supervisor_id', user.id)
      vendorScope = (myVendors ?? []).map(v => v.id)
    } else if (profile?.role === 'vendedor') {
      vendorScope = [user.id]
    }

    // Lista completa de vendedores en el alcance (para incluir a los que tienen 0)
    let vendorsQuery = service.from('users').select('id, full_name').eq('role', 'vendedor')
    if (vendorScope) vendorsQuery = vendorsQuery.in('id', vendorScope)
    const { data: vendorList } = await vendorsQuery
    const vendorIds = new Set((vendorList ?? []).map(v => v.id))

    // ── Teléfonos de empleados (excluidos de todos los conteos) ──────────────
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    // ── Conversaciones: TODAS, paginadas (el cap de 1000 truncaba los KPIs) ──
    type ConvRow = {
      id: string
      vendedor_id: string | null
      status: string
      remote_jid: string | null
      client_phone: string
      last_message_at: string | null
      last_message_from_me: boolean | null
      last_message_content: string | null
    }
    const allConvs = await fetchAllPaginated<ConvRow>(
      service,
      'conversations',
      'id, vendedor_id, status, remote_jid, client_phone, last_message_at, last_message_from_me, last_message_content',
    )

    // Filtrado común: grupos, @lid, empleados, vendedor fuera de alcance
    const convs = allConvs.filter(c => {
      if (!c.vendedor_id || !vendorIds.has(c.vendedor_id)) return false
      if (c.remote_jid?.endsWith('@g.us')) return false
      if (c.remote_jid?.endsWith('@lid')) return false
      if (employeePhoneSet.has(c.client_phone)) return false
      return true
    })
    const convById = new Map(convs.map(c => [c.id, c]))

    const now = Date.now()

    // ── Conteos live por vendedor ─────────────────────────────────────────────
    const liveByVendor: Record<string, { active: number; unresponded: number }> = {}
    for (const vid of vendorIds) liveByVendor[vid] = { active: 0, unresponded: 0 }

    for (const c of convs) {
      const bucket = liveByVendor[c.vendedor_id!]
      if (!bucket) continue
      if (c.status !== 'active') continue
      bucket.active++
      // Cliente esperando: último mensaje del cliente, cruzó las 24hs sin
      // respuesta HOY (no el backlog acumulado de días anteriores), y ese
      // mensaje no parece un simple saludo/cierre ni una reacción/sticker —
      // "gracias, dale" o un 👍 a un mensaje anterior no son consultas sin responder.
      if (
        c.last_message_from_me === false &&
        c.last_message_at &&
        crossed24hThresholdToday(c.last_message_at, now) &&
        !looksLikeGreeting(c.last_message_content) &&
        !looksLikeReactionOrSticker(c.last_message_content)
      ) {
        bucket.unresponded++
      }
    }

    // ── Análisis IA: último por conversación ─────────────────────────────────
    type AnalysisRow = {
      conversation_id: string
      vendedor_id: string | null
      quality_score: number
      conversation_stage: string
      analyzed_at: string
    }
    const allAnalyses = await fetchAllPaginated<AnalysisRow>(
      service,
      'ai_analyses',
      'conversation_id, vendedor_id, quality_score, conversation_stage, analyzed_at',
    )

    // Quedarnos con el análisis más reciente de cada conversación (que esté en alcance)
    const latestByConv = new Map<string, AnalysisRow>()
    for (const a of allAnalyses) {
      if (!convById.has(a.conversation_id)) continue
      const prev = latestByConv.get(a.conversation_id)
      if (!prev || a.analyzed_at > prev.analyzed_at) latestByConv.set(a.conversation_id, a)
    }

    // Agregar por vendedor
    const scoreByVendor: Record<string, { sum: number; count: number; stages: Record<string, number> }> = {}
    for (const vid of vendorIds) {
      scoreByVendor[vid] = { sum: 0, count: 0, stages: { new: 0, negotiation: 0, proposal: 0, closed_won: 0, closed_lost: 0 } }
    }
    for (const a of latestByConv.values()) {
      const conv = convById.get(a.conversation_id)
      const vid = conv?.vendedor_id
      if (!vid || !scoreByVendor[vid]) continue
      scoreByVendor[vid].sum += a.quality_score
      scoreByVendor[vid].count++
      if (a.conversation_stage in scoreByVendor[vid].stages) {
        scoreByVendor[vid].stages[a.conversation_stage]++
      }
    }

    // ── KPIs por vendedor (forma compatible con el dashboard) ────────────────
    const kpisByVendor = [...vendorIds].map(vid => {
      const live  = liveByVendor[vid]
      const score = scoreByVendor[vid]
      const avg   = score.count > 0 ? Math.round((score.sum / score.count) * 10) / 10 : 0
      return {
        vendedor_id:                    vid,
        avg_quality_score:              avg,
        conversations_total:            live.active,
        conversations_unresponded_24h:  live.unresponded,
        conversations_responded_24h:    live.active - live.unresponded,
        estimated_conversions:          score.stages.closed_won,
        pipeline_stage_counts:          score.stages,
        has_analyses:                   score.count > 0,
      }
    })

    // ── Globales ─────────────────────────────────────────────────────────────
    const withAnalyses = kpisByVendor.filter(k => k.has_analyses)
    const avgScore = withAnalyses.length
      ? withAnalyses.reduce((s, k) => s + k.avg_quality_score, 0) / withAnalyses.length
      : 0

    const unresponded          = kpisByVendor.reduce((s, k) => s + k.conversations_unresponded_24h, 0)
    const totalActive          = kpisByVendor.reduce((s, k) => s + k.conversations_total, 0)
    const estimatedConversions = kpisByVendor.reduce((s, k) => s + k.estimated_conversions, 0)

    const pipelineCounts = kpisByVendor.reduce((acc, k) => {
      Object.entries(k.pipeline_stage_counts).forEach(([stage, count]) => {
        acc[stage] = (acc[stage] ?? 0) + count
      })
      return acc
    }, {} as Record<string, number>)

    // ── Comparativa vs histórico (daily_kpis de los últimos 7 días) ──────────
    const sevenDaysAgo = new Date(Date.now() - 86400000 * 7).toISOString().split('T')[0]
    const today        = new Date().toISOString().split('T')[0]

    let prevQuery = service
      .from('daily_kpis')
      .select('vendedor_id, date, avg_quality_score')
      .gte('date', sevenDaysAgo)
      .neq('date', today)
      .order('date', { ascending: false })
    if (vendorScope) prevQuery = prevQuery.in('vendedor_id', vendorScope)
    const { data: prevKpis } = await prevQuery

    const avgScorePrev = prevKpis?.length
      ? prevKpis.reduce((s, k) => s + k.avg_quality_score, 0) / prevKpis.length
      : 0

    // Mejora/empeora: score live actual vs el registro más reciente del histórico
    const latestPrevByVendor = new Map<string, number>()
    for (const k of prevKpis ?? []) {
      if (!latestPrevByVendor.has(k.vendedor_id)) latestPrevByVendor.set(k.vendedor_id, k.avg_quality_score)
    }
    let vendorsImproved = 0
    let vendorsDeclined = 0
    for (const k of withAnalyses) {
      const prev = latestPrevByVendor.get(k.vendedor_id)
      if (prev === undefined) continue
      if (k.avg_quality_score > prev) vendorsImproved++
      else if (k.avg_quality_score < prev) vendorsDeclined++
    }

    // ── Instancias ───────────────────────────────────────────────────────────
    const { data: instances } = await service
      .from('whatsapp_instances')
      .select('id, status')
    const connected = instances?.filter(i => i.status === 'connected').length ?? 0
    const total     = instances?.length ?? 0

    return NextResponse.json({
      avg_quality_score:      Math.round(avgScore * 10) / 10,
      avg_quality_score_prev: Math.round(avgScorePrev * 10) / 10,
      unresponded_24h:        unresponded,
      estimated_conversions:  estimatedConversions,
      estimated_conversions_prev: 0,
      active_conversations:   totalActive,
      pipeline_counts:        pipelineCounts,
      vendors_improved:       vendorsImproved,
      vendors_declined:       vendorsDeclined,
      connected_instances:    connected,
      total_instances:        total,
      kpis_by_vendor:         kpisByVendor,
    })
  } catch (error) {
    console.error('Error en KPIs:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
