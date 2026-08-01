import { SupabaseClient } from '@supabase/supabase-js'
import { callAIWithFallback, AIFallbackError, AI_MODELS, isRateLimitError, parseLLMJSON, VENDOR_GLOBAL_RESPONSE_SCHEMA } from './ai-providers'
import { ConversationStage, SentimentType, VendorDailyAnalysis } from '@/types'

const WINDOW_HOURS = 72
const MAX_ANALYSES_IN_PROMPT = 40

type AnalysisRow = {
  quality_score: number
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
  conversation_stage: ConversationStage
  sentiment: SentimentType
  talk_ratio_vendor: number
  analyzed_at: string
}

export interface VendorAggregates {
  conversationsAnalyzed: number
  avgQualityScore: number | null
  avgTalkRatioVendor: number | null
  sentimentCounts: Record<SentimentType, number>
  stageCounts: Record<ConversationStage, number>
}

function emptyAggregates(): VendorAggregates {
  return {
    conversationsAnalyzed: 0,
    avgQualityScore: null,
    avgTalkRatioVendor: null,
    sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
    stageCounts: { new: 0, negotiation: 0, proposal: 0, closed_won: 0, closed_lost: 0 },
  }
}

// Trae los ai_analyses de un vendedor en una ventana de tiempo y calcula los
// agregados numéricos. No filtra grupos/empleados por separado: ai_analyses ya
// excluye esos casos en el momento del análisis individual (ver lib/ai-analyzer.ts).
async function fetchAnalysesInWindow(
  supabase: SupabaseClient,
  vendedorId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<AnalysisRow[]> {
  const { data, error } = await supabase
    .from('ai_analyses')
    .select('quality_score, strengths, weaknesses, suggestions, conversation_stage, sentiment, talk_ratio_vendor, analyzed_at')
    .eq('vendedor_id', vendedorId)
    .gte('analyzed_at', windowStart.toISOString())
    .lt('analyzed_at', windowEnd.toISOString())
    .order('analyzed_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as AnalysisRow[]
}

function computeAggregates(rows: AnalysisRow[]): VendorAggregates {
  if (rows.length === 0) return emptyAggregates()

  const sentimentCounts: Record<SentimentType, number> = { positive: 0, neutral: 0, negative: 0 }
  const stageCounts: Record<ConversationStage, number> = { new: 0, negotiation: 0, proposal: 0, closed_won: 0, closed_lost: 0 }
  let scoreSum = 0
  let talkRatioSum = 0

  for (const row of rows) {
    scoreSum += row.quality_score
    talkRatioSum += row.talk_ratio_vendor
    sentimentCounts[row.sentiment]++
    stageCounts[row.conversation_stage]++
  }

  return {
    conversationsAnalyzed: rows.length,
    avgQualityScore: scoreSum / rows.length,
    avgTalkRatioVendor: talkRatioSum / rows.length,
    sentimentCounts,
    stageCounts,
  }
}

const SYSTEM_PROMPT = `Sos un gerente de ventas que resume el desempeño de UN vendedor de Punto Hogar durante un período de 3 días, en base a análisis individuales ya generados de sus conversaciones de WhatsApp con clientes.

Tu tarea es identificar PATRONES que se repiten entre varias conversaciones (no listar cada conversación por separado) y armar un plan de coaching accionable para los próximos días.

Respondé en JSON con exactamente este formato:
{
  "summary_text": "resumen ejecutivo de 3-4 oraciones sobre el desempeño general del período, dirigido al gerente",
  "recurring_strengths": ["patrón de fortaleza que se repite en varias conversaciones, no una sola vez"],
  "recurring_weaknesses": ["patrón de debilidad que se repite en varias conversaciones, no una sola vez"],
  "coaching_plan": "plan de coaching concreto y accionable para los próximos días, dirigido directamente al vendedor en segunda persona, con pasos específicos — no generalidades"
}

Priorizá lo que se repite sobre lo anecdótico: si algo aparece en una sola conversación de veinte, no es un patrón. Si hay pocos datos, decilo explícitamente en el resumen en vez de inventar patrones que no están respaldados.

Respondé ÚNICAMENTE con el JSON válido, sin formato markdown de bloques de código y sin texto introductorio o de despedida.`

function buildUserPrompt(vendorName: string, aggregates: VendorAggregates, rows: AnalysisRow[]): string {
  const sample = rows.slice(0, MAX_ANALYSES_IN_PROMPT)
  const items = sample.map((r, i) => {
    const date = new Date(r.analyzed_at).toLocaleDateString('es-AR')
    return `${i + 1}. [${date}] score=${r.quality_score} etapa=${r.conversation_stage} sentiment=${r.sentiment}
   Fortalezas: ${r.strengths.join('; ') || '—'}
   Debilidades: ${r.weaknesses.join('; ') || '—'}
   Sugerencias: ${r.suggestions.join('; ') || '—'}`
  }).join('\n')

  const truncatedNote = rows.length > MAX_ANALYSES_IN_PROMPT
    ? `\n(Se muestran las ${MAX_ANALYSES_IN_PROMPT} más recientes de ${rows.length} conversaciones analizadas en el período — los agregados numéricos de arriba sí son sobre las ${rows.length} completas.)`
    : ''

  return `Vendedor: ${vendorName}
Período: últimas 72 horas
Conversaciones analizadas: ${aggregates.conversationsAnalyzed}
Score promedio: ${aggregates.avgQualityScore?.toFixed(1) ?? 'N/A'}
Talk ratio promedio del vendedor: ${aggregates.avgTalkRatioVendor?.toFixed(0) ?? 'N/A'}%
Sentiment: ${aggregates.sentimentCounts.positive} positivo / ${aggregates.sentimentCounts.neutral} neutral / ${aggregates.sentimentCounts.negative} negativo
Etapas: nuevo=${aggregates.stageCounts.new} negociación=${aggregates.stageCounts.negotiation} propuesta=${aggregates.stageCounts.proposal} ganado=${aggregates.stageCounts.closed_won} perdido=${aggregates.stageCounts.closed_lost}

DETALLE DE CONVERSACIONES ANALIZADAS:
${items}${truncatedNote}

Generá el análisis global en JSON.`
}

function sanitizeGlobalAnalysis(data: unknown): { summary_text: string; recurring_strengths: string[]; recurring_weaknesses: string[]; coaching_plan: string } {
  const d = data as Record<string, unknown>
  return {
    summary_text: String(d.summary_text ?? '').slice(0, 1000),
    recurring_strengths: Array.isArray(d.recurring_strengths) ? d.recurring_strengths.slice(0, 10).map(String) : [],
    recurring_weaknesses: Array.isArray(d.recurring_weaknesses) ? d.recurring_weaknesses.slice(0, 10).map(String) : [],
    coaching_plan: String(d.coaching_plan ?? '').slice(0, 2000),
  }
}

export async function getVendorGlobalAnalysisHistory(
  supabase: SupabaseClient,
  vendedorId: string,
  limit: number,
): Promise<VendorDailyAnalysis[]> {
  const { data, error } = await supabase
    .from('vendor_daily_analyses')
    .select('*')
    .eq('vendedor_id', vendedorId)
    .order('date', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as VendorDailyAnalysis[]
}

export async function generateVendorGlobalAnalysis(
  supabase: SupabaseClient,
  vendedorId: string,
  generatedBy: string,
): Promise<{ ok: true; data: VendorDailyAnalysis } | { ok: false; error: string }> {
  const { data: vendor } = await supabase.from('users').select('full_name').eq('id', vendedorId).single()
  if (!vendor) return { ok: false, error: 'Vendedor no encontrado' }

  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - WINDOW_HOURS * 60 * 60 * 1000)
  const prevWindowEnd = windowStart
  const prevWindowStart = new Date(prevWindowEnd.getTime() - WINDOW_HOURS * 60 * 60 * 1000)

  const rows = await fetchAnalysesInWindow(supabase, vendedorId, windowStart, windowEnd)
  const aggregates = computeAggregates(rows)

  const prevRows = await fetchAnalysesInWindow(supabase, vendedorId, prevWindowStart, prevWindowEnd)
  const prevAggregates = computeAggregates(prevRows)

  const date = new Date().toISOString().split('T')[0]

  // Sin conversaciones analizadas en la ventana: no gastamos una llamada de IA
  // con contexto vacío, guardamos igual el registro del día con los ceros.
  if (aggregates.conversationsAnalyzed === 0) {
    const { data: saved, error } = await supabase
      .from('vendor_daily_analyses')
      .upsert({
        vendedor_id: vendedorId,
        date,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        conversations_analyzed: 0,
        avg_quality_score: null,
        avg_quality_score_prev_window: prevAggregates.avgQualityScore,
        avg_talk_ratio_vendor: null,
        sentiment_counts: aggregates.sentimentCounts,
        stage_counts: aggregates.stageCounts,
        recurring_strengths: [],
        recurring_weaknesses: [],
        summary_text: 'Sin análisis de conversaciones en los últimos 3 días.',
        coaching_plan: '',
        model_used: null,
        generated_by: generatedBy,
      }, { onConflict: 'vendedor_id,date' })
      .select()
      .single()

    if (error) return { ok: false, error: error.message }
    return { ok: true, data: saved as VendorDailyAnalysis }
  }

  let providerUsed: string
  let narrative: { summary_text: string; recurring_strengths: string[]; recurring_weaknesses: string[]; coaching_plan: string }

  try {
    const result = await callAIWithFallback({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(vendor.full_name, aggregates, rows),
      maxTokens: 2048,
      responseSchema: VENDOR_GLOBAL_RESPONSE_SCHEMA,
      // Gemini 2.5 gasta "thinking" tokens del mismo presupuesto que la
      // respuesta visible — en la primera prueba real esto cortó el JSON a
      // mitad de camino (summary_text truncado, el resto de los campos ni
      // llegaba a generarse). Esta tarea es síntesis + JSON estructurado, no
      // razonamiento que se beneficie de thinking — lo desactivamos.
      thinkingBudget: 0,
    })
    providerUsed = result.providerUsed
    narrative = sanitizeGlobalAnalysis(parseLLMJSON(result.text))
  } catch (e) {
    const rateLimit = e instanceof AIFallbackError
      ? e.attempts.every(a => a.error && isRateLimitError(a.error))
      : isRateLimitError(e)
    const errMsg = rateLimit
      ? 'Los proveedores de IA agotaron sus reintentos (rate limit) — probá de nuevo en unos minutos.'
      : `Error generando el análisis global: ${String(e)}`
    return { ok: false, error: errMsg }
  }

  const { data: saved, error } = await supabase
    .from('vendor_daily_analyses')
    .upsert({
      vendedor_id: vendedorId,
      date,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      conversations_analyzed: aggregates.conversationsAnalyzed,
      avg_quality_score: aggregates.avgQualityScore,
      avg_quality_score_prev_window: prevAggregates.avgQualityScore,
      avg_talk_ratio_vendor: aggregates.avgTalkRatioVendor,
      sentiment_counts: aggregates.sentimentCounts,
      stage_counts: aggregates.stageCounts,
      recurring_strengths: narrative.recurring_strengths,
      recurring_weaknesses: narrative.recurring_weaknesses,
      summary_text: narrative.summary_text,
      coaching_plan: narrative.coaching_plan,
      model_used: AI_MODELS[providerUsed as keyof typeof AI_MODELS],
      generated_by: generatedBy,
    }, { onConflict: 'vendedor_id,date' })
    .select()
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data: saved as VendorDailyAnalysis }
}
