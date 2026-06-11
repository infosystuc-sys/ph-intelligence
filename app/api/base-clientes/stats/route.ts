import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
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

// Normaliza un nombre para comparar vendedor.full_name con base_clientes.localidad:
// minúsculas, sin acentos, sin espacios ni signos. Así "J. V. González" y "JV GONZALEZ"
// terminan iguales.
// Rango Unicode U+0300..U+036F = "Combining Diacritical Marks". Después de NFD
// los acentos quedan como caracteres combinantes en ese rango — los borramos así.
const COMBINING_DIACRITICS = /[̀-ͯ]/g
function normalizeName(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// Mapeo vendor → clave de localidad. Por defecto la clave es el nombre normalizado.
// Excepción conocida: JVGonzalez en vendedores figura como "JVG" en el CSV.
function vendorLocalidadKey(fullName: string | null | undefined): string {
  const n = normalizeName(fullName)
  if (!n) return ''
  if (n.includes('jvgonzalez') || n === 'jvg') return 'jvg'
  return n
}

type VendorRow  = { id: string; full_name: string; role: string }
type BaseRow    = { cliente: string | null; localidad: string | null; telefono_1: string | null; telefono_2: string | null }
type ConvRow    = { vendedor_id: string | null; base_cliente: string | null; base_localidad: string | null; remote_jid: string | null; client_phone: string }

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const service = createServiceSupabaseClient()

  // 1) Vendedores
  const { data: vendors, error: vErr } = await service
    .from('users')
    .select('id, full_name, role')
    .eq('role', 'vendedor')
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })

  // 2) Base clientes (paginado — la tabla supera el cap de 1000)
  let baseRows: BaseRow[]
  try {
    baseRows = await fetchAllPaginated<BaseRow>(
      service,
      'base_clientes',
      'cliente, localidad, telefono_1, telefono_2',
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error' }, { status: 500 })
  }

  // 3) Conversaciones (paginado) — solo lo necesario para el cruce
  let convs: ConvRow[]
  try {
    convs = await fetchAllPaginated<ConvRow>(
      service,
      'conversations',
      'vendedor_id, base_cliente, base_localidad, remote_jid, client_phone',
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error' }, { status: 500 })
  }

  // Excluir teléfonos de empleados de los conteos de "contactados"
  const { data: empPhones } = await service.from('employee_phones').select('phone')
  const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

  // 4) Indexar base_clientes por localidad-normalizada → set de clientes únicos.
  //    Un mismo cliente puede aparecer N veces (una por tarjeta); contamos por nombre.
  const localidadToClientes = new Map<string, Set<string>>()
  const localidadDisplayNames = new Map<string, string>()  // primer nombre canónico para mostrar
  const localidadToRows = new Map<string, number>()         // filas totales (incluye duplicados por tarjeta)

  for (const r of baseRows) {
    const locKey = normalizeName(r.localidad)
    if (!locKey) continue
    if (!localidadDisplayNames.has(locKey) && r.localidad) {
      localidadDisplayNames.set(locKey, r.localidad.trim())
    }
    localidadToRows.set(locKey, (localidadToRows.get(locKey) ?? 0) + 1)
    if (!r.cliente) continue
    if (!localidadToClientes.has(locKey)) localidadToClientes.set(locKey, new Set())
    localidadToClientes.get(locKey)!.add(r.cliente.trim())
  }

  // 5) Por cada conversación con vendedor + base_cliente:
  //    - contactedByVendor: solo cuenta los que están en la localidad asignada
  //    - matchesByVendor:   cuenta cualquier conversación con match, sin filtrar por localidad
  const contactedByVendor = new Map<string, Set<string>>()
  const matchesByVendor   = new Map<string, number>()
  for (const c of convs) {
    if (!c.vendedor_id) continue
    if (!c.base_cliente) continue
    if (c.remote_jid?.endsWith('@g.us')) continue
    if (employeePhoneSet.has(c.client_phone)) continue
    if (!contactedByVendor.has(c.vendedor_id)) contactedByVendor.set(c.vendedor_id, new Set())
    contactedByVendor.get(c.vendedor_id)!.add(c.base_cliente.trim())
    matchesByVendor.set(c.vendedor_id, (matchesByVendor.get(c.vendedor_id) ?? 0) + 1)
  }

  // 6) Stats por vendedor: cruzar vendor.full_name → localidad.
  type VendorStats = {
    vendedor_id:        string
    full_name:          string
    localidad:          string | null
    localidad_key:      string
    clientes_asignados: number
    rows_asignadas:     number
    clientes_contactados: number
    clientes_pendientes:  number
    cobertura_pct:        number
    matched_localidad:    boolean
    matches_total:        number   // conversaciones con base_cliente IS NOT NULL, sin filtrar por localidad
  }
  const perVendor: VendorStats[] = (vendors ?? []).map((v: VendorRow) => {
    const key = vendorLocalidadKey(v.full_name)
    const asignados = localidadToClientes.get(key) ?? new Set<string>()
    const rows      = localidadToRows.get(key) ?? 0
    const contactedAll = contactedByVendor.get(v.id) ?? new Set<string>()
    // Solo cuentan como "contactados de su base" los nombres que están en su localidad
    const contactadosEnSuBase = [...contactedAll].filter(name => asignados.has(name)).length
    const totalAsignados = asignados.size
    const cobertura = totalAsignados > 0
      ? Math.round((contactadosEnSuBase / totalAsignados) * 100)
      : 0
    return {
      vendedor_id:          v.id,
      full_name:            v.full_name,
      localidad:            localidadDisplayNames.get(key) ?? null,
      localidad_key:        key,
      clientes_asignados:   totalAsignados,
      rows_asignadas:       rows,
      clientes_contactados: contactadosEnSuBase,
      clientes_pendientes:  Math.max(0, totalAsignados - contactadosEnSuBase),
      cobertura_pct:        cobertura,
      matched_localidad:    totalAsignados > 0,
      matches_total:        matchesByVendor.get(v.id) ?? 0,
    }
  }).sort((a, b) => b.clientes_asignados - a.clientes_asignados)

  // 7) Totales globales
  const totalRowsBase    = baseRows.length
  const allClientesSet   = new Set<string>()
  for (const set of localidadToClientes.values()) for (const c of set) allClientesSet.add(c)
  const totalClientes    = allClientesSet.size
  const totalLocalidades = localidadToClientes.size

  const sumAsignados    = perVendor.reduce((s, v) => s + v.clientes_asignados,   0)
  const sumContactados  = perVendor.reduce((s, v) => s + v.clientes_contactados, 0)
  const coberturaGlobal = sumAsignados > 0
    ? Math.round((sumContactados / sumAsignados) * 100)
    : 0

  // 8) Localidades del CSV que NO matchean a ningún vendedor — útil para detectar
  //    typos o vendedores faltantes.
  const matchedKeys = new Set(perVendor.filter(v => v.matched_localidad).map(v => v.localidad_key))
  const localidadesHuerfanas = [...localidadToClientes.entries()]
    .filter(([k]) => !matchedKeys.has(k))
    .map(([k, set]) => ({
      localidad: localidadDisplayNames.get(k) ?? k,
      clientes_unicos: set.size,
    }))
    .sort((a, b) => b.clientes_unicos - a.clientes_unicos)

  return NextResponse.json({
    totales: {
      filas_csv:           totalRowsBase,
      clientes_unicos:     totalClientes,
      localidades:         totalLocalidades,
      vendedores_total:    perVendor.length,
      vendedores_con_base: perVendor.filter(v => v.matched_localidad).length,
      cobertura_global_pct: coberturaGlobal,
      clientes_asignados:   sumAsignados,
      clientes_contactados: sumContactados,
    },
    por_vendedor: perVendor,
    localidades_sin_vendedor: localidadesHuerfanas,
  })
}
