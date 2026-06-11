import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

// La métrica existe desde esta fecha — análisis de días anteriores no es confiable
// (acordado: el histórico arranca el 1/6/2026).
const MIN_DATE = '2026-06-01'

// Día actual en Argentina (YYYY-MM-DD). Los msg_timestamp se bucketean en ese huso.
function todayAR(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
}

// GET /api/dashboard/vendor-initiated?from=2026-06-01&to=2026-06-11
// Devuelve, por vendedor y día: conversaciones iniciadas por el vendedor y cuántas
// recibieron respuesta del cliente en el mismo día. Ver definición exacta en
// supabase/fn_vendor_initiated_stats.sql
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data: profile } = await service
      .from('users').select('role').eq('id', user.id).single()

    const { searchParams } = new URL(req.url)
    const today = todayAR()
    let from = searchParams.get('from') ?? today
    let to   = searchParams.get('to')   ?? from
    if (from < MIN_DATE) from = MIN_DATE
    if (to > today)      to = today
    if (to < from)       to = from

    const { data, error } = await service.rpc('get_vendor_initiated_stats', {
      p_start: from,
      p_end:   to,
    })
    if (error) {
      const hint = error.message.includes('does not exist')
        ? ' — Ejecutá la migración supabase/fn_vendor_initiated_stats.sql en Supabase'
        : ''
      return NextResponse.json({ error: error.message + hint }, { status: 500 })
    }

    type Row = { vendedor_id: string; day: string; initiated: number; responded: number }
    let rows = (data ?? []) as Row[]

    // Filtrado por rol — mismo criterio que /api/kpis
    if (profile?.role === 'vendedor') {
      rows = rows.filter(r => r.vendedor_id === user.id)
    } else if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service
        .from('users').select('id').eq('supervisor_id', user.id)
      const allowed = new Set((myVendors ?? []).map(v => v.id))
      rows = rows.filter(r => allowed.has(r.vendedor_id))
    }

    // Resolver nombres
    const ids = [...new Set(rows.map(r => r.vendedor_id))]
    const nameMap = new Map<string, string>()
    if (ids.length > 0) {
      const { data: users } = await service.from('users').select('id, full_name').in('id', ids)
      for (const u of users ?? []) nameMap.set(u.id, u.full_name)
    }

    return NextResponse.json({
      from, to,
      rows: rows.map(r => ({
        ...r,
        vendedor_name: nameMap.get(r.vendedor_id) ?? '—',
      })),
    })
  } catch (err) {
    console.error('Error en vendor-initiated:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
