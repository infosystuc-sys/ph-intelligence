import { createServiceSupabaseClient } from './supabase-server'
import { AIAnalysisResponse, ConversationStage, Message } from '@/types'
import { getActiveProvider, callAI, AI_MODELS } from './ai-providers'

const SYSTEM_PROMPT = `Eres un experto en ventas consultivas de electrodomésticos y artículos para el hogar en Argentina.
Tu tarea es analizar conversaciones de WhatsApp entre vendedores de Punto Hogar y sus clientes.
Debes evaluar la calidad de la conversación y generar un informe estructurado en JSON con exactamente este formato:
{
  "quality_score": número del 0 al 100,
  "strengths": ["virtud 1", "virtud 2", ...],
  "weaknesses": ["falla 1", "falla 2", ...],
  "suggestions": ["sugerencia accionable 1", "sugerencia accionable 2", ...],
  "conversation_stage": "new|negotiation|proposal|closed_won|closed_lost",
  "talk_ratio_vendor": porcentaje de mensajes del vendedor (0-100),
  "talk_ratio_client": porcentaje de mensajes del cliente (0-100),
  "keywords_detected": ["palabra clave 1", ...],
  "sentiment": "positive|neutral|negative",
  "executive_summary": "resumen ejecutivo de 2-3 oraciones para el gerente",
  "vendor_coaching_note": "nota privada de coaching dirigida directamente al vendedor, en tono constructivo y motivador"
}

Criterios de evaluación del quality_score:
- Saludo profesional y presentación (10 pts)
- Detección y comprensión de la necesidad del cliente (20 pts)
- Conocimiento del producto y argumentación (20 pts)
- Manejo de objeciones (15 pts)
- Propuesta de valor clara (15 pts)
- Seguimiento y cierre (15 pts)
- Ortografía y comunicación escrita (5 pts)

Responde ÚNICAMENTE con el JSON, sin texto adicional.`

// ── Motor de Análisis IA ──────────────────────────────────────────────────────
export async function analyzeConversation(
  conversationId: string,
  triggeredBy: 'auto' | 'manual' = 'auto',
): Promise<{
  success: boolean
  analysisId?: string
  error?: string
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

  try {
    const rawText = await callAI({
      provider,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 2048,
    })

    // Extraer JSON (puede venir con ```json ... ```)
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) ??
                      rawText.match(/\{[\s\S]*\}/)
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : rawText

    analysisData = JSON.parse(jsonStr) as AIAnalysisResponse
  } catch (e) {
    const errMsg = `Error en análisis IA (${provider}): ${String(e)}`
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
    return { success: false, error: errMsg }
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

  // 6. Si la IA detecta conversación cerrada → pasar a historico automáticamente
  const isClosed = ['closed_won', 'closed_lost'].includes(safeAnalysis.conversation_stage)
  if (isClosed) {
    await supabase
      .from('conversations')
      .update({ status: 'historico' })
      .eq('id', conversationId)
      .neq('status', 'historico')
  }

  // 7. Actualizar KPIs del día
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

  // Calcular métricas del día
  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, status, last_message_at')
    .eq('vendedor_id', vendedorId)

  if (!conversations) return

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
