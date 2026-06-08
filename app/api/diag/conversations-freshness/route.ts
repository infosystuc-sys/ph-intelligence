import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Diagnóstico de frescura de conversaciones — confirma si messages tiene actividad
// más reciente que conversations.last_message_at. Si sí, el problema es que algo
// dejó de actualizar ese campo. Solo admin.
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

  // 1) Top 10 conversaciones más recientes según conversations.last_message_at
  //    (lo mismo que ve la página)
  const { data: convsTop } = await service
    .from('conversations')
    .select('id, client_phone, client_name, display_name, status, remote_jid, last_message_at, created_at')
    .neq('status', 'historico')
    .not('remote_jid', 'ilike', '%@g.us')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(10)

  // 2) Top 10 mensajes más recientes — fuente de verdad de la actividad
  const { data: msgsTop } = await service
    .from('messages')
    .select('id, conversation_id, msg_timestamp, from_me, content')
    .order('msg_timestamp', { ascending: false })
    .limit(10)

  // 3) Para cada mensaje top, buscar la conversación y comparar timestamps
  const convIds = [...new Set((msgsTop ?? []).map(m => m.conversation_id))]
  const { data: convsForMsgs } = convIds.length > 0
    ? await service.from('conversations').select('id, last_message_at, status, remote_jid').in('id', convIds)
    : { data: [] }
  const convMap = new Map((convsForMsgs ?? []).map(c => [c.id, c]))

  const recentMessagesComparison = (msgsTop ?? []).map(m => {
    const c = convMap.get(m.conversation_id)
    const msgTs = m.msg_timestamp ? new Date(m.msg_timestamp).getTime() : 0
    const convTs = c?.last_message_at ? new Date(c.last_message_at).getTime() : 0
    const driftMs = msgTs - convTs
    return {
      conversation_id:           m.conversation_id,
      message_timestamp:         m.msg_timestamp,
      conversation_last_msg_at:  c?.last_message_at ?? null,
      drift_days:                driftMs > 0 ? Math.round(driftMs / (24 * 3600 * 1000)) : 0,
      stale:                     driftMs > 60 * 60 * 1000,   // >1h de drift
      status:                    c?.status ?? null,
      is_group:                  c?.remote_jid?.endsWith('@g.us') ?? false,
      message_preview:           (m.content ?? '').slice(0, 80),
      from_me:                   m.from_me,
    }
  })

  // 4) Conteo: ¿cuántas conversaciones tienen last_message_at antiguo pero
  //    mensajes recientes? Es la métrica clave del bug.
  const ONE_HOUR = 60 * 60 * 1000
  let staleCount = 0
  for (const row of recentMessagesComparison) {
    if (row.stale) staleCount++
  }

  // 5) Totales y rango temporal de cada fuente
  const { count: totalConvs } = await service
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'historico')
    .not('remote_jid', 'ilike', '%@g.us')

  const { count: totalMsgs } = await service
    .from('messages')
    .select('id', { count: 'exact', head: true })

  // 6) Distribución por mes para detectar el corte
  //    Trae las últimas 1000 conversaciones (orden last_message_at desc) y
  //    cuenta por mes — útil para ver "hasta cuándo llega" la lista visible.
  const { data: distConvs } = await service
    .from('conversations')
    .select('last_message_at')
    .neq('status', 'historico')
    .not('remote_jid', 'ilike', '%@g.us')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1000)

  const monthCountsConvs: Record<string, number> = {}
  for (const c of distConvs ?? []) {
    if (!c.last_message_at) continue
    const ym = c.last_message_at.slice(0, 7)
    monthCountsConvs[ym] = (monthCountsConvs[ym] ?? 0) + 1
  }

  // Mismo histograma pero por msg_timestamp en messages
  const { data: distMsgs } = await service
    .from('messages')
    .select('msg_timestamp')
    .order('msg_timestamp', { ascending: false })
    .limit(1000)

  const monthCountsMsgs: Record<string, number> = {}
  for (const m of distMsgs ?? []) {
    if (!m.msg_timestamp) continue
    const ym = m.msg_timestamp.slice(0, 7)
    monthCountsMsgs[ym] = (monthCountsMsgs[ym] ?? 0) + 1
  }

  return NextResponse.json({
    summary: {
      total_conversations_visibles:                 totalConvs ?? 0,
      total_messages:                               totalMsgs  ?? 0,
      stale_in_top_10_recent_msgs:                  staleCount,
      hipotesis:                                    staleCount >= 5
        ? 'BUG: conversations.last_message_at está desactualizado respecto a messages.msg_timestamp.'
        : staleCount > 0
          ? 'Drift parcial — algunas conversaciones tienen timestamp viejo, otras no.'
          : 'Sin drift evidente. Buscar en otro lado.',
    },
    rangos_recientes: {
      conversation_max_last_message_at: convsTop?.[0]?.last_message_at ?? null,
      message_max_timestamp:             msgsTop?.[0]?.msg_timestamp     ?? null,
    },
    top_10_conversaciones_segun_last_message_at: convsTop,
    top_10_mensajes_recientes_vs_conversacion:   recentMessagesComparison,
    distribucion_por_mes_conversaciones:          monthCountsConvs,
    distribucion_por_mes_mensajes:                monthCountsMsgs,
  })
}
