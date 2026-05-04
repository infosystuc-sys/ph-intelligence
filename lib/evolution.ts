import https from 'https'
import http from 'http'
import { createServiceSupabaseClient } from './supabase-server'
import { EvolutionChat, EvolutionMessage, WhatsappInstance } from '@/types'

// Agente HTTPS que acepta certificados auto-firmados (Easypanel usa self-signed cert).
// Se aplica solo a llamadas a Evolution API, no afecta Supabase ni Anthropic.
const sslAgent = new https.Agent({ rejectUnauthorized: false })

// Wrapper de fetch compatible con certificados auto-firmados.
// Usa https/http de Node.js directamente en lugar del fetch nativo.
export async function evolutionFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const secure = u.protocol === 'https:'
    const req = (secure ? https : http).request(
      {
        hostname: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: u.pathname + u.search,
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        agent: secure ? sslAgent : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 200 }))
        )
      }
    )
    req.on('error', reject)
    if (init?.signal) {
      ;(init.signal as AbortSignal).addEventListener('abort', () => {
        req.destroy()
        reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
      })
    }
    const body = init?.body
    if (typeof body === 'string') req.write(body)
    req.end()
  })
}

// ── Cliente Evolution API ─────────────────────────────────────────────────────
export class EvolutionAPIClient {
  private apiUrl: string
  private apiKey: string
  private instanceName: string

  constructor(instance: WhatsappInstance) {
    // La URL base se toma del env var si está definida; la almacenada puede estar desactualizada
    this.apiUrl = process.env.EVOLUTION_API_BASE_URL || instance.api_url
    this.apiKey = instance.api_key
    this.instanceName = instance.instance_name
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.apiUrl}${path}`
    const res = await evolutionFetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.apiKey,
        ...options?.headers,
      },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Evolution API error [${res.status}]: ${text}`)
    }

    return res.json()
  }

  // Listar conversaciones de la instancia
  async listChats(): Promise<EvolutionChat[]> {
    // Evolution API v2 usa POST con body vacío; v1 usaba GET sin body.
    // Intentamos POST primero y hacemos fallback a GET.
    for (const method of ['POST', 'GET'] as const) {
      try {
        const options: RequestInit = { method }
        if (method === 'POST') {
          options.body = JSON.stringify({ where: {} })
        }
        const data = await this.fetch<unknown>(
          `/chat/findChats/${this.instanceName}`,
          options
        )

        // Normalizamos cualquier formato conocido de la respuesta
        let arr: unknown[] | null = null
        if (Array.isArray(data)) {
          arr = data
        } else if (typeof data === 'object' && data !== null) {
          const obj = data as Record<string, unknown>
          // { chats: [...] }  |  { data: [...] }  |  { records: [...] }
          for (const key of ['chats', 'data', 'records', 'messages']) {
            if (Array.isArray(obj[key])) { arr = obj[key] as unknown[]; break }
          }
        }

        if (arr !== null) {
          // Normalizar cada elemento: algunos devuelven `id` en lugar de `remoteJid`
          return arr.map((c: unknown) => {
            const chat = c as Record<string, unknown>
            return {
              id:          (chat.id ?? chat.remoteJid ?? '') as string,
              remoteJid:   (chat.remoteJid ?? chat.id ?? '') as string,
              name:        (chat.name ?? null) as string | null,
              lastMessage: chat.lastMessage as EvolutionChat['lastMessage'],
            }
          }).filter(c => !!c.remoteJid)
        }

        console.warn(`[Evolution] listChats (${method}) respuesta no reconocida para ${this.instanceName}:`, JSON.stringify(data).slice(0, 300))
      } catch (e) {
        // Si POST devuelve 4xx, el fallback GET se ejecutará en la siguiente iteración
        console.warn(`[Evolution] listChats (${method}) error para ${this.instanceName}:`, e)
      }
    }

    return []
  }

  // Obtener mensajes de una conversación
  async getMessages(remoteJid: string, limit = 50): Promise<EvolutionMessage[]> {
    try {
      const data = await this.fetch<unknown>(
        `/chat/findMessages/${this.instanceName}`,
        {
          method: 'POST',
          body: JSON.stringify({
            where: { key: { remoteJid } },
            limit,
          }),
        }
      )
      // Distintos formatos posibles
      const records =
        (data as { messages?: { records?: EvolutionMessage[] } })?.messages?.records ??
        (data as { records?: EvolutionMessage[] })?.records ??
        (Array.isArray(data) ? data as EvolutionMessage[] : [])
      return records
    } catch (e) {
      console.error(`[Evolution] getMessages error para ${remoteJid}:`, e)
      return []
    }
  }

  // Registrar webhook para recibir mensajes en tiempo real
  async registerWebhook(webhookUrl: string): Promise<boolean> {
    try {
      await this.fetch(`/webhook/set/${this.instanceName}`, {
        method: 'POST',
        body: JSON.stringify({
          url: webhookUrl,
          webhook_by_events: false,
          webhook_base64: false,
          events: [
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'CONNECTION_UPDATE',
          ],
        }),
      })
      return true
    } catch {
      return false
    }
  }

  // Verificar estado de conexión
  async getConnectionState(): Promise<'open' | 'close' | 'connecting'> {
    try {
      const data = await this.fetch<{ instance: { state: string } }>(
        `/instance/connectionState/${this.instanceName}`
      )
      return (data?.instance?.state as 'open' | 'close' | 'connecting') ?? 'close'
    } catch {
      return 'close'
    }
  }
}

