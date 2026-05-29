import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { normalizePhone } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

// Misma función que usa el match-retroactive — para que el diagnóstico no mienta
function extractLast9Keys(raw: string | null | undefined): string[] {
  if (!raw) return []
  if (/[eE]\+/.test(raw)) return []
  const parts = raw.split(/[\/,]|\s+-\s+/)
  const keys: string[] = []
  for (const p of parts) {
    const digits = normalizePhone(p)
    if (digits.length >= 9) keys.push(digits.slice(-9))
  }
  return [...new Set(keys)]
}

// Razón por la que un teléfono no produce ninguna clave de match
function diagnosePhone(raw: string | null | undefined): 'empty' | 'corrupted_e' | 'too_short' | 'ok' {
  if (!raw || !raw.trim()) return 'empty'
  if (/[eE]\+/.test(raw)) return 'corrupted_e'
  const parts = raw.split(/[\/,]|\s+-\s+/)
  for (const p of parts) {
    const digits = normalizePhone(p)
    if (digits.length >= 9) return 'ok'
  }
  return 'too_short'
}

// Diagnóstico: ¿cuántas filas del CSV producen claves válidas, y cuántas matchean
// con alguna conversación de WhatsApp? Desglosado por LOCALIDAD.
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

  // ── 1) Construir set de últimos9 dígitos de TODAS las conversaciones (paginado) ──
  type ConvRow = { id: string; client_phone: string; base_localidad: string | null }
  let convs: ConvRow[] = []
  try {
    convs = await fetchAllPaginated<ConvRow>(service, 'conversations', 'id, client_phone, base_localidad')
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error' }, { status: 500 })
  }
  const whatsappKeys = new Set<string>()
  for (const c of convs) {
    if (!c.client_phone) continue
    const norm = normalizePhone(c.client_phone)
    if (norm.length >= 9) whatsappKeys.add(norm.slice(-9))
  }

  // ── 2) Recorrer base_clientes y categorizar por localidad (paginado) ──
  type Row = { localidad: string | null; telefono_1: string | null; telefono_2: string | null }
  let rows: Row[] = []
  try {
    rows = await fetchAllPaginated<Row>(service, 'base_clientes', 'localidad, telefono_1, telefono_2')
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error' }, { status: 500 })
  }

  type LocStats = {
    rows_total: number
    rows_with_at_least_one_valid_phone: number
    rows_corrupted_e_in_both_phones: number
    rows_too_short_in_both: number
    rows_empty_in_both: number
    rows_that_match_a_conversation: number
    unique_keys: Set<string>
    unique_keys_that_match: Set<string>
    samples_unmatched: Array<{ tel1: string | null; tel2: string | null; keys_extracted: string[] }>
  }
  const byLoc: Record<string, LocStats> = {}

  for (const row of rows) {
    const loc = row.localidad ?? '(sin localidad)'
    if (!byLoc[loc]) {
      byLoc[loc] = {
        rows_total: 0,
        rows_with_at_least_one_valid_phone: 0,
        rows_corrupted_e_in_both_phones: 0,
        rows_too_short_in_both: 0,
        rows_empty_in_both: 0,
        rows_that_match_a_conversation: 0,
        unique_keys: new Set(),
        unique_keys_that_match: new Set(),
        samples_unmatched: [],
      }
    }
    const s = byLoc[loc]
    s.rows_total++

    const d1 = diagnosePhone(row.telefono_1)
    const d2 = diagnosePhone(row.telefono_2)
    const keys1 = extractLast9Keys(row.telefono_1)
    const keys2 = extractLast9Keys(row.telefono_2)
    const allKeys = [...new Set([...keys1, ...keys2])]

    if (allKeys.length > 0) {
      s.rows_with_at_least_one_valid_phone++
      for (const k of allKeys) s.unique_keys.add(k)
      const matchingKeys = allKeys.filter(k => whatsappKeys.has(k))
      if (matchingKeys.length > 0) {
        s.rows_that_match_a_conversation++
        for (const k of matchingKeys) s.unique_keys_that_match.add(k)
      } else {
        if (s.samples_unmatched.length < 3) {
          s.samples_unmatched.push({
            tel1: row.telefono_1,
            tel2: row.telefono_2,
            keys_extracted: allKeys,
          })
        }
      }
    } else {
      // Ninguna clave válida — clasificar por qué
      if (d1 === 'empty' && d2 === 'empty') s.rows_empty_in_both++
      else if (d1 === 'corrupted_e' || d2 === 'corrupted_e') s.rows_corrupted_e_in_both_phones++
      else s.rows_too_short_in_both++
    }
  }

  // ── 3) Stats globales ──
  const totalCsvRows  = rows.length
  const totalConvs    = convs.length
  const totalWaKeys   = whatsappKeys.size

  // Convertir Sets a counts para serialización
  const localidadesSummary = Object.entries(byLoc)
    .map(([loc, s]) => ({
      localidad:                          loc,
      rows_total:                         s.rows_total,
      rows_with_valid_phone:              s.rows_with_at_least_one_valid_phone,
      rows_corrupted:                     s.rows_corrupted_e_in_both_phones,
      rows_too_short:                     s.rows_too_short_in_both,
      rows_empty_phone:                   s.rows_empty_in_both,
      unique_phone_keys:                  s.unique_keys.size,
      unique_keys_that_match_whatsapp:    s.unique_keys_that_match.size,
      rows_that_match_a_conversation:     s.rows_that_match_a_conversation,
      pct_rows_with_valid_phone:          s.rows_total ? Math.round(s.rows_with_at_least_one_valid_phone / s.rows_total * 100) : 0,
      pct_unique_keys_matching:           s.unique_keys.size ? Math.round(s.unique_keys.size && s.unique_keys_that_match.size / s.unique_keys.size * 100) : 0,
      samples_unmatched_rows:             s.samples_unmatched,
    }))
    .sort((a, b) => b.rows_total - a.rows_total)

  // ── 4) Muestras de WhatsApp que NO matchean ningun CSV ──
  const allCsvKeys = new Set<string>()
  for (const s of Object.values(byLoc)) {
    for (const k of s.unique_keys) allCsvKeys.add(k)
  }

  const unmatchedWa: Array<{ phone: string; key: string }> = []
  for (const c of convs) {
    if (unmatchedWa.length >= 10) break
    if (!c.client_phone) continue
    const norm = normalizePhone(c.client_phone)
    if (norm.length < 9) continue
    const key = norm.slice(-9)
    if (!allCsvKeys.has(key)) unmatchedWa.push({ phone: c.client_phone, key })
  }

  return NextResponse.json({
    totals: {
      csv_rows_total:                       totalCsvRows,
      conversations_total:                  totalConvs,
      whatsapp_unique_keys:                 totalWaKeys,
      csv_unique_keys:                      allCsvKeys.size,
      // Cuántas claves del CSV existen también en WhatsApp (intersección a nivel de claves)
      keys_in_intersection:                 [...allCsvKeys].filter(k => whatsappKeys.has(k)).length,
    },
    por_localidad: localidadesSummary,
    samples_whatsapp_unmatched_in_csv: unmatchedWa,
  })
}
