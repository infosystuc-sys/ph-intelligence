import { SupabaseClient } from '@supabase/supabase-js'
import { evolutionFetch } from './evolution'
import { ConnectionState, InstanceHealthResult } from '@/types'

// 10s en vez de 5s: en producción (Vercel -> Easypanel) el viaje puede tardar
// más que en desarrollo local. Se mantiene generoso porque las 3 señales de
// una instancia corren en paralelo (Promise.allSettled) y todas las instancias
// entre sí también, así que el costo real es ~10s por lote, no acumulativo.
const CHECK_TIMEOUT_MS = 10000

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

// Evolution devuelve errores como { response: { message: [...] } } o { message: "..." }.
// Extrae un texto legible del cuerpo para usarlo como motivo — ej. "The '9000'
// instance does not exist" (verificado en vivo el 28/7/2026: 3 instancias con
// api_key guardada en la DB que ya no existen en Evolution, borradas o
// recreadas del lado del servidor sin actualizar nuestra base).
async function describeErrorBody(res: Response, status: number): Promise<string> {
  try {
    const body = await res.json() as { response?: { message?: string[] | string }; message?: string }
    const raw = Array.isArray(body?.response?.message) ? body.response!.message!.join(' ') : (body?.response?.message ?? body?.message)
    if (raw) return `HTTP ${status}: ${raw}`
  } catch { /* cuerpo no es JSON o vino vacío */ }
  return `HTTP ${status}`
}

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
    // Cualquier respuesta HTTP (incluso un error) es una verificación real:
    // Evolution contestó algo concreto sobre la instancia. Solo un fallo de
    // red (timeout, DNS, conexión rechazada) deja la señal sin verificar —
    // eso lo maneja el catch de más arriba en checkInstanceHealth.
    if (!res.ok) {
      return {
        state: 'unknown',
        disconnectReason: `Evolution respondió con error: ${await describeErrorBody(res, res.status)}`,
        disconnectedAt: null,
      }
    }
    const data = await res.json() as Array<{
      connectionStatus?: string
      disconnectionReasonCode?: number | null
      disconnectionAt?: string | null
    }>
    const info = Array.isArray(data) ? data[0] : null
    if (!info) {
      return { state: 'unknown', disconnectReason: 'Evolution no devolvió datos de la instancia', disconnectedAt: null }
    }
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
    // Igual que en fetchConnectionInfo: cualquier respuesta HTTP (404 = sin
    // webhook, 401 = instancia/key inválida, etc.) es una verificación real,
    // no un fallo de red — todas cuentan como "no configurado correctamente".
    if (!res.ok) return { ok: false, url: null }
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

  // Motivo real del fallo cuando no se pudo verificar — sin esto, "no
  // verificado" no dice si fue timeout, DNS, TLS, etc. Se corta a 200 chars:
  // algunos errores de red vienen con stacks larguísimos, no hace falta todo.
  function reasonOf(settled: PromiseSettledResult<unknown>): string | null {
    if (settled.status === 'fulfilled') return null
    const e = settled.reason
    const msg = e instanceof Error ? e.message : String(e)
    return msg.slice(0, 200)
  }

  const conn = connSettled.status === 'fulfilled' ? connSettled.value : null
  const webhook = webhookSettled.status === 'fulfilled' ? webhookSettled.value : null
  const lastInboundMessageAt = lastMsgSettled.status === 'fulfilled' ? lastMsgSettled.value : null
  const connectionCheckError = reasonOf(connSettled)
  const webhookCheckError = reasonOf(webhookSettled)

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
    connectionCheckError,
    disconnectReason: conn?.disconnectReason ?? null,
    disconnectedAt: conn?.disconnectedAt ?? null,
    webhookVerified,
    webhookCheckError,
    webhookOk,
    webhookUrl: webhook?.url ?? null,
    lastInboundMessageAt,
    health,
  }
}
