import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, Type } from '@google/genai'
import { createServiceSupabaseClient } from './supabase-server'

// Schema de la respuesta esperada del analizador IA.
// Cuando se pasa a Gemini como responseSchema, el modelo se ve obligado
// a producir JSON que cumple esta estructura → adiós errores de comillas sin escapar.
const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    quality_score:        { type: Type.INTEGER, minimum: 0, maximum: 100 },
    strengths:            { type: Type.ARRAY, items: { type: Type.STRING } },
    weaknesses:           { type: Type.ARRAY, items: { type: Type.STRING } },
    suggestions:          { type: Type.ARRAY, items: { type: Type.STRING } },
    conversation_stage:   { type: Type.STRING, enum: ['new', 'negotiation', 'proposal', 'closed_won', 'closed_lost'] },
    talk_ratio_vendor:    { type: Type.INTEGER, minimum: 0, maximum: 100 },
    talk_ratio_client:    { type: Type.INTEGER, minimum: 0, maximum: 100 },
    keywords_detected:    { type: Type.ARRAY, items: { type: Type.STRING } },
    sentiment:            { type: Type.STRING, enum: ['positive', 'neutral', 'negative'] },
    executive_summary:    { type: Type.STRING },
    vendor_coaching_note: { type: Type.STRING },
  },
  required: [
    'quality_score', 'strengths', 'weaknesses', 'suggestions',
    'conversation_stage', 'talk_ratio_vendor', 'talk_ratio_client',
    'keywords_detected', 'sentiment', 'executive_summary', 'vendor_coaching_note',
  ],
}

export type AIProvider = 'anthropic' | 'gemini' | 'groq'

// Lista canónica de proveedores válidos. Reutilizable para validación en runtime.
export const VALID_PROVIDERS: readonly AIProvider[] = ['anthropic', 'gemini', 'groq'] as const

export function isAIProvider(v: unknown): v is AIProvider {
  return typeof v === 'string' && (VALID_PROVIDERS as readonly string[]).includes(v)
}

// Modelos por proveedor
export const AI_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
}

// ── Retry con exponential backoff ─────────────────────────────────────────────
const RETRYABLE = ['429', '503', '529', 'overloaded', 'rate', 'quota', 'Resource has been exhausted']

const RETRY_BUFFER_MS = 1000 // margen adicional sobre el delay sugerido por la API

/**
 * Busca el objeto RetryInfo dentro del array `details` de un error de Google API.
 * Devuelve los ms a esperar, o null si no se encuentra.
 */
function parseRetryInfoDetails(details: unknown): number | null {
  if (!Array.isArray(details)) return null
  const retryInfo = details.find(
    (d: unknown) =>
      typeof d === 'object' &&
      d !== null &&
      (d as Record<string, unknown>)['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
  )
  if (!retryInfo) return null
  const retryDelay = (retryInfo as Record<string, unknown>).retryDelay
  if (typeof retryDelay !== 'string') return null
  const seconds = parseFloat(retryDelay.replace(/s$/i, ''))
  return isNaN(seconds) ? null : Math.ceil(seconds * 1000)
}

/**
 * Extrae el tiempo de espera sugerido por la API usando tres estrategias en orden:
 *  1. Propiedad `details` directa del objeto de error (SDK de Google expone esto).
 *  2. JSON embebido en el mensaje de string del error (cuando el SDK serializa el cuerpo).
 *  3. Regex de último recurso para frases como "retry in 13.1s".
 */
function extractRetryAfterMs(err: unknown): number | null {
  // 1. Acceso directo al objeto error — @google/genai expone `details` como propiedad
  if (err !== null && typeof err === 'object') {
    const ms = parseRetryInfoDetails((err as Record<string, unknown>).details)
    if (ms !== null) return ms + RETRY_BUFFER_MS
  }

  // 2. Parsear JSON embebido en el mensaje de string
  const raw = err instanceof Error ? err.message : String(err)
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      const details = parsed.details ?? (parsed.error as Record<string, unknown> | undefined)?.details
      const ms = parseRetryInfoDetails(details)
      if (ms !== null) return ms + RETRY_BUFFER_MS
    }
  } catch { /* JSON truncado o inválido — continuar */ }

  // 3. Regex de último recurso: "Please retry in 13.1s" / "retry after 30 seconds"
  const textMatch = raw.match(/retry\s+(?:in|after)\s+([\d.]+)\s*s/i)
  if (textMatch) return Math.ceil(parseFloat(textMatch[1]) * 1000) + RETRY_BUFFER_MS

  return null
}

