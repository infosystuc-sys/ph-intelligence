import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, Type } from '@google/genai'
import { jsonrepair } from 'jsonrepair'

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

// ── Jerarquía fija de fallback para el análisis de conversaciones ────────────
// Acordado 28/7/2026: en vez de un único "proveedor activo" configurable, todo
// análisis prueba estos 4 escalones en orden y avanza al siguiente si el actual
// agota sus reintentos (ver withRetry). La key propia de Gemini por instancia
// solo genera un escalón separado si realmente está configurada — si no, se
// salta directo a la key global (usarla dos veces con la misma key sería un
// reintento inútil, no un fallback real).
export interface FallbackAttempt {
  provider: AIProvider
  label: string
  error?: string
}

export interface FallbackResult {
  text: string
  providerUsed: AIProvider
  attempts: FallbackAttempt[]
}

// Se lanza cuando los 4 escalones de la jerarquía fallaron. Lleva el detalle
// de cada intento para que el caller pueda decidir, por ejemplo, si TODOS los
// intentos fueron por rate limit (transitorio, reintentar después) o si hubo
// al menos uno con un error real (key inválida, etc. — vale la pena loguearlo).
export class AIFallbackError extends Error {
  attempts: FallbackAttempt[]
  constructor(message: string, attempts: FallbackAttempt[]) {
    super(message)
    this.name = 'AIFallbackError'
    this.attempts = attempts
  }
}

interface FallbackTier {
  provider: AIProvider
  label: string
  apiKey?: string
}

function buildFallbackChain(instanceGeminiKey: string | null | undefined): FallbackTier[] {
  const tiers: FallbackTier[] = []
  if (instanceGeminiKey) {
    tiers.push({ provider: 'gemini', label: 'Gemini (key de instancia)', apiKey: instanceGeminiKey })
  }
  tiers.push({ provider: 'gemini', label: 'Gemini (key global)' })
  tiers.push({ provider: 'groq', label: 'Groq' })
  tiers.push({ provider: 'anthropic', label: 'Anthropic' })
  return tiers
}

export async function callAIWithFallback(params: {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  instanceGeminiKey?: string | null
}): Promise<FallbackResult> {
  const { systemPrompt, userPrompt, maxTokens, instanceGeminiKey } = params
  const chain = buildFallbackChain(instanceGeminiKey)
  const attempts: FallbackAttempt[] = []

  for (const tier of chain) {
    try {
      const text = await callAI({
        provider: tier.provider,
        systemPrompt,
        userPrompt,
        maxTokens,
        apiKey: tier.apiKey,
      })
      attempts.push({ provider: tier.provider, label: tier.label })
      return { text, providerUsed: tier.provider, attempts }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[AI] Falló ${tier.label}, probando siguiente escalón —`, errMsg.slice(0, 200))
      attempts.push({ provider: tier.provider, label: tier.label, error: errMsg })
    }
  }

  const summary = attempts.map(a => `${a.label}: ${a.error}`).join(' | ')
  throw new AIFallbackError(`Los ${attempts.length} proveedores de IA fallaron — ${summary}`, attempts)
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

// ── Parseo robusto de JSON devuelto por un LLM ───────────────────────────────
// Compartido por todo lo que le pide JSON a un LLM (análisis de conversación,
// análisis global de vendedor). Los LLMs a veces envuelven el JSON en fences de
// markdown, agregan texto alrededor, o dejan comillas/comas mal escapadas —
// jsonrepair es la red de seguridad para ese último caso.
export function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:\w+)?\s*([\s\S]*?)```/)
  if (fenced?.[1]?.trim()) return fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

export function parseLLMJSON(raw: string): unknown {
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
      throw firstErr
    }
  }
}
