import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { EvolutionAPIClient } from '@/lib/evolution'
import { WhatsappInstance } from '@/types'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Diag: para una instancia, llama a listChats() de Evolution y desglosa por qué
// cada chat se incluiría o se descartaría en un sync. Útil para entender por qué
// el sync devuelve "0 ok · N omitidos" en instancias nuevas.
//
// GET /api/diag/evolution-chats?instanceId=xxx
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admin' }, { status: 403 })

  // Acepta `instanceId` (uuid) o `name` (case-insensitive). Cualquiera de los dos.
  const params = new URL(req.url).searchParams
  const instanceId = params.get('instanceId')
  const name       = params.get('name')
  if (!instanceId && !name) {
    return NextResponse.json({ error: 'Pasá ?instanceId=xxx o ?name=Tucuman3' }, { status: 400 })
  }

  const service = createServiceSupabaseClient()
  let q = service.from('whatsapp_instances').select('*')
  if (instanceId) q = q.eq('id', instanceId)
  else            q = q.ilike('instance_name', name!)
  const { data: inst } = await q.maybeSingle()
  if (!inst) return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 })

  const client = new EvolutionAPIClient(inst as WhatsappInstance)
  const chats = await client.listChats()

  // Buckets de timestamp en días
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const buckets = { '0-7d': 0, '7-15d': 0, '15-30d': 0, '30-90d': 0, '+90d': 0, 'sin_ts': 0 }

  let total = 0
  let group = 0
  let lid   = 0
  let individual = 0
  const individualByAge = { '0-7d': 0, '7-15d': 0, '15-30d': 0, '30-90d': 0, '+90d': 0, 'sin_ts': 0 }

  for (const chat of chats) {
    total++
    const jid = chat.remoteJid || chat.id
    if (!jid) continue

    if (jid.endsWith('@g.us')) { group++; continue }
    if (jid.endsWith('@lid'))  { lid++;   continue }
    individual++

    // Calcular edad
    const ts = chat.lastMessage?.messageTimestamp
    const updatedAtMs = chat.updatedAt ? new Date(chat.updatedAt).getTime() : null
    let tsMs: number | null = null
    if (ts) tsMs = ts > 1e12 ? ts : ts * 1000
    else if (updatedAtMs) tsMs = updatedAtMs

    let bucket: keyof typeof buckets
    if (tsMs === null) bucket = 'sin_ts'
    else {
      const ageDays = (now - tsMs) / DAY
      if      (ageDays <= 7)  bucket = '0-7d'
      else if (ageDays <= 15) bucket = '7-15d'
      else if (ageDays <= 30) bucket = '15-30d'
      else if (ageDays <= 90) bucket = '30-90d'
      else                    bucket = '+90d'
    }
    buckets[bucket]++
    individualByAge[bucket]++
  }

  return NextResponse.json({
    instancia: inst.instance_name,
    total_chats_devueltos_por_evolution: total,
    por_tipo: {
      grupos_g_us:    group,
      linked_id_lid:  lid,
      individuales:   individual,
    },
    individuales_por_edad: individualByAge,
    interpretacion: {
      con_daysBack_15_actual: individualByAge['0-7d'] + individualByAge['7-15d'] + individualByAge['sin_ts'],
      si_subis_a_30_dias:     individualByAge['0-7d'] + individualByAge['7-15d'] + individualByAge['15-30d'] + individualByAge['sin_ts'],
      si_subis_a_90_dias:     individualByAge['0-7d'] + individualByAge['7-15d'] + individualByAge['15-30d'] + individualByAge['30-90d'] + individualByAge['sin_ts'],
      si_sacas_filtro_lid:    individualByAge['0-7d'] + individualByAge['7-15d'] + individualByAge['sin_ts'] + lid,
    },
  })
}
