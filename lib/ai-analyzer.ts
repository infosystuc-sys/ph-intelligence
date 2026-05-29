import { createServiceSupabaseClient } from './supabase-server'
import { AIAnalysisResponse, ConversationStage, Message } from '@/types'
import { getActiveProvider, callAI, AI_MODELS, isRateLimitError } from './ai-providers'
import { jsonrepair } from 'jsonrepair'

const SYSTEM_PROMPT = `Eres un experto en ventas consultivas y fidelización de clientes en el rubro de electrodomésticos y artículos para el hogar en Argentina.
Tu tarea es auditar conversaciones de WhatsApp entre vendedores de Punto Hogar y clientes de su cartera activa (clientes que ya han comprado anteriormente en la empresa).

Tu objetivo es evaluar si el vendedor actúa de forma proactiva, orientada al cierre de ventas y a la expansión del ticket, evitando el rol pasivo de "solo informar precios".

Debes generar un informe estructurado en JSON con exactamente este formato:
{
  "quality_score": número del 0 al 100,
  "strengths": ["virtud 1", "virtud 2"],
  "weaknesses": ["falla 1", "falla 2"],
  "suggestions": ["sugerencia accionable 1", "sugerencia accionable 2"],
  "conversation_stage": "new|negotiation|proposal|closed_won|closed_lost",
  "talk_ratio_vendor": porcentaje de mensajes del vendedor (0-100),
  "talk_ratio_client": porcentaje de mensajes del cliente (0-100),
  "keywords_detected": ["palabra clave 1"],
  "sentiment": "positive|neutral|negative",
  "executive_summary": "resumen ejecutivo de 2-3 oraciones para el gerente enfocado en la oportunidad comercial",
  "vendor_coaching_note": "nota privada de coaching dirigida al vendedor, indicando qué táctica usar en su próximo mensaje o cómo mejorar su técnica de cierre"
}

Criterios de evaluación estrictos para el quality_score:
- Saludo, empatía y fidelización (10 pts): ¿Reconoce al cliente? ¿El trato es cálido y personalizado al estilo argentino?
- Indagación activa (15 pts): ¿Hace preguntas para entender el uso que se le dará al producto o simplemente responde lo que le preguntan?
- Argumentación y Venta Cruzada (Upselling/Cross-selling) (20 pts): ¿Ofreció un modelo superior, accesorios, garantía extendida o alternativas si no hay stock?
- Manejo de objeciones y fricción (15 pts): ¿Resuelve dudas sobre precios/pagos con solidez sin dejar enfriar el chat?
- Actitud Proactiva de Cierre (25 pts): PENALIZA severamente si el vendedor solo envía precios y espera. PREMIA si el vendedor utiliza llamados a la acción claros, genera urgencia o facilita el link/método de pago.
- Ortografía, claridad y formato (10 pts): ¿Usa audios largos innecesarios o textos claros y fáciles de leer?

Responde ÚNICAMENTE con el JSON válido, sin formato markdown de bloques de código y sin texto introductorio o de despedida.`

