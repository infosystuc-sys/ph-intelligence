import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const { vendedorId, all } = body as { vendedorId?: string; all?: boolean }

    if (!vendedorId && !all) {
      return NextResponse.json({ error: 'Se requiere vendedorId o all:true' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    let query = service.from('analysis_logs').delete()
    if (!all) query = query.eq('vendedor_id', vendedorId!)

    const { error, count } = await query.select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ deleted: count ?? 0 })
  } catch (err) {
    console.error('[AnalysisLogs DELETE]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const conversationId = searchParams.get('conversationId')
    const vendedorId     = searchParams.get('vendedorId')
    const limit          = Math.min(Number(searchParams.get('limit') ?? '50'), 200)

    if (!conversationId && !vendedorId) {
      return NextResponse.json({ error: 'Se requiere conversationId o vendedorId' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    let query = service
      .from('analysis_logs')
      .select(`
        id,
        conversation_id,
        vendedor_id,
        triggered_by,
        status,
        analysis_id,
        model_used,
        error_message,
        duration_ms,
        message_count,
        created_at,
        conversation:conversations ( client_name, client_phone, display_name ),
        vendedor:users ( full_name )
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (conversationId) query = query.eq('conversation_id', conversationId)
    if (vendedorId)     query = query.eq('vendedor_id', vendedorId)

    const { data, error } = await query

    if (error) {
      console.error('[AnalysisLogs] Error consultando logs:', error)
      return NextResponse.json({ error: 'Error interno al consultar logs' }, { status: 500 })
    }

    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    console.error('[AnalysisLogs] Error inesperado:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
