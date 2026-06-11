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
    // ?all=true → paginar internamente hasta agotar (PostgREST cap-ea .select() a 1000
    // por default; con limit alto en cliente igual venían truncadas)
    const fetchAll = searchParams.get('all') === 'true'
    // ?includeEmpty=true → incluye conversaciones con 0 mensajes. Default: las excluye.
    // Las conversaciones vacías típicamente vienen de eventos protocolares de WhatsApp
    // (rotación de claves, reacciones, read receipts) que N8N upsertea como conversación
    // pero no producen mensajes guardables → quedan como cards huecas en la UI.
    const includeEmpty = searchParams.get('includeEmpty') === 'true'

    const service = createServiceSupabaseClient()

    // Construye la query base reutilizable (sin range, sin count). Aplica todos los
    // filtros menos `stage` que se aplica post-fetch sobre ai_analysis.
    const buildQuery = (withCount: boolean) => {
      let q = service
        .from('conversations')
        .select(`
          *,
          vendedor:users!vendedor_id(id, full_name, avatar_url, role),
          ai_analysis:ai_analyses(id, quality_score, conversation_stage, sentiment, analyzed_at)
        `, withCount ? { count: 'exact' } : undefined)
        .order('last_message_at', { ascending: false })

      if (vendorId) {
        q = q.eq('vendedor_id', vendorId)
      } else if (profile?.role === 'supervisor') {
        // El filtro de vendedor se aplica luego en `applyRoleFilter` con un await
        // — esta función queda síncrona.
      } else if (profile?.role === 'vendedor') {
        q = q.eq('vendedor_id', user.id)
      }

      // Excluir histórico del listado principal; histórico tiene su propia página
      if (status) q = q.eq('status', status)
      else        q = q.neq('status', 'historico')
      if (instanceId) q = q.eq('instance_id', instanceId)

      // Excluir conversaciones vacías por default. El trigger en messages mantiene
      // message_count sincronizado, así que confiar en esto es seguro.
      if (!includeEmpty) q = q.gt('message_count', 0)

      if (search) {
        q = q.or(
          `display_name.ilike.%${search}%,client_name.ilike.%${search}%,client_phone.ilike.%${search}%,base_localidad.ilike.%${search}%`
        )
      }
      return q
    }

    // Resolver vendedores del supervisor una sola vez (si aplica).
    let supervisorVendorIds: string[] | null = null
    if (!vendorId && profile?.role === 'supervisor') {
      const { data: myVendors } = await service.from('users').select('id').eq('supervisor_id', user.id)
      supervisorVendorIds = myVendors?.map(v => v.id) ?? []
    }

    const applyRoleFilter = <T extends ReturnType<typeof buildQuery>>(q: T): T => {
      if (supervisorVendorIds) return q.in('vendedor_id', supervisorVendorIds) as T
      return q
    }

    type ConvRecord = Record<string, unknown> & {
      ai_analysis?: Array<{ conversation_stage: string; analyzed_at: string }>
    }

    let rows: ConvRecord[]
    let totalCount: number | null = null

    if (fetchAll) {
      const PAGE = 1000
      const acc: ConvRecord[] = []
      let from = 0
      while (true) {
        const { data, error } = await applyRoleFilter(buildQuery(false)).range(from, from + PAGE - 1)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data || data.length === 0) break
        acc.push(...(data as ConvRecord[]))
        if (data.length < PAGE) break
        from += PAGE
      }
      rows = acc
      totalCount = acc.length
    } else {
      const { data, error, count } = await applyRoleFilter(buildQuery(true)).range(offset, offset + limit - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      rows = (data ?? []) as ConvRecord[]
      totalCount = count ?? null
    }

    let filtered = rows
    if (stage) {
      filtered = filtered.filter(c => {
        const analyses = c.ai_analysis ?? null
        if (!analyses || analyses.length === 0) return false
        const latest = [...analyses].sort((a, b) =>
          new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime()
        )[0]
        return latest.conversation_stage === stage
      })
    }

    return NextResponse.json({ data: filtered, count: totalCount, page, limit })
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
      if (error) {
        const hint = status === 'historico'
          ? ' — Ejecutá la migración supabase/fix_conversations_status_historico.sql en Supabase'
          : ''
        return NextResponse.json({ error: error.message + hint }, { status: 500 })
      }
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