export function isRateLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return ['429', 'rate', 'quota', 'resource has been exhausted', 'overloaded'].some(s => msg.includes(s))
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseMs = 2000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = String(err)
      const retryable = RETRYABLE.some(s => msg.includes(s))
      if (!retryable || i === maxAttempts - 1) throw err
      // Pasar el objeto err completo para que extractRetryAfterMs acceda a details
      const extractedMs = extractRetryAfterMs(err)
      const backoffMs = baseMs * Math.pow(2, i) * (0.8 + Math.random() * 0.4)
      const delayMs = extractedMs ?? backoffMs
      const source = extractedMs ? 'API' : 'backoff'
      console.warn(
        `[AI] intento ${i + 1}/${maxAttempts} fallido (${source}: ${Math.round(delayMs / 1000)}s)…`,
        msg.slice(0, 120),
      )
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// ── Obtener proveedor activo desde Supabase ───────────────────────────────────
export async function getActiveProvider(): Promise<AIProvider> {
  try {
    const supabase = createServiceSupabaseClient()
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ai_provider')
      .maybeSingle()

    if (error) {
      // Error real de la DB (tabla inexistente, RLS, etc.) — no enmascarar
      console.error('[getActiveProvider] Error leyendo app_config:', error)
    } else if (isAIProvider(data?.value)) {
      return data.value
    }
  } catch (e) {
    console.error('[getActiveProvider] Excepción inesperada:', e)
  }

  // Fallback: variable de entorno o gemini por defecto
  const envProvider = process.env.AI_PROVIDER
  if (isAIProvider(envProvider)) return envProvider
  return 'gemini'
}

// ── Cambiar proveedor activo ───────────────────────────────────────────────────
export async function setActiveProvider(provider: AIProvider): Promise<void> {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from('app_config')
    .upsert(
      { key: 'ai_provider', value: provider, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
  if (error) {
    console.error('[setActiveProvider] Upsert fallido:', error)
    throw new Error(`Error al guardar ai_provider: ${error.message} (code: ${error.code ?? 'n/a'})`)
  }
}

// ── Interfaz unificada: llamar al LLM activo ──────────────────────────────────
export async function callAI(params: {
  provider: AIProvider
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  // Key específica a usar en lugar de la global del proveedor. Por ahora solo
  // tiene efecto con Gemini (key por instancia de WhatsApp); se ignora para
  // los demás proveedores.
  apiKey?: string
}): Promise<string> {
  const { provider, systemPrompt, userPrompt, maxTokens = 2048, apiKey } = params

  switch (provider) {
    case 'gemini':    return callGemini(systemPrompt, userPrompt, maxTokens, apiKey)
    case 'groq':      return callGroq(systemPrompt, userPrompt, maxTokens)
    case 'anthropic': return callAnthropic(systemPrompt, userPrompt, maxTokens)
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return withRetry(async () => {
    const response = await client.messages.create({
      model: AI_MODELS.anthropic,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text : ''
  })
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  apiKey?: string,
): Promise<string> {
  const client = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY! })
  return withRetry(async () => {
    const response = await client.models.generateContent({
      model: AI_MODELS.gemini,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      },
    })
    return response.text ?? ''
  })
}

// ── Groq (Llama 3, API compatible con OpenAI) ─────────────────────────────────
async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY no está configurada en las variables de entorno')

  return withRetry(async () => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODELS.groq,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      // Lanzamos con el código de status para que withRetry detecte 429/503 como retryables
      throw new Error(`Groq API ${res.status}: ${errBody.slice(0, 300)}`)
    }

    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return json.choices?.[0]?.message?.content ?? ''
  })
}
