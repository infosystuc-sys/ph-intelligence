import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

// Diagnóstico: explica exactamente qué conversaciones son elegibles para batch
// y por qué se filtran las que no lo son. Solo admin.
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

  // Mismos thresholds que el batch
  const minHours = 6
  const since        = new Date(Date.now() - minHours * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // 1) Contar conversaciones por filtro acumulado
  const { count: totalActive } = await service
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('status', 'active')

  const { count: notGroup } = await service
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('remote_jid', 'ilike', '%@g.us')

  const { count: with5Msgs } = await service
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('remote_jid', 'ilike', '%@g.us')
    .gte('message_count', 5)

  const { count: last7Days } = await service
    .from('conversations').select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('remote_jid', 'ilike', '%@g.us')
    .gte('message_count', 5)
    .gte('last_message_at', sevenDaysAgo)

  // 2) Cargar el universo de candidatos (sin limit) para análisis fino
  const { data: candidates } = await service
    .from('conversations')
    .select('id, client_name, client_phone, display_name, last_message_at, message_count')
    .eq('status', 'active')
    .not('remote_jid', 'ilike', '%@g.us')
    .gte('message_count', 5)
    .gte('last_message_at', sevenDaysAgo)
    .order('last_message_at', { ascending: false })

  const allIds = (candidates ?? []).map(c => c.id)

  // 3) Quiénes son empleados
  const { data: empPhones } = await service.from('employee_phones').select('phone')
  const empSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

  // 4) Quiénes tienen análisis en las últimas 6 hs
  const { data: recentAnalyses } = await service
    .from('ai_analyses')
    .select('conversation_id, analyzed_at')
    .gte('analyzed_at', since)
    .in('conversation_id', allIds)

  const analyzedRecentSet = new Set((recentAnalyses ?? []).map(a => a.conversation_id))

  // 5) Quiénes tienen al menos un análisis (cualquier fecha)
  const { data: anyAnalyses } = await service
    .from('ai_analyses')
    .select('conversation_id')
    .in('conversation_id', allIds)

  const anyAnalysisSet = new Set((anyAnalyses ?? []).map(a => a.conversation_id))

  // 6) Categorizar cada candidato
  const categories = {
    employee_phone: [] as Array<{id: string; name: string; phone: string}>,
    analyzed_recently: [] as Array<{id: string; name: string; phone: string}>,
    eligible_never_analyzed: [] as Array<{id: string; name: string; phone: string; last_message_at: string | null}>,
    eligible_analyzed_long_ago: [] as Array<{id: string; name: string; phone: string; last_message_at: string | null}>,
  }

  for (const c of candidates ?? []) {
    const name = c.display_name ?? c.client_name ?? c.client_phone
    const base = { id: c.id, name, phone: c.client_phone }

    if (empSet.has(c.client_phone)) {
      categories.employee_phone.push(base)
      continue
    }
    if (analyzedRecentSet.has(c.id)) {
      categories.analyzed_recently.push(base)
      continue
    }
    if (anyAnalysisSet.has(c.id)) {
      categories.eligible_analyzed_long_ago.push({ ...base, last_message_at: c.last_message_at })
    } else {
      categories.eligible_never_analyzed.push({ ...base, last_message_at: c.last_message_at })
    }
  }

  // 7) Simular qué pasa con el límite actual del batch (limit*3 = 30)
  const BATCH_LIMIT_DEFAULT = 10
  const CANDIDATE_CAP = BATCH_LIMIT_DEFAULT * 3   // = 30, el cap actual del batch
  const top30Ids = (candidates ?? []).slice(0, CANDIDATE_CAP).map(c => c.id)
  const eligibleInTop30 = top30Ids.filter(id => {
    const c = candidates!.find(x => x.id === id)!
    return !empSet.has(c.client_phone) && !analyzedRecentSet.has(c.id)
  })

  return NextResponse.json({
    config: { minHours, since, sevenDaysAgo, batch_default_limit: BATCH_LIMIT_DEFAULT, batch_candidate_cap: CANDIDATE_CAP },
    funnel: {
      step_1_active_status:     totalActive ?? 0,
      step_2_not_group:         notGroup    ?? 0,
      step_3_at_least_5_msgs:   with5Msgs   ?? 0,
      step_4_last_7_days:       last7Days   ?? 0,
    },
    categories: {
      filtered_employee_phone:        categories.employee_phone.length,
      filtered_analyzed_in_last_6h:   categories.analyzed_recently.length,
      eligible_never_analyzed:        categories.eligible_never_analyzed.length,
      eligible_analyzed_more_than_6h: categories.eligible_analyzed_long_ago.length,
      total_eligible:                 categories.eligible_never_analyzed.length + categories.eligible_analyzed_long_ago.length,
    },
    batch_simulation: {
      candidate_window_size: CANDIDATE_CAP,
      candidates_loaded: Math.min(allIds.length, CANDIDATE_CAP),
      eligible_within_window: eligibleInTop30.length,
      would_return_empty: eligibleInTop30.length === 0,
      explanation: eligibleInTop30.length === 0 && (categories.eligible_never_analyzed.length + categories.eligible_analyzed_long_ago.length) > 0
        ? 'BUG: Hay conversaciones elegibles pero estan fuera del top 30 mas reciente. El batch hace .limit(limit*3) antes de filtrar, por lo que pierde las que estan mas atras.'
        : 'OK',
    },
    samples: {
      first_5_never_analyzed:        categories.eligible_never_analyzed.slice(0, 5),
      first_5_analyzed_more_than_6h: categories.eligible_analyzed_long_ago.slice(0, 5),
      first_3_filtered_employee:     categories.employee_phone.slice(0, 3),
    },
  })
}