function extractJSON(raw: string): string {
  // Quitar fences de markdown (con o sin tag de lenguaje)
  const fenced = raw.match(/```(?:\w+)?\s*([\s\S]*?)```/)
  if (fenced?.[1]?.trim()) return fenced[1].trim()
  // Extraer el objeto JSON más externo por posición, no por regex greedy
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

// Parse robusto: intenta JSON.parse normal y si falla intenta repararlo.
// Los LLMs a veces dejan comillas sin escapar, comas finales, o caracteres
// de control dentro de strings. jsonrepair maneja estos casos.
function parseLLMJSON(raw: string): unknown {
  const cleaned = extractJSON(raw)
  try {
    return JSON.parse(cleaned)
  } catch (firstErr) {
    try {
      const repaired = jsonrepair(cleaned)
      const result = JSON.parse(repaired)
      console.warn('[AI] JSON reparado con jsonrepair (parse original falló:', (firstErr as Error).message + ')')
      return result
    } catch {
      // Si la reparación también falla, lanzar el error original (más informativo)
      throw firstErr
    }
  }
}

// ── Motor de Análisis IA ──────────────────────────────────────────────────────
export async function analyzeConversation(
  conversationId: string,
  triggeredBy: 'auto' | 'manual' = 'auto',
): Promise<{
  success: boolean
  analysisId?: string
  error?: string
  isRateLimit?: boolean
}> {
  const supabase = createServiceSupabaseClient()
  const startTime = Date.now()

  // 1. Obtener conversación con mensajes
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('*, vendedor:users(full_name)')
    .eq('id', conversationId)
    .single()

  if (convError || !conversation) {
    await supabase.from('analysis_logs').insert({
      conversation_id: conversationId,
      triggered_by: triggeredBy,
      status: 'error',
      error_message: 'Conversación no encontrada',
      duration_ms: Date.now() - startTime,
    })
    return { success: false, error: 'Conversación no encontrada' }
  }

  // Excluir conversaciones archivadas en histórico (auto, batch y manual)
  if (conversation.status === 'historico') {
    return { success: false, error: 'Conversación en histórico, excluida del análisis' }
  }

  // Excluir grupos de WhatsApp (auto, batch y manual)
  if (typeof conversation.remote_jid === 'string' && conversation.remote_jid.endsWith('@g.us')) {
    return { success: false, error: 'Conversación de grupo, excluida del análisis' }
  }

  // Excluir conversaciones de empleados (auto, batch y manual)
  const { data: employeeMatch } = await supabase
    .from('employee_phones')
    .select('id')
    .eq('phone', conversation.client_phone)
    .maybeSingle()
  if (employeeMatch) {
    return { success: false, error: 'Conversación de empleado, excluida del análisis' }
  }

  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('msg_timestamp', { ascending: true })

  if (msgError) {
    await supabase.from('analysis_logs').insert({
      conversation_id: conversationId,
      vendedor_id: conversation.vendedor_id,
      triggered_by: triggeredBy,
      status: 'error',
      error_message: 'Error al obtener mensajes',
      duration_ms: Date.now() - startTime,
    })
    return { success: false, error: 'Error al obtener mensajes' }
  }

  if (!messages || messages.length === 0) {
    await supabase.from('analysis_logs').insert({
      conversation_id: conversationId,
      vendedor_id: conversation.vendedor_id,
      triggered_by: triggeredBy,
      status: 'error',
      error_message: 'No hay mensajes para analizar',
      duration_ms: Date.now() - startTime,
    })
    return { success: false, error: 'No hay mensajes para analizar' }
  }

  // 2. Construir el prompt con el contexto de la conversación
  const conversationText = buildConversationText(messages as Message[])
  const vendorName = (conversation.vendedor as { full_name: string })?.full_name ?? 'Vendedor'

  const userPrompt = `Analiza la siguiente conversación de WhatsApp entre el vendedor "${vendorName}" de Punto Hogar y un cliente.

Cliente: ${conversation.client_name ?? conversation.client_phone}
Fecha: ${new Date(conversation.created_at).toLocaleDateString('es-AR')}
Total de mensajes: ${messages.length}

CONVERSACIÓN:
${conversationText}

Genera el análisis completo en JSON.`

  // 3. Detectar proveedor activo y llamar al LLM
  const provider = await getActiveProvider()
  let analysisData: AIAnalysisResponse

  let rawText = ''
  try {
    rawText = await callAI({
      provider,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 2048,
    })

    analysisData = parseLLMJSON(rawText) as AIAnalysisResponse
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error(`[AI] JSON.parse fallo. Raw text (primeros 500 chars):`)
      console.error(rawText.slice(0, 500))
      console.error(`[AI] extractJSON devolvio (primeros 200 chars):`)
      console.error(extractJSON(rawText).slice(0, 200))
    }
    const rateLimit = isRateLimitError(e)
    const errMsg = rateLimit
      ? `Rate limit (${provider}): reintentos agotados. La conversación se reintentará en el próximo ciclo.`
      : `Error en análisis IA (${provider}): ${String(e)}`

    // Los errores de rate limit son transitorios: no los persistimos como fallas
    // para no contaminar el historial de logs ni penalizar la conversación.
    if (!rateLimit) {
      await supabase.from('analysis_logs').insert({
        conversation_id: conversationId,
        vendedor_id: conversation.vendedor_id,
        triggered_by: triggeredBy,
        status: 'error',
        model_used: AI_MODELS[provider],
        error_message: errMsg.slice(0, 500),
        duration_ms: Date.now() - startTime,
        message_count: messages.length,
      })
    } else {
      console.warn(`[AI] ${errMsg} (conv: ${conversationId})`)
    }

    return { success: false, error: errMsg, isRateLimit: rateLimit }
  }

  // 4. Validar y sanitizar datos
  const safeAnalysis = sanitizeAnalysis(analysisData)

  // 5. Persistir en Supabase
  const { data: savedAnalysis, error: saveError } = await supabase
    .from('ai_analyses')
    .insert({
      conversation_id: conversationId,
      vendedor_id: conversation.vendedor_id,
      quality_score: safeAnalysis.quality_score,
      strengths: safeAnalysis.strengths,
      weaknesses: safeAnalysis.weaknesses,
      suggestions: safeAnalysis.suggestions,
      conversation_stage: safeAnalysis.conversation_stage,
      talk_ratio_vendor: safeAnalysis.talk_ratio_vendor,
      talk_ratio_client: safeAnalysis.talk_ratio_client,
      keywords_detected: safeAnalysis.keywords_detected,
      sentiment: safeAnalysis.sentiment,
      executive_summary: safeAnalysis.executive_summary,
      vendor_coaching_note: safeAnalysis.vendor_coaching_note,
      full_report: JSON.stringify(safeAnalysis, null, 2),
      model_used: AI_MODELS[provider],
    })
    .select()
    .single()

  if (saveError) {
    await supabase.from('analysis_logs').insert({
      conversation_id: conversationId,
      vendedor_id: conversation.vendedor_id,
      triggered_by: triggeredBy,
      status: 'error',
      model_used: AI_MODELS[provider],
      error_message: 'Error al guardar el análisis en la base de datos',
      duration_ms: Date.now() - startTime,
      message_count: messages.length,
    })
    return { success: false, error: 'Error al guardar el análisis' }
  }

  // Log de éxito
  await supabase.from('analysis_logs').insert({
    conversation_id: conversationId,
    vendedor_id: conversation.vendedor_id,
    triggered_by: triggeredBy,
    status: 'success',
    analysis_id: savedAnalysis.id,
    model_used: AI_MODELS[provider],
    duration_ms: Date.now() - startTime,
    message_count: messages.length,
  })

  // 6. Actualizar KPIs del día
  await updateDailyKpis(conversation.vendedor_id)

  return { success: true, analysisId: savedAnalysis.id }
}