// ── Servicio de Sincronización ────────────────────────────────────────────────
export async function syncInstanceConversations(
  instance: WhatsappInstance,
  daysBack = 30,
): Promise<{
  synced: number
  errors: number
  skipped: number
  chatsFound: number
  errorLog: string[]
}> {
  const supabase = createServiceSupabaseClient()
  const client = new EvolutionAPIClient(instance)
  let synced = 0
  let errors = 0
  let skipped = 0
  const errorLog: string[] = []

  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000

  const allChats = await client.listChats()
  console.log(`[Sync] ${instance.instance_name}: ${allChats.length} chats en Evolution API`)

  // Filtrar: solo individuales y con actividad dentro del período
  const chats = allChats.filter(chat => {
    const jid = chat.remoteJid || chat.id
    if (!jid || jid.endsWith('@g.us')) return false
    const ts = chat.lastMessage?.messageTimestamp
    if (!ts) return true // sin timestamp → incluir por las dudas
    return ts * 1000 >= cutoff
  })

  skipped = allChats.length - chats.length
  console.log(`[Sync] ${instance.instance_name}: ${chats.length} dentro de ${daysBack} días (${skipped} omitidos)`)

  for (const chat of chats) {
    try {
      const jid = chat.remoteJid || chat.id
      if (!jid) continue
      const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '')

      // Upsert conversación — NO incluimos last_message_at aquí para no
      // sobreescribir valores correctos con datos incorrectos del campo chat.lastMessage
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .upsert({
          instance_id: instance.id,
          remote_jid: jid,
          vendedor_id: instance.vendedor_id,
          client_name: chat.name ?? null,
          client_phone: phone,
          status: 'active',
        }, { onConflict: 'instance_id,remote_jid' })
        .select()
        .single()

      if (convError || !conv) {
        const msg = `${phone}: ${convError?.message ?? 'sin datos'}`
        console.error(`[Sync] Error upsert ${msg}`)
        if (errorLog.length < 100) errorLog.push(msg)
        errors++
        continue
      }

      // Sincronizar mensajes
      const messages = await client.getMessages(jid, 100)
      let maxMsgTs = 0
      for (const msg of messages) {
        const content = extractMessageContent(msg)
        if (!content) continue

        const ts = (msg.messageTimestamp ?? 0) * 1000
        if (ts > maxMsgTs) maxMsgTs = ts

        await supabase.from('messages').upsert({
          conversation_id: conv.id,
          external_id: msg.key.id,
          content,
          type: detectMessageType(msg),
          from_me: msg.key.fromMe,
          msg_timestamp: ts > 0 ? new Date(ts).toISOString() : new Date().toISOString(),
          media_url: extractMediaUrl(msg),
        }, { onConflict: 'external_id', ignoreDuplicates: true })
      }

      // Actualizar last_message_at con el timestamp real del mensaje más reciente.
      // Aprovechar el mismo UPDATE para completar client_name desde el pushName
      // del primer mensaje entrante (fromMe=false), que sí corresponde al cliente.
      const clientPushName = messages
        .filter(msg => !msg.key.fromMe && msg.pushName)
        .map(msg => msg.pushName!)[0] ?? null

      const updatePayload: Record<string, string> = {}
      if (maxMsgTs > 0) updatePayload.last_message_at = new Date(maxMsgTs).toISOString()
      if (clientPushName && !conv.client_name) updatePayload.client_name = clientPushName

      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from('conversations')
          .update(updatePayload)
          .eq('id', conv.id)
      }

      synced++
    } catch (e) {
      const msg = `${chat.remoteJid || chat.id || '?'}: ${e instanceof Error ? e.message : String(e)}`
      console.error(`[Sync] Error procesando chat: ${msg}`)
      if (errorLog.length < 100) errorLog.push(msg)
      errors++
    }
  }

  // Actualizar last_sync_at
  await supabase
    .from('whatsapp_instances')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', instance.id)

  console.log(`[Sync] ${instance.instance_name}: ${synced} ok · ${errors} errores · ${skipped} omitidos`)
  return { synced, errors, skipped, chatsFound: allChats.length, errorLog }
}

