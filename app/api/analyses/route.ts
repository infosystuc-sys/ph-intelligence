import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('users').select('role, id').eq('id', user.id).single()

    const { searchParams } = new URL(req.url)
    const vendorId  = searchParams.get('vendorId') ?? ''
    const stage     = searchParams.get('stage') ?? ''
    const sentiment = searchParams.get('sentiment') ?? ''
    const minScore  = parseInt(searchParams.get('minScore') ?? '0')
    const maxScore  = parseInt(searchParams.get('maxScore') ?? '100')
    const page      = parseInt(searchParams.get('page') ?? '1')
    const limit     = parseInt(searchParams.get('limit') ?? '50')
    const offset    = (page - 1) * limit

    const service = createServiceSupabaseClient()

    let query = service
      .from('ai_analyses')
      .select(`
        id, quality_score, conversation_stage, sentiment, analyzed_at, model_used,
        conversation:conversations(id, client_name, client_phone, display_name, remote_jid, base_cliente),
        vendedor:users!vendedor_id(id, full_name)
      `, { count: 'exact' })
      .gte('quality_score', minScore)
      .lte('quality_score', maxScore)
      .order('analyzed_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (vendorId) {
      query = query.eq('vendedor_id', vendorId)
    } else if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service.from('users').select('id').eq('supervisor_id', user.id)
      const ids = myVendors?.map(v => v.id) ?? []
      if (ids.length) query = query.in('vendedor_id', ids)
    } else if (profile?.role === 'vendedor') {
      query = query.eq('vendedor_id', user.id)
    }

    if (stage)     query = query.eq('conversation_stage', stage)
    if (sentiment) query = query.eq('sentiment', sentiment)

    const { data, error, count } = await query

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Filtrar análisis cuya conversación sea grupo o teléfono de empleado.
    // Aplica a análisis viejos creados antes de los filtros, y a cualquier dato
    // que se cuele en el futuro.
    type AnaConv = {
      id?: string
      client_phone?: string
      remote_jid?: string | null
    } | null

    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    const filtered = (data ?? []).filter(row => {
      const conv = row.conversation as AnaConv
      if (!conv) return true   // si no hay conv asociada por alguna razón, no filtramos
      if (typeof conv.remote_jid === 'string' && conv.remote_jid.endsWith('@g.us')) return false
      if (conv.client_phone && employeePhoneSet.has(conv.client_phone))             return false
      return true
    })

    // Nota: count refleja el total ANTES del filtro client-side. Devolvemos el count
    // real del slice filtrado para que la UI no muestre páginas con resultados ocultos.
    return NextResponse.json({ data: filtered, count: filtered.length, page, limit, totalRaw: count })
  } catch (err) {
    console.error('Error en /api/analyses:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// Borrar análisis seleccionados — solo admin y supervisor.
// Body: { ids: string[] }. Para supervisor, valida que cada análisis sea de uno de sus vendedores.
export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    const role = profile?.role
    if (!['admin', 'supervisor'].includes(role ?? '')) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const ids = Array.isArray(body.ids) ? (body.ids as string[]).filter(x => typeof x === 'string') : []
    if (!ids.length) {
      return NextResponse.json({ error: 'ids es requerido y no puede estar vacío' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()

    // Para supervisor: solo puede borrar análisis de sus vendedores.
    // Admin: puede borrar cualquiera.
    if (role === 'supervisor') {
      const { data: myVendors } = await service.from('users').select('id').eq('supervisor_id', user.id)
      const allowedVendorIds = new Set((myVendors ?? []).map((v: { id: string }) => v.id))

      const { data: targets, error: targetsErr } = await service
        .from('ai_analyses').select('id, vendedor_id').in('id', ids)
      if (targetsErr) return NextResponse.json({ error: targetsErr.message }, { status: 500 })

      const notAllowed = (targets ?? []).filter(t => !allowedVendorIds.has(t.vendedor_id as string))
      if (notAllowed.length) {
        return NextResponse.json(
          { error: `No tenés permiso para borrar ${notAllowed.length} de los análisis seleccionados (no son de tus vendedores)` },
          { status: 403 },
        )
      }
    }

    const { error: delErr, count } = await service
      .from('ai_analyses').delete({ count: 'exact' }).in('id', ids)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

    return NextResponse.json({ deleted: count ?? 0 })
  } catch (err) {
    console.error('Error en DELETE /api/analyses:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
