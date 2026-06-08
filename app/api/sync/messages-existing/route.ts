import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { backfillMessagesForExistingConvs } from '@/lib/evolution'
import { WhatsappInstance } from '@/types'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// POST /api/sync/messages-existing
// Backfill DB-driven: pide getMessages para cada conversación que YA está en Supabase.
// Útil cuando Evolution.listChats devuelve metadata stale (típico tras una caída).
// Body opcional:
//   - instanceId: string  → procesar solo esta instancia. Default: todas.
//   - messagesPerChat: number (10-500). Default 200.
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const instanceId      = body?.instanceId as string | undefined
    const rawMsgsPerChat  = body?.messagesPerChat
    const messagesPerChat = typeof rawMsgsPerChat === 'number' && rawMsgsPerChat >= 10 && rawMsgsPerChat <= 500
      ? Math.floor(rawMsgsPerChat)
      : 200

    const service = createServiceSupabaseClient()

    const { data: profile } = await service
      .from('users').select('role').eq('id', user.id).single()
    if (!profile || !['admin', 'supervisor'].includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    let query = service.from('whatsapp_instances').select('*')
    if (instanceId) query = query.eq('id', instanceId)
    const { data: instances } = await query

    if (!instances || instances.length === 0) {
      return NextResponse.json({ message: 'No hay instancias configuradas', conversationsTried: 0 })
    }

    const results = await Promise.allSettled(
      instances.map(inst => backfillMessagesForExistingConvs(inst as WhatsappInstance, messagesPerChat)),
    )

    const totals = results.reduce(
      (acc, r) => {
        if (r.status === 'fulfilled') {
          acc.conversationsTried   += r.value.conversationsTried
          acc.conversationsUpdated += r.value.conversationsUpdated
          acc.messagesInserted     += r.value.messagesInserted
          acc.errors               += r.value.errors
          acc.errorLog.push(...r.value.errorLog)
        } else {
          console.error('[messages-existing] instancia falló:', r.reason)
          acc.errors++
          acc.errorLog.push(`instancia: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
        return acc
      },
      {
        conversationsTried:   0,
        conversationsUpdated: 0,
        messagesInserted:     0,
        errors:               0,
        errorLog:             [] as string[],
      },
    )

    return NextResponse.json({
      message:  `Backfill DB-driven completado · ${messagesPerChat} msgs/chat`,
      instances: instances.length,
      messagesPerChat,
      ...totals,
      errorLog: totals.errorLog.slice(0, 100),
    })
  } catch (error) {
    console.error('Error en messages-existing:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