// ── Construir texto legible de la conversación ────────────────────────────────
function buildConversationText(messages: Message[]): string {
  return messages
    .map(msg => {
      const who = msg.from_me ? 'VENDEDOR' : 'CLIENTE'
      const time = new Date(msg.msg_timestamp).toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
      })
      return `[${time}] ${who}: ${msg.content}`
    })
    .join('\n')
}

// ── Sanitizar y validar la respuesta del análisis ─────────────────────────────
function sanitizeAnalysis(data: AIAnalysisResponse): AIAnalysisResponse {
  const validStages: ConversationStage[] = ['new', 'negotiation', 'proposal', 'closed_won', 'closed_lost']
  const validSentiments = ['positive', 'neutral', 'negative'] as const

  return {
    quality_score: Math.min(100, Math.max(0, Number(data.quality_score) || 50)),
    strengths: Array.isArray(data.strengths) ? data.strengths.slice(0, 10) : [],
    weaknesses: Array.isArray(data.weaknesses) ? data.weaknesses.slice(0, 10) : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 10) : [],
    conversation_stage: validStages.includes(data.conversation_stage) ? data.conversation_stage : 'new',
    talk_ratio_vendor: Math.min(100, Math.max(0, Number(data.talk_ratio_vendor) || 50)),
    talk_ratio_client: Math.min(100, Math.max(0, Number(data.talk_ratio_client) || 50)),
    keywords_detected: Array.isArray(data.keywords_detected) ? data.keywords_detected.slice(0, 20) : [],
    sentiment: validSentiments.includes(data.sentiment) ? data.sentiment : 'neutral',
    executive_summary: String(data.executive_summary ?? '').slice(0, 1000),
    vendor_coaching_note: String(data.vendor_coaching_note ?? '').slice(0, 2000),
  }
}

// ── Actualizar KPIs del vendedor ──────────────────────────────────────────────
async function updateDailyKpis(vendedorId: string): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const today = new Date().toISOString().split('T')[0]

  // Calcular métricas del día — solo conversaciones de clientes
  // (excluir grupos y teléfonos de empleados de los conteos)
  const { data: empPhones } = await supabase.from('employee_phones').select('phone')
  const employeePhoneSet = new Set((empPhones ?? []).map((p: { phone: string }) => p.phone))

  const { data: rawConversations } = await supabase
    .from('conversations')
    .select('id, status, remote_jid, client_phone, last_message_at')
    .eq('vendedor_id', vendedorId)

  if (!rawConversations) return

  const conversations = rawConversations.filter(c =>
    !c.remote_jid?.endsWith('@g.us') && !employeePhoneSet.has(c.client_phone)
  )

  const now = new Date()
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const total = conversations.length
  const unresponded = conversations.filter(c => {
    if (!c.last_message_at) return false
    return new Date(c.last_message_at) < h24ago && c.status === 'active'
  }).length

  const { data: analyses } = await supabase
    .from('ai_analyses')
    .select('quality_score, conversation_stage')
    .eq('vendedor_id', vendedorId)

  const avgScore = analyses && analyses.length > 0
    ? analyses.reduce((sum, a) => sum + a.quality_score, 0) / analyses.length
    : 0

  const stageCounts = {
    new: 0, negotiation: 0, proposal: 0, closed_won: 0, closed_lost: 0,
  }
  analyses?.forEach(a => {
    if (a.conversation_stage in stageCounts) {
      stageCounts[a.conversation_stage as ConversationStage]++
    }
  })

  await supabase.from('daily_kpis').upsert({
    vendedor_id: vendedorId,
    date: today,
    conversations_total: total,
    conversations_unresponded_24h: unresponded,
    conversations_responded_24h: total - unresponded,
    avg_quality_score: Math.round(avgScore * 10) / 10,
    estimated_conversions: stageCounts.closed_won,
    pipeline_stage_counts: stageCounts,
  }, { onConflict: 'vendedor_id,date' })
}
