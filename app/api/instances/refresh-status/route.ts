import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { checkInstanceHealth } from '@/lib/instance-health'
import { InstanceHealthResult } from '@/types'

export const maxDuration = 30

// POST /api/instances/refresh-status
// Verifica conexión + webhook + último mensaje recibido de cada instancia
// contra Evolution API y la base, y actualiza whatsapp_instances.status.
// Responde con { results: InstanceHealthResult[] }
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data: instances } = await service
      .from('whatsapp_instances')
      .select('id, instance_name, api_key, api_url')

    if (!instances?.length) return NextResponse.json({ results: [] })

    const checks = await Promise.allSettled(
      instances.map(async (inst): Promise<InstanceHealthResult> => {
        const result = await checkInstanceHealth(inst, service)
        await service
          .from('whatsapp_instances')
          .update({ status: result.connected ? 'connected' : 'disconnected' })
          .eq('id', inst.id)
        return result
      })
    )

    const results: InstanceHealthResult[] = checks.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            instanceId: instances[i].id,
            connected: false,
            connectionVerified: false,
            connectionState: 'unknown',
            disconnectReason: null,
            disconnectedAt: null,
            webhookVerified: false,
            webhookOk: null,
            webhookUrl: null,
            lastInboundMessageAt: null,
            health: 'yellow',
          }
    )

    return NextResponse.json({ results })
  } catch (err) {
    console.error('[refresh-status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
