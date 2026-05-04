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
        conversation:conversations(id, client_name, client_phone, display_name),
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
    return NextResponse.json({ data: data ?? [], count, page, limit })
  } catch (err) {
    console.error('Error en /api/analyses:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
