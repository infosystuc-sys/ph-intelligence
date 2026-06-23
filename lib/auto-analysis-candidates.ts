import { createServiceSupabaseClient } from '@/lib/supabase-server'

const MIN_MESSAGES         = 5
const MAX_DAYS_INACTIVE    = 7
const COOLDOWN_AUTO_HOURS  = 2
const COOLDOWN_MIN_MINUTES = 30

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

type Tier1Row = { id: string; client_phone: string; remote_jid: string | null }
type Tier2Row = {
  id: string
  client_phone: string
  remote_jid: string | null
  last_message_at: string | null
  ai_analyses: Array<{ analyzed_at: string }> | null
}

// Misma prioridad que usa el análisis automático nocturno real
// (ver app/api/analyze/auto/route.ts): primero las que nunca fueron
// analizadas (más antiguas primero), después las que tienen mensajes
// nuevos desde el último análisis (más antiguas sin atender primero).
// Mantenida deliberadamente separada de auto/route.ts (no se reutiliza
// directamente) para no arriesgar el flujo automático ya probado —
// usado solo por el modo "nocturno" del batch manual en /analyses.
export async function getNightlyPriorityCandidates(
  service: ServiceClient,
  cap: number,
  now: Date = new Date()
): Promise<string[]> {
  const twoHoursAgo      = new Date(now.getTime() - COOLDOWN_AUTO_HOURS * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo     = new Date(now.getTime() - MAX_DAYS_INACTIVE * 24 * 60 * 60 * 1000).toISOString()
  const thirtyMinutesAgo = new Date(now.getTime() - COOLDOWN_MIN_MINUTES * 60 * 1000).toISOString()

  const { data: empPhones } = await service.from('employee_phones').select('phone')
  const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

  // Tier 1: nunca analizadas, más antiguas primero
  const { data: neverAnalyzed } = await service
    .from('conversations')
    .select('id, client_phone, remote_jid')
    .eq('status', 'active')
    .neq('status', 'historico')
    .not('remote_jid', 'ilike', '%@g.us')
    .gte('message_count', MIN_MESSAGES)
    .gte('last_message_at', sevenDaysAgo)
    .or(`last_auto_analysis_at.is.null,last_auto_analysis_at.lt.${twoHoursAgo}`)
    .order('created_at', { ascending: true })
    .limit(cap)

  const tier1Candidates = ((neverAnalyzed ?? []) as Tier1Row[]).filter(c =>
    !employeePhoneSet.has(c.client_phone) && !c.remote_jid?.endsWith('@g.us')
  )
  const tier1Ids = tier1Candidates.map(c => c.id)

  let result: string[] = []
  if (tier1Ids.length) {
    const { data: withAnalysis } = await service
      .from('ai_analyses')
      .select('conversation_id')
      .in('conversation_id', tier1Ids)
    const analyzedSet = new Set((withAnalysis ?? []).map((a: { conversation_id: string }) => a.conversation_id))
    result = tier1Ids.filter(id => !analyzedSet.has(id))
  }

  if (result.length >= cap) return result.slice(0, cap)

  // Tier 2: con análisis previo pero mensajes nuevos desde entonces, más antiguas primero
  const { data: candidates } = await service
    .from('conversations')
    .select(`
      id, client_phone, remote_jid, last_message_at,
      ai_analyses ( analyzed_at )
    `)
    .eq('status', 'active')
    .neq('status', 'historico')
    .not('remote_jid', 'ilike', '%@g.us')
    .gte('message_count', MIN_MESSAGES)
    .gte('last_message_at', sevenDaysAgo)
    .or(`last_auto_analysis_at.is.null,last_auto_analysis_at.lt.${twoHoursAgo}`)
    .order('last_message_at', { ascending: true })
    .limit(cap)

  const seen = new Set(result)
  for (const conv of (candidates ?? []) as Tier2Row[]) {
    if (seen.has(conv.id)) continue
    if (employeePhoneSet.has(conv.client_phone)) continue
    if (conv.remote_jid?.endsWith('@g.us')) continue

    const analyses = conv.ai_analyses ?? []
    const lastAnalyzedAt = analyses.length
      ? analyses.reduce((latest, a) => a.analyzed_at > latest ? a.analyzed_at : latest, '')
      : null

    const isStale = !lastAnalyzedAt
      ? true
      : lastAnalyzedAt > thirtyMinutesAgo
        ? false
        : !!conv.last_message_at && conv.last_message_at > lastAnalyzedAt

    if (!isStale) continue
    result.push(conv.id)
    seen.add(conv.id)
    if (result.length >= cap) break
  }

  return result.slice(0, cap)
}
