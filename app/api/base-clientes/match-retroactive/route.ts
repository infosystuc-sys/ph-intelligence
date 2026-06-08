import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { normalizePhone } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// Supabase/PostgREST cap-a `.select()` a 1000 filas por default.
// Para tablas grandes (base_clientes / conversations) hay que paginar manualmente.
async function fetchAllPaginated<T>(
  service: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const PAGE = 1000
  const all: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await service
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

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

// POST /api/base-clientes/match-retroactive
// Match SOLO por últimos 9 dígitos del teléfono. Sin otros criterios.
// 1) Limpia los campos base_* de TODAS las conversaciones.
// 2) Recarga los datos del CSV en las que matchean.
// 3) Devuelve la lista completa de resultados con conversation_id para "ir a conversación".
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data: profile } = await service
      .from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    // 1) Cargar toda la base (paginado para superar el cap de 1000 de PostgREST)
    type BaseRow = {
      cliente:     string | null
      cuit_dni:    string | null
      localidad:   string | null
      tarjeta:     string | null
      telefono_1:  string | null
      telefono_2:  string | null
      observacion: string | null
    }
    let baseRows: BaseRow[]
    try {
      baseRows = await fetchAllPaginated<BaseRow>(
        service,
        'base_clientes',
        'cliente, cuit_dni, localidad, tarjeta, telefono_1, telefono_2, observacion',
      )
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Error leyendo base' }, { status: 500 })
    }

    // 2) Construir mapa últimos9 → datos consolidados
    type AccEntry = {
      cliente:     string | null
      cuit_dni:    string | null
      localidad:   string | null
      tarjetas:    Set<string>
      observacion: string | null
      telefono_1:  string | null
      telefono_2:  string | null
    }
    const phoneMap = new Map<string, AccEntry>()

    for (const row of baseRows) {
      const keys = [
        ...extractLast9Keys(row.telefono_1),
        ...extractLast9Keys(row.telefono_2),
      ]
      for (const k of keys) {
        const existing = phoneMap.get(k)
        if (existing) {
          if (row.tarjeta)     existing.tarjetas.add(row.tarjeta)
          if (!existing.cliente     && row.cliente)     existing.cliente     = row.cliente
          if (!existing.cuit_dni    && row.cuit_dni)    existing.cuit_dni    = row.cuit_dni
          if (!existing.localidad   && row.localidad)   existing.localidad   = row.localidad
          if (!existing.observacion && row.observacion) existing.observacion = row.observacion
          if (!existing.telefono_1  && row.telefono_1)  existing.telefono_1  = row.telefono_1
          if (!existing.telefono_2  && row.telefono_2)  existing.telefono_2  = row.telefono_2
        } else {
          const tarjetas = new Set<string>()
          if (row.tarjeta) tarjetas.add(row.tarjeta)
          phoneMap.set(k, {
            cliente:     row.cliente     ?? null,
            cuit_dni:    row.cuit_dni    ?? null,
            localidad:   row.localidad   ?? null,
            tarjetas,
            observacion: row.observacion ?? null,
            telefono_1:  row.telefono_1  ?? null,
            telefono_2:  row.telefono_2  ?? null,
          })
        }
      }
    }

    // 3) Cargar teléfonos de empleados — se excluyen del match igual que en el resto
    //    de la app (dashboard, pipeline, conversaciones, KPIs).
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    // 4) Limpiar los campos base_* SOLO de las conversaciones elegibles (no histórico,
    //    no grupos). Las históricas/grupos no deberían tener base_* seteado de todas
    //    formas; al limitarlo evitamos tocar filas que no nos corresponden.
    await service
      .from('conversations')
      .update({
        base_cliente:     null,
        base_cuit_dni:    null,
        base_localidad:   null,
        base_tarjetas:    [],
        base_observacion: null,
      })
      .neq('status', 'historico')
      .not('remote_jid', 'ilike', '%@g.us')

    // 5) Cargar conversaciones elegibles (paginado, con los filtros aplicados a nivel SQL).
    //    PostgREST cap-ea .select() a 1000 — hay que paginar manualmente.
    //    Joineamos con whatsapp_instances y users para tener instancia + vendedor en
    //    la respuesta sin queries extra.
    type ConvRow = {
      id:           string
      client_phone: string
      client_name:  string | null
      display_name: string | null
      status:       string
      instance:     { instance_name: string | null } | null
      vendedor:     { full_name: string | null }    | null
    }
    const convs: ConvRow[] = []
    try {
      const PAGE = 1000
      let from = 0
      while (true) {
        const { data, error } = await service
          .from('conversations')
          .select(`
            id, client_phone, client_name, display_name, status,
            instance:whatsapp_instances!instance_id(instance_name),
            vendedor:users!vendedor_id(full_name)
          `)
          .neq('status', 'historico')
          .not('remote_jid', 'ilike', '%@g.us')
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        convs.push(...(data as unknown as ConvRow[]))
        if (data.length < PAGE) break
        from += PAGE
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Error leyendo conversaciones' }, { status: 500 })
    }

    // 5) Calcular updates
    type UpdateRow = {
      id:                 string
      client_phone:       string
      display_name:       string | null
      client_name:        string | null
      status:             string
      instance_name:      string | null
      vendedor_name:      string | null
      base_cliente:       string | null
      base_cuit_dni:      string | null
      base_localidad:     string | null
      base_tarjetas:      string[]
      base_observacion:   string | null
      base_telefono_1:    string | null
      base_telefono_2:    string | null
    }
    const updates: UpdateRow[] = []

    for (const conv of convs) {
      if (!conv.client_phone) continue
      if (employeePhoneSet.has(conv.client_phone)) continue   // excluir empleados
      const norm = normalizePhone(conv.client_phone)
      if (norm.length < 9) continue
      const key = norm.slice(-9)
      const match = phoneMap.get(key)
      if (match) {
        updates.push({
          id:                 conv.id,
          client_phone:       conv.client_phone,
          display_name:       conv.display_name ?? null,
          client_name:        conv.client_name  ?? null,
          status:             conv.status,
          instance_name:      conv.instance?.instance_name ?? null,
          vendedor_name:      conv.vendedor?.full_name     ?? null,
          base_cliente:       match.cliente,
          base_cuit_dni:      match.cuit_dni,
          base_localidad:     match.localidad,
          base_tarjetas:      [...match.tarjetas],
          base_observacion:   match.observacion,
          base_telefono_1:    match.telefono_1,
          base_telefono_2:    match.telefono_2,
        })
      }
    }

    // 6) Actualizar en lotes de 100
    const BATCH = 100
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH)
      await Promise.all(
        batch.map(u =>
          service
            .from('conversations')
            .update({
              base_cliente:     u.base_cliente,
              base_cuit_dni:    u.base_cuit_dni,
              base_localidad:   u.base_localidad,
              base_tarjetas:    u.base_tarjetas,
              base_observacion: u.base_observacion,
            })
            .eq('id', u.id),
        ),
      )
    }

    return NextResponse.json({
      matched: updates.length,
      items: updates.map(u => ({
        conversation_id: u.id,
        instance:        u.instance_name,
        vendedor:        u.vendedor_name,
        status:          u.status,
        phone:           u.client_phone,
        whatsapp_name:   u.display_name ?? u.client_name ?? null,
        cliente:         u.base_cliente,
        cuit_dni:        u.base_cuit_dni,
        localidad:       u.base_localidad,
        tarjetas:        u.base_tarjetas,
        observacion:     u.base_observacion,
        telefono_1:      u.base_telefono_1,
        telefono_2:      u.base_telefono_2,
      })),
    })
  } catch (err) {
    console.error('Error en match-retroactive:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
