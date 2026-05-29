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

    let query = service
      .from('users')
      .select(`
        *,
        daily_kpis(avg_quality_score, conversations_total, conversations_unresponded_24h, date)
      `)
      .eq('role', 'vendedor')
      .order('full_name')

    if (profile?.role === 'supervisor') {
      query = query.eq('supervisor_id', user.id)
    }

    const { data, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Obtener instancias por vendedor (query separada para evitar ambigüedad de FK)
    const { data: instances } = await service
      .from('whatsapp_instances')
      .select('vendedor_id, id, instance_name, status, phone_number, last_sync_at')

    const instanceByVendor = Object.fromEntries(
      (instances ?? []).map(i => [i.vendedor_id, i])
    )

    // ── Conteo LIVE por vendedor — excluyendo grupos y empleados.
    // Los daily_kpis pueden tener valores stale; recalculamos en vivo para el dashboard.
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    const { data: allConvs } = await service
      .from('conversations')
      .select('vendedor_id, status, remote_jid, client_phone, last_message_at')

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
      if (c.remote_jid?.endsWith('@g.us')) return
      if (employeePhoneSet.has(c.client_phone)) return
      const vid = c.vendedor_id
      if (!vid) return
      if (!liveCountByVendor[vid]) liveCountByVendor[vid] = { total: 0, unresponded: 0 }
      liveCountByVendor[vid].total++
      if (c.status === 'active' && c.last_message_at && new Date(c.last_message_at) < h24ago) {
        liveCountByVendor[vid].unresponded++
      }
    })

    const today = new Date().toISOString().split('T')[0]

    type VendorRow = {
      id: string
      daily_kpis?: Array<{
        date: string
        avg_quality_score: number
        conversations_total: number
        conversations_unresponded_24h: number
      }> | null
    }

    const enriched = (data ?? []).map((v: VendorRow & Record<string, unknown>) => {
      const live = liveCountByVendor[v.id] ?? { total: 0, unresponded: 0 }
      // Reemplazar los conteos del KPI de HOY con los live filtrados
      const patchedKpis = (v.daily_kpis ?? []).map(k => {
        if (k.date !== today) return k
        return {
          ...k,
          conversations_total:           live.total,
          conversations_unresponded_24h: live.unresponded,
        }
      })
      // Si no había KPI de hoy todavía, agregar uno sintético con los conteos live
      // para que el dashboard tenga al menos algo que mostrar
      const hasTodayKpi = patchedKpis.some(k => k.date === today)
      if (!hasTodayKpi && (live.total > 0 || live.unresponded > 0)) {
        patchedKpis.push({
          date: today,
          avg_quality_score: 0,
          conversations_total: live.total,
          conversations_unresponded_24h: live.unresponded,
        })
      }

      return {
        ...v,
        daily_kpis: patchedKpis,
        whatsapp_instance: instanceByVendor[v.id] ?? null,
      }
    })

    return NextResponse.json({ data: enriched })
  } catch (error) {
    console.error('Error en vendors:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
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

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden crear usuarios' }, { status: 403 })
    }

    const body = await req.json()
    const { email: rawEmail, full_name, role, supervisor_id, password } = body

    // Email es opcional — si no se provee se genera un placeholder interno
    const email = rawEmail?.trim()
      || `sin-email.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@ph-intelligence.internal`

    const service = createServiceSupabaseClient()

    const { data: authUser, error: authError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, role },
    })

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // Upsert perfil (insert si no existe aún, update si el trigger ya lo creó)
    const { error: profileError } = await service
      .from('users')
      .upsert({
        id: authUser.user.id,
        email,
        full_name,
        role,
        supervisor_id: supervisor_id || null,
      })

    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, userId: authUser.user.id })
  } catch (error) {
    console.error('Error creando usuario:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
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

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json()
    const { id, email: rawEmail, ...rest } = body

    // Si el email viene vacío, no lo actualizamos (conservamos el existente)
    const updates = rawEmail?.trim() ? { ...rest, email: rawEmail.trim() } : rest

    const service = createServiceSupabaseClient()
    const { data, error } = await service
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
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

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden eliminar usuarios' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const vendorId = searchParams.get('id')

    if (!vendorId) {
      return NextResponse.json({ error: 'ID de vendedor requerido' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()

    // Eliminar el usuario de auth (esto también dispara cascade en la tabla users)
    const { error } = await service.auth.admin.deleteUser(vendorId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error eliminando vendedor:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
