import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { normalizePhone } from '@/lib/utils'

export const maxDuration = 60

// POST /api/base-tn/match-retroactive
// Empareja todas las conversaciones con base_tn por teléfono (en TypeScript, sin RPC).
// Prioridad: naranja (tiene cod_cliente) > cancela_renueva; más reciente primero.
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

    // 1. Cargar toda la base_tn (teléfonos + cod_cliente + source)
    const { data: baseRows, error: baseErr } = await service
      .from('base_tn')
      .select('telefono_1, telefono_2, cod_cliente, source')
      .order('source', { ascending: true })   // naranja < cancela_renueva alphabetically → no garantiza, usamos map logic
      .order('created_at', { ascending: false })

    if (baseErr) return NextResponse.json({ error: baseErr.message }, { status: 500 })

    // 2. Construir mapa normalizado: phone → { cod_cliente, source }
    //    Naranja tiene prioridad (sobreescribe cancela_renueva si ya existe entrada)
    const phoneMap = new Map<string, { cod_cliente: string | null; source: string }>()

    // Primero insertar cancela_renueva, luego naranja (así naranja sobreescribe)
    const sorted = [...(baseRows ?? [])].sort((a, b) => {
      if (a.source === 'naranja' && b.source !== 'naranja') return 1   // naranja va al final (sobreescribe)
      if (a.source !== 'naranja' && b.source === 'naranja') return -1
      return 0
    })

    for (const row of sorted) {
      const entry = { cod_cliente: row.cod_cliente ?? null, source: row.source ?? 'naranja' }
      if (row.telefono_1) {
        const norm = normalizePhone(row.telefono_1)
        if (norm.length >= 8) phoneMap.set(norm, entry)
      }
      if (row.telefono_2) {
        const norm = normalizePhone(row.telefono_2)
        if (norm.length >= 8) phoneMap.set(norm, entry)
      }
    }

    // 3. Cargar todas las conversaciones
    const { data: convs, error: convErr } = await service
      .from('conversations')
      .select('id, client_phone, client_name, display_name')

    if (convErr) return NextResponse.json({ error: convErr.message }, { status: 500 })

    // 4. Calcular updates necesarios
    type UpdateRow = {
      id: string
      client_phone: string
      display_name: string | null
      client_name: string | null
      cod_cliente: string | null
      base_source: string
    }
    const updates: UpdateRow[] = []

    for (const conv of convs ?? []) {
      if (!conv.client_phone) continue
      const norm = normalizePhone(conv.client_phone)
      if (norm.length < 8) continue
      const match = phoneMap.get(norm)
      if (match) {
        updates.push({
          id: conv.id,
          client_phone: conv.client_phone,
          display_name: conv.display_name ?? null,
          client_name: conv.client_name ?? null,
          cod_cliente: match.cod_cliente,
          base_source: match.source,
        })
      }
    }

    // 5. Actualizar en lotes de 100
    const BATCH = 100
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH)
      await Promise.all(
        batch.map(u =>
          service
            .from('conversations')
            .update({ cod_cliente: u.cod_cliente, base_source: u.base_source })
            .eq('id', u.id)
        )
      )
    }

    const naranja = updates.filter(u => u.base_source === 'naranja').length
    const cancelaRenueva = updates.filter(u => u.base_source === 'cancela_renueva').length

    return NextResponse.json({
      matched: updates.length,
      naranja,
      cancela_renueva: cancelaRenueva,
      items: updates.map(u => ({
        name: u.display_name ?? u.client_name ?? u.client_phone,
        phone: u.client_phone,
        cod_cliente: u.cod_cliente,
        source: u.base_source,
      })),
    })
  } catch (err) {
    console.error('Error en match-retroactive:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
