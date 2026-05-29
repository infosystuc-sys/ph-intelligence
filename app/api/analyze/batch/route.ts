import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { analyzeConversation } from '@/lib/ai-analyzer'

export const maxDuration = 60

// ── Configuración de tiempos ──────────────────────────────────────────────────
const DELAY_BETWEEN_MS   = 6000   // pausa base entre conversaciones
const RATE_LIMIT_WAIT_MS = 20000  // pausa extra al detectar saturación (se acumula)
const MAX_ATTEMPTS       = 3      // reintentos por conversación ante error recuperable

// Palabras clave que indican saturación del servidor de IA
const RATE_LIMIT_KEYS = ['429', '503', '529', 'overloaded', 'rate', 'quota', 'exhausted', 'too many']

function isRateLimit(msg: string): boolean {
  const lower = msg.toLowerCase()
  return RATE_LIMIT_KEYS.some(k => lower.includes(k))
}

function friendlyError(raw: string): string {
  const l = raw.toLowerCase()
  if (l.includes('429') || l.includes('rate') || l.includes('quota') || l.includes('exhausted') || l.includes('too many'))
    return 'Límite de solicitudes de la API excedido (rate limit)'
  if (l.includes('529') || l.includes('overloaded'))
    return 'Servidor de IA saturado (overloaded)'
  if (l.includes('503'))
    return 'Servicio de IA no disponible (503)'
  if (l.includes('parse') || l.includes('json') || l.includes('unexpected token'))
    return 'El modelo devolvió una respuesta inválida (JSON mal formado)'
  if (l.includes('timeout') || l.includes('abort') || l.includes('timed out'))
    return 'Tiempo de espera agotado (timeout)'
  if (l.includes('no hay mensajes') || l.includes('sin mensajes'))
    return 'Sin mensajes suficientes para analizar'
  if (l.includes('conversación no encontrada'))
    return 'Conversación no encontrada en la base de datos'
  // Acortar errores muy largos
  return raw.length > 140 ? raw.slice(0, 140) + '…' : raw
}

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'supervisor'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const limit    = Math.min(parseInt(body.limit    ?? '10'), 15)
    const vendorId = body.vendorId ?? null
    const minHours = parseInt(body.minHours ?? '6')

    const service = createServiceSupabaseClient()
    const since        = new Date(Date.now() - minHours * 60 * 60 * 1000).toISOString()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Conjunto de teléfonos de empleados: excluidos del análisis
    const { data: empPhones } = await service.from('employee_phones').select('phone')
    const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

    // Conjunto de conversaciones que YA tienen un análisis en las últimas `minHours` hs.
    // Estas se excluyen a nivel SQL para no agotar el cap de candidatos con conversaciones
    // que de todas formas se iban a filtrar (causa del bug "no hay conversaciones para analizar").
    const { data: recentlyAnalyzed } = await service
      .from('ai_analyses')
      .select('conversation_id')
      .gte('analyzed_at', since)
    const recentSet = new Set((recentlyAnalyzed ?? []).map(a => a.conversation_id as string))
    const recentIds = [...recentSet]

    // Cap generoso: 500 conversaciones es suficiente para cualquier instancia razonable
    // y evita el problema de que las 30 más recientes ya estén analizadas.
    const CANDIDATE_CAP = 500

    let query = service
      .from('conversations')
      .select(`
        id, vendedor_id, status, remote_jid, message_count, last_message_at,
        client_name, client_phone, display_name,
        ai_analyses:ai_analyses(analyzed_at)
      `)
      .eq('status', 'active')
      .neq('status', 'historico')
      .not('remote_jid', 'ilike', '%@g.us')
      .gte('message_count', 5)
      .gte('last_message_at', sevenDaysAgo)
      .order('last_message_at', { ascending: false })
      .limit(CANDIDATE_CAP)

    if (vendorId) query = query.eq('vendedor_id', vendorId)
    if (recentIds.length > 0) {
      // PostgREST acepta la sintaxis `(id1,id2,...)` para `not.in`
      query = query.not('id', 'in', `(${recentIds.map(id => `"${id}"`).join(',')})`)
    }

    const { data: candidates, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    type CandRow = {
      id: string
      vendedor_id: string
      status: string
      remote_jid: string | null
      message_count: number
      last_message_at: string | null
      client_name: string | null
      client_phone: string
      display_name: string | null
      ai_analyses: Array<{ analyzed_at: string }>
    }

    const pending = ((candidates ?? []) as CandRow[]).filter(c => {
      // Exclusiones explícitas — defensa en profundidad además del filtro del query
      if (c.status === 'historico') return false
      if (c.remote_jid?.endsWith('@g.us')) return false
      if (employeePhoneSet.has(c.client_phone)) return false
      const analyses = c.ai_analyses ?? []
      if (!analyses.length) return true
      const latest = analyses.reduce((a, b) => a.analyzed_at > b.analyzed_at ? a : b)
      return latest.analyzed_at < since
    }).slice(0, limit)

    if (!pending.length) {
      return NextResponse.json({
        analyzed: 0, failed: 0, skipped: 0,
        message: 'No hay conversaciones pendientes de análisis',
        results: [],
      })
    }

    type ResultRow = {
      conversationId: string
      conversationName: string
      success: boolean
      analysisId?: string
      error?: string
      attempts: number
    }

    const results: ResultRow[] = []
    let extraDelay = 0  // se acumula cuando el servidor está saturado

    // for...of con await garantiza procesamiento estrictamente secuencial:
    // cada conversación termina por completo antes de iniciar la siguiente petición a la API.
    for (const [i, conv] of pending.entries()) {
      const convName = conv.display_name ?? conv.client_name ?? conv.client_phone

      let success    = false
      let analysisId: string | undefined
      let lastError  = ''
      let attempts   = 0

      // Hasta MAX_ATTEMPTS intentos por conversación
      while (attempts < MAX_ATTEMPTS && !success) {
        if (attempts > 0) {
          const backoff = RATE_LIMIT_WAIT_MS * attempts
          console.log(`[Batch] Reintento ${attempts}/${MAX_ATTEMPTS - 1} para ${convName} en ${backoff / 1000}s…`)
          await delay(backoff)
        }

        attempts++
        const result = await analyzeConversation(conv.id, 'manual')

        if (result.success) {
          success    = true
          analysisId = result.analysisId
        } else {
          lastError = result.error ?? 'Error desconocido'
          if (!isRateLimit(lastError)) break
          extraDelay = Math.min(extraDelay + RATE_LIMIT_WAIT_MS, 60000)
        }
      }

      results.push({
        conversationId: conv.id,
        conversationName: convName,
        success,
        analysisId,
        error: success ? undefined : friendlyError(lastError),
        attempts,
      })

      // Pausa entre conversaciones — nunca en paralelo
      if (i < pending.length - 1) {
        const waitMs = DELAY_BETWEEN_MS + extraDelay
        if (extraDelay > 0) console.log(`[Batch] Pausa extendida de ${waitMs / 1000}s por saturación`)
        await delay(waitMs)
        extraDelay = Math.max(0, extraDelay - RATE_LIMIT_WAIT_MS)
      }
    }

    const analyzed = results.filter(r => r.success).length
    const failed   = results.filter(r => !r.success).length

    return NextResponse.json({ analyzed, failed, skipped: pending.length - results.length, results })
  } catch (err) {
    console.error('Error en /api/analyze/batch:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
