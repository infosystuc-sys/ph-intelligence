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
      .select('role')
      .eq('id', user.id)
      .single()

    const service = createServiceSupabaseClient()

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000 * 7)
      .toISOString()
      .split('T')[0]

    let kpisQuery = service
      .from('daily_kpis')
      .select('*, vendedor:users!vendedor_id(full_name, avatar_url)')
      .gte('date', yesterday)
      .order('date', { ascending: false })

    if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service
        .from('users')
        .select('id')
        .eq('supervisor_id', user.id)

      const vendorIds = myVendors?.map(v => v.id) ?? []
      kpisQuery = kpisQuery.in('vendedor_id', vendorIds)
    } else if (profile?.role === 'vendedor') {
      kpisQuery = kpisQuery.eq('vendedor_id', user.id)
    }

    const { data: kpis } = await kpisQuery

    const { data: instances } = await service
      .from('whatsapp_instances')
      .select('id, status')

    const connected = instances?.filter(i => i.status === 'connected').length ?? 0
    const total = instances?.length ?? 0

    const todayKpis = kpis?.filter(k => k.date === today) ?? []
    const prevKpis = kpis?.filter(k => k.date !== today) ?? []

    // ── Conteo LIVE de conversaciones por vendedor — excluyendo grupos y empleados.
    // No leemos esos números desde daily_kpis porque pueden estar stale (calculados antes
    // del filtro o sin todos los empleados registrados).
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    let convsQuery = service
      .from('conversations')
      .select('vendedor_id, status, remote_jid, client_phone, last_message_at')

    if (profile?.role === 'supervisor') {
      const { data: myVendors } = await service
        .from('users').select('id').eq('supervisor_id', user.id)
      const vendorIds = myVendors?.map(v => v.id) ?? []
      if (vendorIds.length) convsQuery = convsQuery.in('vendedor_id', vendorIds)
    } else if (profile?.role === 'vendedor') {
      convsQuery = convsQuery.eq('vendedor_id', user.id)
    }

    const { data: allConvs } = await convsQuery
    const now = new Date()
    const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    type ConvRow = {
      vendedor_id: string | null
      status: string
      remote_jid: string | null
      client_phone: string
      last_message_at: string | null
    }
    const liveCountByVendor: Record<string, { total: number; unresponded: number }> = {}
    ;(allConvs as ConvRow[] ?? []).forEach(c => {
      if (c.remote_jid?.endsWith('@g.us')) return        // excluir grupos
      if (employeePhoneSet.has(c.client_phone)) return   // excluir empleados
      const vid = c.vendedor_id
      if (!vid) return
      if (!liveCountByVendor[vid]) liveCountByVendor[vid] = { total: 0, unresponded: 0 }
      liveCountByVendor[vid].total++
      if (c.status === 'active' && c.last_message_at && new Date(c.last_message_at) < h24ago) {
        liveCountByVendor[vid].unresponded++
      }
    })

    // Sobrescribir los conteos en los KPIs de hoy con los valores live filtrados
    todayKpis.forEach(k => {
      const live = liveCountByVendor[k.vendedor_id]
      k.conversations_total          = live?.total       ?? 0
      k.conversations_unresponded_24h = live?.unresponded ?? 0
      k.conversations_responded_24h  = (live?.total ?? 0) - (live?.unresponded ?? 0)
    })

    const avgScore = todayKpis.length
      ? todayKpis.reduce((s, k) => s + k.avg_quality_score, 0) / todayKpis.length
      : 0

    const avgScorePrev = prevKpis.length
      ? prevKpis.reduce((s, k) => s + k.avg_quality_score, 0) / prevKpis.length
      : 0

    const unresponded = todayKpis.reduce((s, k) => s + k.conversations_unresponded_24h, 0)
    const totalConvs = todayKpis.reduce((s, k) => s + k.conversations_total, 0)
    const estimatedConversions = todayKpis.reduce((s, k) => s + k.estimated_conversions, 0)

    const pipelineCounts = todayKpis.reduce((acc, k) => {
      const counts = k.pipeline_stage_counts as Record<string, number>
      Object.entries(counts).forEach(([stage, count]) => {
        acc[stage] = (acc[stage] ?? 0) + count
      })
      return acc
    }, {} as Record<string, number>)

    const vendorsImproved = todayKpis.filter(k => {
      const prev = prevKpis.find(p => p.vendedor_id === k.vendedor_id)
      return prev && k.avg_quality_score > prev.avg_quality_score
    }).length

    const vendorsDeclined = todayKpis.filter(k => {
      const prev = prevKpis.find(p => p.vendedor_id === k.vendedor_id)
      return prev && k.avg_quality_score < prev.avg_quality_score
    }).length

    return NextResponse.json({
      avg_quality_score: Math.round(avgScore * 10) / 10,
      avg_quality_score_prev: Math.round(avgScorePrev * 10) / 10,
      unresponded_24h: unresponded,
      estimated_conversions: estimatedConversions,
      estimated_conversions_prev: 0,
      active_conversations: totalConvs,
      pipeline_counts: pipelineCounts,
      vendors_improved: vendorsImproved,
      vendors_declined: vendorsDeclined,
      connected_instances: connected,
      total_instances: total,
      kpis_by_vendor: todayKpis,
    })
  } catch (error) {
    console.error('Error en KPIs:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