// ── Helpers para procesar mensajes ────────────────────────────────────────────
export function extractMessageContent(msg: EvolutionMessage): string {
  const m = msg.message
  if (m.conversation) return m.conversation
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.imageMessage) return '[Imagen]'
  if (m.audioMessage) return '[Audio]'
  if (m.documentMessage?.caption) return m.documentMessage.caption
  if (m.documentMessage?.fileName) return `[Documento: ${m.documentMessage.fileName}]`
  if (m.documentMessage) return '[Documento]'
  return ''
}

export function detectMessageType(msg: EvolutionMessage): 'text' | 'image' | 'audio' | 'document' {
  if (msg.message.imageMessage) return 'image'
  if (msg.message.audioMessage) return 'audio'
  if (msg.message.documentMessage) return 'document'
  return 'text'
}

export function extractMediaUrl(msg: EvolutionMessage): string | null {
  if (msg.message.imageMessage?.url) return msg.message.imageMessage.url
  if (msg.message.audioMessage?.url) return msg.message.audioMessage.url
  if (msg.message.documentMessage?.url) return msg.message.documentMessage.url
  return null
}

/**
 * @deprecated No se usa desde el webhook directo.
 * Los mensajes entrantes son procesados por N8N antes de llegar a esta app.
 * Conservada como referencia hasta confirmar migración completa.
 */
// ── Procesar mensaje entrante del webhook ─────────────────────────────────────
export async function processWebhookMessage(payload: {
  instance: string
  data: EvolutionMessage
}): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const msg = payload.data

  if (!msg?.key?.remoteJid || !msg?.message) return

  const isGroup = msg.key.remoteJid.endsWith('@g.us')
  if (isGroup) return

  // Buscar instancia
  const { data: instance } = await supabase
    .from('whatsapp_instances')
    .select('*')
    .eq('instance_name', payload.instance)
    .single()

  if (!instance) return

  const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '')

  // Upsert conversación
  const { data: conv } = await supabase
    .from('conversations')
    .upsert({
      instance_id: instance.id,
      remote_jid: msg.key.remoteJid,
      vendedor_id: instance.vendedor_id,
      client_phone: phone,
      status: 'active',
    }, { onConflict: 'instance_id,remote_jid' })
    .select()
    .single()

  if (!conv) return

  const content = extractMessageContent(msg)
  if (!content) return

  await supabase.from('messages').upsert({
    conversation_id: conv.id,
    external_id: msg.key.id,
    content,
    type: detectMessageType(msg),
    from_me: msg.key.fromMe,
    msg_timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
    media_url: extractMediaUrl(msg),
  }, { onConflict: 'external_id', ignoreDuplicates: true })
}
