import { SupabaseClient } from '@supabase/supabase-js'
import { evolutionFetch } from './evolution'
import { ConnectionState, InstanceHealthResult } from '@/types'

const CHECK_TIMEOUT_MS = 5000

// Códigos de desconexión de Baileys/Evolution (WhiskeySockets/Baileys DisconnectReason).
// Verificado en vivo el 28/7/2026: 401 = sesión cerrada/dispositivo desvinculado
// (motivo real detrás de 8 de las 9 instancias caídas encontradas ese día).
const DISCONNECT_REASONS: Record<number, string> = {
  401: 'Sesión cerrada (dispositivo desvinculado o inicio de sesión en otro lugar)',
  403: 'Prohibido por WhatsApp (posible restricción de cuenta)',
  408: 'Tiempo de espera agotado',
  411: 'Sesión reemplazada por otro dispositivo',
  428: 'Conexión cerrada por WhatsApp',
  440: 'Sesión reemplazada (se inició en otro dispositivo)',
  500: 'Error interno del servidor Evolution',
  515: 'Reinicio de sesión requerido',
}

function describeDisconnectReason(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null
  return DISCONNECT_REASONS[code] ?? `Código de desconexión ${code}`
}

type InstanceRef = { instance_name: string; api_key: string }

async function fetchConnectionInfo(baseUrl: string, instance: InstanceRef): Promise<{
  state: ConnectionState
  disconnectReason: string | null
  disconnectedAt: string | null
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await evolutionFetch(`${baseUrl}/instance/fetchInstances`, {
      headers: { apikey: instance.api_key },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Array<{
      connectionStatus?: string
      disconnectionReasonCode?: number | null
      disconnectionAt?: string | null
    }>
    const info = Array.isArray(data) ? data[0] : null
    if (!info) throw new Error('Respuesta vacía de fetchInstances')
    const state: ConnectionState = (info.connectionStatus as ConnectionState) ?? 'unknown'
    // Evolution no limpia disconnectionReasonCode/disconnectionAt al reconectar —
    // quedan como metadata histórica de la última caída. Mostrarlos para una
    // instancia que está open ahora mismo sería engañoso (verificado en vivo
    // 28/7/2026: JVGonzalez y Quebrachal arrastraban un 401 de días atrás
    // estando conectadas). Solo son relevantes si la instancia no está abierta.
    return {
      state,
      disconnectReason: state === 'open' ? null : describeDisconnectReason(info.disconnectionReasonCode),
      disconnectedAt: state === 'open' ? null : (info.disconnectionAt ?? null),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchWebhookInfo(baseUrl: string, instance: InstanceRef): Promise<{
  ok: boolean
  url: string | null
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await evolutionFetch(`${baseUrl}/webhook/find/${instance.instance_name}`, {
      headers: { apikey: instance.api_key },
      signal: controller.signal,
    })
    // 404 = Evolution respondió que no hay webhook registrado para esta instancia.
    // Es una respuesta válida y definitiva, no un fallo de red — cuenta como "verificado".
    if (res.status === 404) return { ok: false, url: null }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { url?: string; enabled?: boolean; events?: string[] }
    const expectedUrl = process.env.N8N_WEBHOOK_URL
    const ok = !!data.enabled && !!expectedUrl && data.url === expectedUrl && !!data.events?.includes('MESSAGES_UPSERT')
    return { ok, url: data.url ?? null }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchLastInboundMessage(supabase: SupabaseClient, instanceId: string): Promise<string | null> {
  const { data } = await supabase
    .from('conversations')
    .select('last_message_at')
    .eq('instance_id', instanceId)
    .eq('last_message_from_me', false)
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { last_message_at: string } | null)?.last_message_at ?? null
}

// Verifica las 3 señales de una instancia en paralelo. Nunca lanza — cada señal
// que falla queda marcada como "no verificada" en el resultado en vez de tirar
// abajo el chequeo completo de la instancia.
export async function checkInstanceHealth(
  instance: { id: string; instance_name: string; api_key: string; api_url: string },
  supabase: SupabaseClient,
): Promise<InstanceHealthResult> {
  const baseUrl = (process.env.EVOLUTION_API_BASE_URL || instance.api_url).replace(/\/$/, '')

  const [connSettled, webhookSettled, lastMsgSettled] = await Promise.allSettled([
    fetchConnectionInfo(baseUrl, instance),
    fetchWebhookInfo(baseUrl, instance),
    fetchLastInboundMessage(supabase, instance.id),
  ])

  const conn = connSettled.status === 'fulfilled' ? connSettled.value : null
  const webhook = webhookSettled.status === 'fulfilled' ? webhookSettled.value : null
  const lastInboundMessageAt = lastMsgSettled.status === 'fulfilled' ? lastMsgSettled.value : null

  const connectionVerified = conn !== null
  const connectionState: ConnectionState = conn?.state ?? 'unknown'
  const connected = connectionVerified && connectionState === 'open'
  const connectionBad = connectionVerified && !connected

  const webhookVerified = webhook !== null
  const webhookOk = webhook?.ok ?? null
  const webhookBad = webhookVerified && webhookOk === false

  // Precedencia: rojo gana sobre amarillo. Si ya hay evidencia concreta de un
  // problema (conexión cerrada o webhook mal configurado), mostrar "no
  // verificado" por la otra señal sería menos veraz que mostrar el problema real.
  const health: InstanceHealthResult['health'] =
    connectionBad || webhookBad ? 'red'
    : (!connectionVerified || !webhookVerified) ? 'yellow'
    : 'green'

  return {
    instanceId: instance.id,
    connected,
    connectionVerified,
    connectionState,
    disconnectReason: conn?.disconnectReason ?? null,
    disconnectedAt: conn?.disconnectedAt ?? null,
    webhookVerified,
    webhookOk,
    webhookUrl: webhook?.url ?? null,
    lastInboundMessageAt,
    health,
  }
}
