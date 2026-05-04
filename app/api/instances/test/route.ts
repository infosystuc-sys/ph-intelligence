import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { evolutionFetch } from '@/lib/evolution'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await req.json()
    const { instanceId, api_url, api_key, instance_name } = body

    const defaultUrl = process.env.EVOLUTION_API_BASE_URL

    let url = api_url
    let key = api_key
    let name = instance_name

    if (instanceId) {
      const service = createServiceSupabaseClient()
      const { data: inst } = await service
        .from('whatsapp_instances')
        .select('api_url, api_key, instance_name')
        .eq('id', instanceId)
        .single()

      if (!inst) return NextResponse.json({ error: 'Instancia no encontrada' }, { status: 404 })
      url = defaultUrl || inst.api_url
      key = inst.api_key
      name = inst.instance_name
    } else {
      url = defaultUrl || api_url
    }

    if (!url || !key || !name) {
      return NextResponse.json({ error: 'Faltan datos: api_url, api_key, instance_name' }, { status: 400 })
    }

    // Remover barra final para evitar doble slash
    const baseUrl = url.replace(/\/$/, '')
    const endpoint = `${baseUrl}/instance/connectionState/${name}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const res = await evolutionFetch(endpoint, {
        headers: { apikey: key },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        const text = await res.text()
        return NextResponse.json({
          connected: false,
          state: 'error',
          testedUrl: endpoint,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        })
      }

      const data = await res.json()
      const state = data?.instance?.state ?? data?.state ?? 'unknown'
      const connected = state === 'open'

      if (instanceId) {
        const service = createServiceSupabaseClient()
        await service
          .from('whatsapp_instances')
          .update({ status: connected ? 'connected' : 'disconnected' })
          .eq('id', instanceId)
      }

      return NextResponse.json({ connected, state, testedUrl: endpoint, raw: data })
    } catch (fetchError) {
      clearTimeout(timeout)
      const err = fetchError as Error & { cause?: { message?: string; code?: string } }
      const isTimeout = err.name === 'AbortError'

      let errorMsg: string
      if (isTimeout) {
        errorMsg = 'Timeout: la instancia no respondió en 8 segundos'
      } else {
        // Node.js encapsula el error real en err.cause (ECONNREFUSED, CERT_HAS_EXPIRED, etc.)
        const cause = err.cause
        const causeDetail = [cause?.code, cause?.message].filter(Boolean).join(' — ')
        errorMsg = causeDetail || err.message || String(fetchError)
      }

      return NextResponse.json({
        connected: false,
        state: 'unreachable',
        testedUrl: endpoint,
        error: errorMsg,
      })
    }
  } catch (error) {
    return NextResponse.json({ error: 'Error interno', detail: String(error) }, { status: 500 })
  }
}
