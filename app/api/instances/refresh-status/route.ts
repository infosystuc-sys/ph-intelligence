import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { evolutionFetch } from '@/lib/evolution'

export const maxDuration = 30

// POST /api/instances/refresh-status
// Consulta el estado real de cada instancia en Evolution API y actualiza la DB.
// Responde con { results: { instanceId, connected, state }[] }
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

    const baseUrl = (process.env.EVOLUTION_API_BASE_URL ?? '').replace(/\/$/, '')

    const checks = await Promise.allSettled(
      instances.map(async (inst) => {
        const instUrl = (baseUrl || inst.api_url).replace(/\/$/, '')
        const endpoint = `${instUrl}/instance/connectionState/${inst.instance_name}`
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        try {
          const res = await evolutionFetch(endpoint, {
            headers: { apikey: inst.api_key },
            signal: controller.signal,
          })
          clearTimeout(timeout)

          const data = res.ok ? await res.json() : null
          const state: string = data?.instance?.state ?? data?.state ?? 'unknown'
          const connected = state === 'open'

          await service
            .from('whatsapp_instances')
            .update({ status: connected ? 'connected' : 'disconnected' })
            .eq('id', inst.id)

          return { instanceId: inst.id, connected, state }
        } catch {
          clearTimeout(timeout)
          await service
            .from('whatsapp_instances')
            .update({ status: 'disconnected' })
            .eq('id', inst.id)
          return { instanceId: inst.id, connected: false, state: 'unreachable' }
        }
      })
    )

    const results = checks.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { instanceId: '', connected: false, state: 'error' }
    )

    return NextResponse.json({ results })
  } catch (err) {
    console.error('[refresh-status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
