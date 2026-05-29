import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { normalizePhone } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'

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

export interface BaseMatch {
  cliente:     string | null
  cuit_dni:    string | null
  localidad:   string | null
  tarjetas:    string[]
  observacion: string | null
}

// Convierte un teléfono crudo a "últimos 9 dígitos" — clave de match.
// Tolera celdas con varios teléfonos separados por / , o " - ".
// Descarta celdas corruptas con notación científica.
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

// GET /api/base-clientes/lookup
// Devuelve mapa últimos9dígitos → datos del cliente del CSV.
// Si un mismo teléfono aparece en varias filas (cliente con varias tarjetas),
// las tarjetas se acumulan y los otros campos toman el primer no-nulo.
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    type BaseRow = {
      cliente:     string | null
      cuit_dni:    string | null
      localidad:   string | null
      tarjeta:     string | null
      telefono_1:  string | null
      telefono_2:  string | null
      observacion: string | null
    }
    let data: BaseRow[]
    try {
      data = await fetchAllPaginated<BaseRow>(
        service,
        'base_clientes',
        'cliente, cuit_dni, localidad, tarjeta, telefono_1, telefono_2, observacion',
      )
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Error' }, { status: 500 })
    }

    type AccEntry = {
      cliente:     string | null
      cuit_dni:    string | null
      localidad:   string | null
      tarjetas:    Set<string>
      observacion: string | null
    }
    const acc: Record<string, AccEntry> = {}

    for (const row of data) {
      const keys = [
        ...extractLast9Keys(row.telefono_1),
        ...extractLast9Keys(row.telefono_2),
      ]
      for (const k of keys) {
        if (!acc[k]) {
          acc[k] = {
            cliente:     row.cliente     ?? null,
            cuit_dni:    row.cuit_dni    ?? null,
            localidad:   row.localidad   ?? null,
            tarjetas:    new Set(),
            observacion: row.observacion ?? null,
          }
        }
        if (row.tarjeta)     acc[k].tarjetas.add(row.tarjeta)
        if (!acc[k].cliente     && row.cliente)     acc[k].cliente     = row.cliente
        if (!acc[k].cuit_dni    && row.cuit_dni)    acc[k].cuit_dni    = row.cuit_dni
        if (!acc[k].localidad   && row.localidad)   acc[k].localidad   = row.localidad
        if (!acc[k].observacion && row.observacion) acc[k].observacion = row.observacion
      }
    }

    const map: Record<string, BaseMatch> = {}
    for (const [k, entry] of Object.entries(acc)) {
      map[k] = {
        cliente:     entry.cliente,
        cuit_dni:    entry.cuit_dni,
        localidad:   entry.localidad,
        tarjetas:    [...entry.tarjetas],
        observacion: entry.observacion,
      }
    }

    return NextResponse.json({ data: map })
  } catch (err) {
    console.error('Error en /api/base-clientes/lookup:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
