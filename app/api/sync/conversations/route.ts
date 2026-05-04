import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { syncInstanceConversations } from '@/lib/evolution'
import { WhatsappInstance } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const instanceId = body?.instanceId as string | undefined

    const serviceSupabase = createServiceSupabaseClient()

    // Verificar rol
    const { data: profile } = await serviceSupabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!profile || !['admin', 'supervisor'].includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    // Obtener instancias a sincronizar
    let query = serviceSupabase.from('whatsapp_instances').select('*')
    if (instanceId) {
      query = query.eq('id', instanceId)
    }

    const { data: instances } = await query

    if (!instances || instances.length === 0) {
      return NextResponse.json({ message: 'No hay instancias configuradas', synced: 0 })
    }

    // Sincronizar en paralelo
    const results = await Promise.allSettled(
      instances.map(inst => syncInstanceConversations(inst as WhatsappInstance, 15))
    )

    const totals = results.reduce(
      (acc, r) => {
        if (r.status === 'fulfilled') {
          acc.synced      += r.value.synced
          acc.errors      += r.value.errors
          acc.skipped     += r.value.skipped
          acc.chatsFound  += r.value.chatsFound
          acc.errorLog.push(...r.value.errorLog)
        } else {
          console.error('[Sync] instancia falló:', r.reason)
        }
        return acc
      },
      { synced: 0, errors: 0, skipped: 0, chatsFound: 0, errorLog: [] as string[] }
    )

    return NextResponse.json({
      message: `Sincronización completada`,
      instances: instances.length,
      ...totals,
      errorLog: totals.errorLog.slice(0, 100),
    })
  } catch (error) {
    console.error('Error en sync:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
