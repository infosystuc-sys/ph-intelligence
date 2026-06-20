import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

// GET /api/dashboard/vendor-initiated/conversations?day=2026-06-20&vendedorId=<uuid>&responded=true
// Devuelve los conversation_id detrás del número de "Iniciadas"/"Con respuesta"
// de la tabla del dashboard (ver supabase/fn_vendor_initiated_conversation_ids.sql).
// Sin vendedorId → todas las del día (fila "Total").
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data: profile } = await service.from('users').select('role').eq('id', user.id).single()

    const { searchParams } = new URL(req.url)
    const day = searchParams.get('day')
    if (!day) return NextResponse.json({ error: 'day es requerido' }, { status: 400 })
    const vendedorIdParam = searchParams.get('vendedorId') || null
    const respondedOnly = searchParams.get('responded') === 'true'

    const { data, error } = await service.rpc('get_vendor_initiated_conversation_ids', {
      p_day: day,
      p_vendedor_id: vendedorIdParam,
      p_responded_only: respondedOnly,
    })
    if (error) {
      const hint = error.message.includes('does not exist')
        ? ' — Ejecutá la migración supabase/fn_vendor_initiated_conversation_ids.sql en Supabase'
        : ''
      return NextResponse.json({ error: error.message + hint }, { status: 500 })
    }

    type Row = { conversation_id: string; vendedor_id: string }
    let rows = (data ?? []) as Row[]

    // Mismo alcance por rol que /api/dashboard/vendor-initiated: un vendedor no
    // puede ver conversaciones de otro vendedor manipulando vendedorId en la URL.
    if (profile?.role === 'vendedor') {
      rows = rows.filter(r => r.vendedor_id === user.id)
    } else if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service.from('users').select('id').eq('supervisor_id', user.id)
      const allowed = new Set((myVendors ?? []).map(v => v.id))
      rows = rows.filter(r => allowed.has(r.vendedor_id))
    }

    return NextResponse.json({ conversationIds: rows.map(r => r.conversation_id) })
  } catch (err) {
    console.error('Error en vendor-initiated/conversations:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
