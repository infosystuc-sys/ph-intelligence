import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role, supervisor_id')
      .eq('id', user.id)
      .single()

    const { searchParams } = new URL(req.url)
    const vendorId = searchParams.get('vendorId')
    const status = searchParams.get('status')
    const stage = searchParams.get('stage')
    const instanceId = searchParams.get('instanceId')
    const search = searchParams.get('search')?.trim() ?? ''
    const page = parseInt(searchParams.get('page') ?? '1')
    const limit = parseInt(searchParams.get('limit') ?? '50')
    const offset = (page - 1) * limit

    const service = createServiceSupabaseClient()

    let query = service
      .from('conversations')
      .select(`
        *,
        vendedor:users!vendedor_id(id, full_name, avatar_url, role),
        ai_analysis:ai_analyses(id, quality_score, conversation_stage, sentiment, analyzed_at)
      `, { count: 'exact' })
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (vendorId) {
      query = query.eq('vendedor_id', vendorId)
    } else if (profile?.role === 'supervisor') {
      // Supervisor: solo ve las conversaciones de sus vendedores
      const { data: myVendors } = await service.from('users').select('id').eq('supervisor_id', user.id)
      const vendorIds = myVendors?.map(v => v.id) ?? []
      query = query.in('vendedor_id', vendorIds)
    } else if (profile?.role === 'vendedor') {
      query = query.eq('vendedor_id', user.id)
    }

    // Excluir histórico del listado principal; histórico tiene su propia página
    if (status) query = query.eq('status', status)
    else        query = query.neq('status', 'historico')
    if (instanceId) query = query.eq('instance_id', instanceId)

    // Búsqueda server-side: nombre, teléfono, cod_cliente
    if (search) {
      query = query.or(
        `display_name.ilike.%${search}%,client_name.ilike.%${search}%,client_phone.ilike.%${search}%,cod_cliente.ilike.%${search}%`
      )
    }

    const { data, error, count } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    let filtered = data ?? []
    if (stage) {
      filtered = filtered.filter(c => {
        const analyses = c.ai_analysis as Array<{ conversation_stage: string }> | null
        return analyses && analyses.length > 0 && analyses[0].conversation_stage === stage
      })
    }

    return NextResponse.json({ data: filtered, count, page, limit })
  } catch (error) {
    console.error('Error en conversations:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await req.json()
    const service = createServiceSupabaseClient()

    // Bulk update: { ids: string[], status: string }
    if (Array.isArray(body.ids)) {
      const { ids, status } = body as { ids: string[]; status: string }
      if (!ids.length || !status) {
        return NextResponse.json({ error: 'ids y status son requeridos' }, { status: 400 })
      }
      const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
      if (!['admin', 'supervisor'].includes(profile?.role ?? '')) {
        return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
      }
      const { error } = await service.from('conversations').update({ status }).in('id', ids)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ updated: ids.length })
    }

    // Single update: { id: string, status?, display_name? }
    const { id, status, display_name } = body
    if (!id) return NextResponse.json({ error: 'id es requerido' }, { status: 400 })

    const updates: Record<string, string | null> = {}
    if (status !== undefined) updates.status = status
    if (display_name !== undefined) updates.display_name = display_name?.toString().trim() || null

    const { data, error } = await service
      .from('conversations').update(updates).eq('id', id).select().single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
  } catch (error) {
    console.error('Error en PATCH conversations:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'supervisor'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json()
    const { ids } = body as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids requeridos' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    const { error } = await service.from('conversations').delete().in('id', ids)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ deleted: ids.length })
  } catch (error) {
    console.error('Error en DELETE conversations:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
