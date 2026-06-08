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

  // Filtrar: solo individuales y con actividad dentro del período.
  // - @g.us  → grupos
  // - @lid   → "Linked IDs" de WhatsApp Communities / usuarios con número oculto.
  //            NO son conversaciones con clientes, sino identificadores opacos.
  const chats = allChats.filter(chat => {
    const jid = chat.remoteJid || chat.id
    if (!jid) return false
    if (jid.endsWith('@g.us')) return false
    if (jid.endsWith('@lid')) return false

    // Obtener timestamp: messageTimestamp (segundos) o updatedAt (ISO string) como fallback
    const ts = chat.lastMessage?.messageTimestamp
    const updatedAtMs = chat.updatedAt ? new Date(chat.updatedAt).getTime() : null

    if (!ts && !updatedAtMs) return true // sin ningún timestamp → incluir

    let tsMs: number
    if (ts) {
      tsMs = ts > 1e12 ? ts : ts * 1000 // manejar segundos o ms
    } else {
      tsMs = updatedAtMs!
    }

    return isNaN(tsMs) || tsMs >= cutoff
  })

  skipped = allChats.length - chats.length
  console.log(`[Sync] ${instance.instance_name}: ${chats.length} dentro de ${daysBack} días (${skipped} omitidos)`)

  for (const chat of chats) {
    try {
      const jid = chat.remoteJid || chat.id
      if (!jid) continue
      const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '')

      // PATCH DEFENSIVO (backfill 27/5-8/6):
      // En vez de upsert (que pisaba status='active' y client_name de filas existentes),
      // primero buscamos. Si existe, la respetamos tal como está. Si no existe, INSERT
      // con los defaults. Así un sync de recuperación nunca reabre conversaciones que
      // el vendedor cerró manualmente ni sobreescribe nombres editados.
      let conv: { id: string; client_name: string | null } | null = null

      const { data: existing } = await supabase
        .from('conversations')
        .select('id, client_name')
        .eq('instance_id', instance.id)
        .eq('remote_jid', jid)
        .maybeSingle()

      if (existing) {
        conv = existing
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from('conversations')
          .insert({
            instance_id: instance.id,
            remote_jid: jid,
            vendedor_id: instance.vendedor_id,
            client_name: chat.name ?? null,
            client_phone: phone,
            status: 'active',
          })
          .select('id, client_name')
          .single()

        if (insertError || !inserted) {
          const msg = `${phone}: ${insertError?.message ?? 'sin datos'}`
          console.error(`[Sync] Error insert ${msg}`)
          if (errorLog.length < 100) errorLog.push(msg)
          errors++
          continue
        }
        conv = inserted
      }

      // Sincronizar mensajes — un mensaje con payload inesperado de Evolution
      // no debe abortar el chat completo (perderíamos los otros 99 mensajes).
      const messages = await client.getMessages(jid, 100)
      let maxMsgTs = 0
      for (const msg of messages) {
        try {
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
        } catch (e) {
          console.warn(`[Sync] ${instance.instance_name}: msg ${msg?.key?.id ?? '?'} omitido —`, e instanceof Error ? e.message : e)
          // continuar con el siguiente mensaje
        }
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

/**
 * Backfill DB-driven: itera las conversaciones que YA tenemos en Supabase para esta
 * instancia y, para cada una, le pide a Evolution los últimos `messagesPerChat` mensajes
 * via getMessages(remote_jid). Útil cuando listChats devuelve metadata stale (típico
 * tras una caída del servicio) pero getMessages sí trae los mensajes reales.
 *
 * No descubre conversaciones nuevas — solo refresca las existentes. Las conversaciones
 * realmente nuevas tienen que entrar por el flujo normal (N8N → webhook → upsert).
 */
export async function backfillMessagesForExistingConvs(
  instance: WhatsappInstance,
  messagesPerChat = 200,
): Promise<{
  conversationsTried:    number
  conversationsUpdated:  number
  messagesInserted:      number   // estimado: cuántos pasaron al upsert (la dedup puede descartar varios)
  errors:                number
  errorLog:              string[]
}> {
  const supabase = createServiceSupabaseClient()
  const client   = new EvolutionAPIClient(instance)

  // Cargar TODAS las conversaciones de esta instancia (paginado para superar el cap de 1000)
  type Row = { id: string; remote_jid: string; client_name: string | null }
  const convs: Row[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, remote_jid, client_name')
      .eq('instance_id', instance.id)
      .neq('status', 'historico')
      .not('remote_jid', 'is', null)
      .not('remote_jid', 'ilike', '%@g.us')
      .not('remote_jid', 'ilike', '%@lid')
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    convs.push(...(data as Row[]))
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`[Backfill] ${instance.instance_name}: ${convs.length} conversaciones a revisar`)

  let conversationsUpdated = 0
  let messagesInserted     = 0
  let errors               = 0
  const errorLog: string[] = []

  for (const conv of convs) {
    try {
      const msgs = await client.getMessages(conv.remote_jid, messagesPerChat)

      // Construir payloads válidos en una sola pasada
      const payloads: Array<{
        conversation_id: string
        external_id:     string
        content:         string
        type:            'text' | 'image' | 'audio' | 'document'
        from_me:         boolean
        msg_timestamp:   string
        media_url:       string | null
      }> = []
      let maxTs = 0

      for (const msg of msgs) {
        try {
          const content = extractMessageContent(msg)
          if (!content) continue
          if (!msg?.key?.id) continue   // sin ID externo no podemos dedup
          const ts = (msg.messageTimestamp ?? 0) * 1000
          if (ts > maxTs) maxTs = ts
          payloads.push({
            conversation_id: conv.id,
            external_id:     msg.key.id,
            content,
            type:            detectMessageType(msg),
            from_me:         msg.key.fromMe,
            msg_timestamp:   ts > 0 ? new Date(ts).toISOString() : new Date().toISOString(),
            media_url:       extractMediaUrl(msg),
          })
        } catch {
          // mensaje con payload raro — saltar este mensaje, seguir con el resto
        }
      }

      if (payloads.length > 0) {
        // Upsert en batch: 1 request a Supabase en vez de N
        const { error: upsertError } = await supabase
          .from('messages')
          .upsert(payloads, { onConflict: 'external_id', ignoreDuplicates: true })
        if (upsertError) throw upsertError
        messagesInserted += payloads.length
      }

      // Actualizar last_message_at con el max real de los mensajes que vinieron
      if (maxTs > 0) {
        await supabase
          .from('conversations')
          .update({ last_message_at: new Date(maxTs).toISOString() })
          .eq('id', conv.id)
        conversationsUpdated++
      }
    } catch (e) {
      const msg = `${conv.remote_jid}: ${e instanceof Error ? e.message : String(e)}`
      console.error(`[Backfill] ${instance.instance_name}: ${msg}`)
      if (errorLog.length < 100) errorLog.push(msg)
      errors++
    }
  }

  await supabase
    .from('whatsapp_instances')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', instance.id)

  console.log(`[Backfill] ${instance.instance_name}: ${conversationsUpdated}/${convs.length} updated, ${messagesInserted} msgs presentados, ${errors} errores`)

  return {
    conversationsTried:   convs.length,
    conversationsUpdated,
    messagesInserted,
    errors,
    errorLog,
  }
}

// ── Helpers para procesar mensajes ────────────────────────────────────────────
// Tolerantes a `message` null/undefined: WhatsApp manda eventos protocolares
// (encryption updates, reactions, etc.) con message=null que igual aparecen
// en getMessages. Los descartamos devolviendo '' / 'text' / null.
export function extractMessageContent(msg: EvolutionMessage): string {
  const m = msg?.message
  if (!m) return ''
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
  const m = msg?.message
  if (!m) return 'text'
  if (m.imageMessage) return 'image'
  if (m.audioMessage) return 'audio'
  if (m.documentMessage) return 'document'
  return 'text'
}

export function extractMediaUrl(msg: EvolutionMessage): string | null {
  const m = msg?.message
  if (!m) return null
  if (m.imageMessage?.url) return m.imageMessage.url
  if (m.audioMessage?.url) return m.audioMessage.url
  if (m.documentMessage?.url) return m.documentMessage.url
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
