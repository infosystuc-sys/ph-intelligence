/**
 * SCRIPT DE EXPORTACIÓN — Conversaciones "Sin Respuesta +24hs"
 *
 * Replica EXACTAMENTE el criterio de la tarjeta KPI del dashboard / filtro de
 * Conversaciones (ver app/api/kpis/route.ts y app/(dashboard)/conversations/page.tsx):
 *   - status = 'active'
 *   - último mensaje es del cliente (last_message_from_me = false)
 *   - han pasado más de 24hs desde ese mensaje
 *   - excluye grupos (@g.us), linked-ids (@lid) y teléfonos de empleados
 *
 * Para cada conversación trae el contenido real del último mensaje (tabla
 * `messages`) y los datos del cliente, y marca con los heurísticos de
 * lib/utils.ts si el último mensaje PARECE un saludo/cierre o una
 * reacción/sticker en vez de una consulta real sin responder.
 *
 * Uso: npx tsx scripts/export-unresponded.ts
 * Requiere: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env.local
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as XLSX from 'xlsx'
import * as path from 'path'
import { looksLikeGreeting, looksLikeReactionOrSticker } from '../lib/utils'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const H24 = 24 * 60 * 60 * 1000

type ConvRow = {
  id: string
  vendedor_id: string | null
  remote_jid: string | null
  client_phone: string
  client_name: string | null
  display_name: string | null
  message_count: number | null
  last_message_at: string
  base_cliente: string | null
  base_localidad: string | null
  vendedor: { full_name: string } | null
}

async function fetchAllPaginated<T>(table: string, columns: string, filters: (q: any) => any): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  let from = 0
  while (true) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1)
    q = filters(q)
    const { data, error } = await q
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

async function main() {
  console.log('Cargando teléfonos de empleados...')
  const { data: empPhones } = await supabase.from('employee_phones').select('phone')
  const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

  console.log('Cargando conversaciones activas...')
  const convs = await fetchAllPaginated<ConvRow>(
    'conversations',
    'id, vendedor_id, remote_jid, client_phone, client_name, display_name, message_count, last_message_at, base_cliente, base_localidad, vendedor:users!vendedor_id(full_name)',
    q => q.eq('status', 'active').eq('last_message_from_me', false).not('last_message_at', 'is', null),
  )

  const now = Date.now()
  const unresponded = convs.filter(c => {
    if (c.remote_jid?.endsWith('@g.us')) return false
    if (c.remote_jid?.endsWith('@lid')) return false
    if (employeePhoneSet.has(c.client_phone)) return false
    return now - new Date(c.last_message_at).getTime() > H24
  })

  console.log(`${unresponded.length} conversaciones sin respuesta +24hs. Buscando el último mensaje de cada una...`)

  // Una query por conversación (orden + limit 1) — con concurrencia limitada
  // para no saturar la API de Supabase.
  const CONCURRENCY = 10
  const lastMessages = new Map<string, string>()
  for (let i = 0; i < unresponded.length; i += CONCURRENCY) {
    const batch = unresponded.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async c => {
      const { data } = await supabase
        .from('messages')
        .select('content')
        .eq('conversation_id', c.id)
        .order('msg_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()
      lastMessages.set(c.id, data?.content ?? '')
    }))
    console.log(`  ${Math.min(i + CONCURRENCY, unresponded.length)}/${unresponded.length}`)
  }

  const rows = unresponded
    .sort((a, b) => new Date(a.last_message_at).getTime() - new Date(b.last_message_at).getTime())
    .map(c => {
      const content = lastMessages.get(c.id) ?? ''
      const horasSinResp = Math.round((now - new Date(c.last_message_at).getTime()) / (60 * 60 * 1000))
      return {
        'Vendedor': c.vendedor?.full_name ?? '—',
        'Cliente': c.base_cliente ?? c.display_name ?? c.client_name ?? c.client_phone,
        'Teléfono': c.client_phone,
        'Localidad': c.base_localidad ?? '',
        'Último mensaje (cliente)': content,
        '¿Parece solo un saludo?': looksLikeGreeting(content) ? 'Sí' : 'No',
        '¿Es reacción o sticker?': looksLikeReactionOrSticker(content) ? 'Sí' : 'No',
        'Horas sin respuesta': horasSinResp,
        'Última actividad': new Date(c.last_message_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
        'Mensajes totales': c.message_count ?? 0,
        'conversation_id': c.id,
      }
    })

  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sin respuesta 24h')
  const stamp = new Date().toISOString().slice(0, 10)
  const outPath = path.join(process.cwd(), `sin-respuesta-24h-${stamp}.xlsx`)
  XLSX.writeFile(wb, outPath)

  const posiblesSaludos = rows.filter(r => r['¿Parece solo un saludo?'] === 'Sí').length
  const reaccionesOStickers = rows.filter(r => r['¿Es reacción o sticker?'] === 'Sí').length
  const ruido = rows.filter(r => r['¿Parece solo un saludo?'] === 'Sí' || r['¿Es reacción o sticker?'] === 'Sí').length
  console.log(`\nListo: ${outPath}`)
  console.log(`Total: ${rows.length} · Saludos: ${posiblesSaludos} · Reacciones/stickers: ${reaccionesOStickers} · Ruido total: ${ruido} · Probablemente reales: ${rows.length - ruido}`)
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
