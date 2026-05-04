import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import { createServiceSupabaseClient } from './supabase-server'

export type AIProvider = 'anthropic' | 'gemini'

// Modelos por proveedor
export const AI_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-flash-latest',
}

// ── Retry con exponential backoff ─────────────────────────────────────────────
const RETRYABLE = ['429', '503', '529', 'overloaded', 'rate', 'quota', 'Resource has been exhausted']

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4, baseMs = 2000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = String(err)
      const retryable = RETRYABLE.some(s => msg.includes(s))
      if (!retryable || i === maxAttempts - 1) throw err
      // jitter: baseMs * 2^i ± 20%
      const delay = baseMs * Math.pow(2, i) * (0.8 + Math.random() * 0.4)
      console.warn(`[AI] intento ${i + 1} fallido, reintentando en ${Math.round(delay)}ms…`, msg.slice(0, 120))
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// ── Obtener proveedor activo desde Supabase ───────────────────────────────────
export async function getActiveProvider(): Promise<AIProvider> {
  try {
    const supabase = createServiceSupabaseClient()
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ai_provider')
      .single()

    if (data?.value === 'gemini' || data?.value === 'anthropic') {
      return data.value
    }
  } catch {
    // fallback a env var si falla Supabase
  }

  // Fallback: variable de entorno o gemini por defecto
  const envProvider = process.env.AI_PROVIDER
  if (envProvider === 'gemini' || envProvider === 'anthropic') return envProvider
  return 'gemini'
}

// ── Cambiar proveedor activo ───────────────────────────────────────────────────
export async function setActiveProvider(provider: AIProvider): Promise<void> {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from('app_config')
    .upsert({ key: 'ai_provider', value: provider, updated_at: new Date().toISOString() })
}

// ── Interfaz unificada: llamar al LLM activo ──────────────────────────────────
export async function callAI(params: {
  provider: AIProvider
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
}): Promise<string> {
  const { provider, systemPrompt, userPrompt, maxTokens = 2048 } = params

  if (provider === 'gemini') {
    return callGemini(systemPrompt, userPrompt, maxTokens)
  }
  return callAnthropic(systemPrompt, userPrompt, maxTokens)
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
  maxTokens: number
): Promise<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
  return withRetry(async () => {
    const response = await client.models.generateContent({
      model: AI_MODELS.gemini,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
        temperature: 0.3,
      },
    })
    return response.text ?? ''
  })
}
