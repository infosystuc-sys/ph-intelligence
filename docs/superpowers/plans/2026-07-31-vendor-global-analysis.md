# Análisis global diario de vendedor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un análisis global por vendedor, con granularidad diaria (una fila por vendedor/día), que resuma en lenguaje natural + números agregados los `ai_analyses` (análisis por conversación) generados en los últimos 3 días. Se dispara manualmente con un botón — no hay cron. Visible solo para admin y el supervisor del vendedor, en `/vendors/[id]`.

**Architecture:** Una tabla nueva (`vendor_daily_analyses`, un registro por vendedor/día — mismo patrón que `daily_kpis`), una función de librería que calcula agregados numéricos sobre `ai_analyses` y le pide a un LLM una síntesis cualitativa (reutilizando `callAIWithFallback` de `lib/ai-providers.ts`), un endpoint que dispara la generación (upsert) y devuelve el histórico, y una sección nueva en la página de perfil del vendedor con un botón "Generar" y el resultado más reciente + histórico.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + `@supabase/supabase-js`), Google Gemini / Groq / Anthropic vía `lib/ai-providers.ts`, sin framework de testing — se verifica con scripts `tsx` ad-hoc contra datos reales (mismo patrón que `scripts/check-instance-health.ts`) y verificación manual en producción/local.

## Global Constraints

- **Ventana de 3 días = rolling 72hs**, no días de calendario: `windowEnd = ahora`, `windowStart = ahora - 72h`. Si esto no es lo que se quiere (por ejemplo, "hoy + ayer + anteayer" en calendario AR), avisar antes del Task 2 — cambia la query.
- **Sin datos en la ventana → no se llama al LLM.** Se guarda igual una fila con `conversations_analyzed = 0` y `summary_text = 'Sin análisis de conversaciones en los últimos 3 días.'`, para que quede registro de que se intentó generar ese día. Evita gastar una llamada de IA con contexto vacío.
- **Proveedores de IA: Gemini (key global) → Groq → Anthropic**, sin escalón de "key de instancia" (a diferencia del análisis por conversación) — un análisis de vendedor no es específico de una instancia de WhatsApp. Si se prefiere igual usar la key de instancia del vendedor cuando exista, avisar antes del Task 2.
- **Un análisis por vendedor por día**: `UNIQUE(vendedor_id, date)` en la tabla nueva, con upsert — volver a generar el mismo día pisa la fila de ese día (no crea duplicados). El `date` se calcula igual que en `daily_kpis` (`new Date().toISOString().split('T')[0]`, UTC) para ser consistente con el resto del proyecto, aunque no sea exactamente el día calendario de Argentina.
- **Visibilidad**: admin ve y genera para cualquier vendedor; supervisor solo para vendedores donde `users.supervisor_id === el propio supervisor`; rol `vendedor` no tiene acceso (ni ver ni generar) — decidido explícitamente, no se agrega esa vista.
- **Sigue el patrón de rutas existente**: este proyecto NO usa rutas dinámicas `[id]` en `app/api` — el id va como query param (GET) o en el body (POST), igual que `app/api/instances` y `app/api/vendors`. No crear `app/api/vendors/[id]/...`.
- No se modifica el contrato de `/api/vendors` (GET) que ya consume `/vendors` (listado).
- Cada cambio debe ser revertible: commits separados por task, sin migraciones destructivas.

---

### Task 1: Migración — tabla `vendor_daily_analyses`

**Files:**
- Create: `supabase/migrations/007_vendor_daily_analysis.sql`

**Interfaces:**
- Produces: tabla `public.vendor_daily_analyses` que consume Task 2 (INSERT/UPSERT) y Task 3 (SELECT para el histórico).

- [ ] **Step 1: Crear el archivo de migración**

Crear `supabase/migrations/007_vendor_daily_analysis.sql`:

```sql
-- ── Análisis global diario de vendedor ──────────────────────────────────────
-- Un registro por vendedor/día, generado manualmente (botón "Generar" en el
-- perfil del vendedor), que resume los ai_analyses de las últimas 72hs: los
-- números se calculan en la app, el resto lo escribe un LLM a partir de esos
-- análisis individuales. Mismo patrón de "una fila por día" que daily_kpis.
CREATE TABLE IF NOT EXISTS public.vendor_daily_analyses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_id                 UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date                        DATE NOT NULL,
  window_start                TIMESTAMPTZ NOT NULL,
  window_end                  TIMESTAMPTZ NOT NULL,
  conversations_analyzed      INTEGER NOT NULL DEFAULT 0,
  avg_quality_score           FLOAT,
  avg_quality_score_prev_window FLOAT,
  avg_talk_ratio_vendor       FLOAT,
  sentiment_counts            JSONB NOT NULL DEFAULT '{"positive":0,"neutral":0,"negative":0}',
  stage_counts                JSONB NOT NULL DEFAULT '{"new":0,"negotiation":0,"proposal":0,"closed_won":0,"closed_lost":0}',
  recurring_strengths         TEXT[] NOT NULL DEFAULT '{}',
  recurring_weaknesses        TEXT[] NOT NULL DEFAULT '{}',
  summary_text                TEXT NOT NULL DEFAULT '',
  coaching_plan                TEXT NOT NULL DEFAULT '',
  model_used                  TEXT,
  generated_by                UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(vendedor_id, date)
);

CREATE INDEX IF NOT EXISTS idx_vendor_daily_analyses_vendedor_date
  ON public.vendor_daily_analyses (vendedor_id, date DESC);
```

Ejecutar en el SQL Editor de Supabase (mismo flujo manual que las migraciones anteriores, ver `RESUMEN-FASE1.md`) — **este paso lo hace el humano**, no el agente que implementa. El resto de los tasks se pueden implementar y verificar (Task 2 con datos reales de lectura) sin que la migración esté aplicada todavía, salvo el paso final de Task 3 que sí escribe en la tabla.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/007_vendor_daily_analysis.sql
git commit -m "feat: migracion para analisis global diario de vendedor"
```

**Rollback:** tabla nueva y aditiva — `git revert` sin efecto en el resto de la app. Si ya se ejecutó en Supabase, un `DROP TABLE IF EXISTS public.vendor_daily_analyses;` manual la elimina sin tocar nada más.

---

### Task 2: Lógica de agregación + generación del análisis global

**Files:**
- Modify: `lib/ai-providers.ts` (mover el parseo robusto de JSON acá, para reusarlo)
- Modify: `lib/ai-analyzer.ts` (usar el parseo movido en vez de su copia local)
- Create: `lib/vendor-global-analysis.ts`
- Modify: `types/index.ts` (agregar `VendorDailyAnalysis`)

**Interfaces:**
- Consumes: `callAIWithFallback`, `AIFallbackError`, `AI_MODELS`, `isRateLimitError` de `lib/ai-providers.ts`; `createServiceSupabaseClient` de `lib/supabase-server.ts`; tipos `ConversationStage`, `SentimentType` de `@/types`.
- Produces:
  - `parseLLMJSON(raw: string): unknown` y `extractJSON(raw: string): string`, ahora exportadas desde `lib/ai-providers.ts`.
  - Tipo `VendorDailyAnalysis` en `types/index.ts` (usado por Task 3 y Task 4).
  - `generateVendorGlobalAnalysis(supabase: SupabaseClient, vendedorId: string, generatedBy: string): Promise<{ ok: true; data: VendorDailyAnalysis } | { ok: false; error: string }>` — usado por Task 3.
  - `getVendorGlobalAnalysisHistory(supabase: SupabaseClient, vendedorId: string, limit: number): Promise<VendorDailyAnalysis[]>` — usado por Task 3.

- [ ] **Step 1: Mover el parseo robusto de JSON a `lib/ai-providers.ts`**

En `lib/ai-providers.ts`, agregar al principio del archivo (junto a los demás imports):

```ts
import { jsonrepair } from 'jsonrepair'
```

Y agregar al final del archivo (después de `callGroq`):

```ts
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
```

- [ ] **Step 2: Actualizar `lib/ai-analyzer.ts` para usar el parseo movido**

En `lib/ai-analyzer.ts`:

1. Borrar las funciones locales `extractJSON` y `parseLLMJSON` (líneas 36-65 del archivo original) y el import de `jsonrepair` (línea 4).
2. Cambiar el import de `./ai-providers` (línea 3 original) de:
```ts
import { callAIWithFallback, AIFallbackError, AI_MODELS, isRateLimitError, AIProvider } from './ai-providers'
```
a:
```ts
import { callAIWithFallback, AIFallbackError, AI_MODELS, isRateLimitError, AIProvider, parseLLMJSON, extractJSON } from './ai-providers'
```

El resto del archivo no cambia — ya usa `parseLLMJSON(...)` y `extractJSON(rawText)` por nombre, ahora vienen del import en vez de definirse localmente.

- [ ] **Step 3: Verificar que nada se rompió**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos (el análisis por conversación individual sigue compilando igual, solo cambió de dónde vienen `parseLLMJSON`/`extractJSON`).

- [ ] **Step 4: Agregar el tipo `VendorDailyAnalysis`**

En `types/index.ts`, agregar después de la interfaz `AIAnalysis` (ver línea ~121 del archivo actual, justo antes de la sección `AIAnalysisResponse`):

```ts
// ── Análisis global diario de vendedor ────────────────────────────────────────
export interface VendorDailyAnalysis {
  id: string
  vendedor_id: string
  date: string
  window_start: string
  window_end: string
  conversations_analyzed: number
  avg_quality_score: number | null
  avg_quality_score_prev_window: number | null
  avg_talk_ratio_vendor: number | null
  sentiment_counts: Record<SentimentType, number>
  stage_counts: Record<ConversationStage, number>
  recurring_strengths: string[]
  recurring_weaknesses: string[]
  summary_text: string
  coaching_plan: string
  model_used: string | null
  generated_by: string | null
  created_at: string
}
```

- [ ] **Step 5: Escribir `lib/vendor-global-analysis.ts`**

```ts
import { SupabaseClient } from '@supabase/supabase-js'
import { callAIWithFallback, AIFallbackError, AI_MODELS, isRateLimitError, parseLLMJSON } from './ai-providers'
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
      maxTokens: 1024,
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
```

- [ ] **Step 6: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 7: Verificar los agregados contra datos reales (sin escribir nada — la tabla todavía puede no existir)**

Run (con `.env.local` apuntando a producción, mismo patrón que scripts anteriores; usa un `vendedorId` real, buscalo primero con `select id, full_name from users where role='vendedor' limit 5`):

```bash
npx tsx -e "
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
;(async () => {
  const { data: vendors } = await supabase.from('users').select('id, full_name').eq('role', 'vendedor').limit(3)
  console.log('Vendedores de prueba:', vendors)
})()
"
```

Expected: imprime 2-3 vendedores con `id`/`full_name` reales — anotar un `id` para el Step 8.

- [ ] **Step 8: Commit**

```bash
git add lib/ai-providers.ts lib/ai-analyzer.ts lib/vendor-global-analysis.ts types/index.ts
git commit -m "feat: logica de agregacion y generacion del analisis global de vendedor"
```

**Rollback:** `git revert` — el único cambio a código existente es de dónde se importan `parseLLMJSON`/`extractJSON` (mismo comportamiento), y `lib/vendor-global-analysis.ts` es un archivo nuevo que nada más lo importa todavía.

---

### Task 3: Endpoint `app/api/vendors/global-analysis`

**Files:**
- Create: `app/api/vendors/global-analysis/route.ts`

**Interfaces:**
- Consumes: `generateVendorGlobalAnalysis`, `getVendorGlobalAnalysisHistory` de `lib/vendor-global-analysis.ts`; `createServerSupabaseClient`, `createServiceSupabaseClient` de `lib/supabase-server.ts` (mismo patrón de auth que `app/api/instances/reconcile/route.ts`).
- Produces:
  - `GET /api/vendors/global-analysis?vendorId=<uuid>&limit=14` → `{ history: VendorDailyAnalysis[] }`
  - `POST /api/vendors/global-analysis` con body `{ vendorId: string }` → `{ ok: true, data: VendorDailyAnalysis } | { ok: false, error: string }`

- [ ] **Step 1: Escribir la ruta**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { generateVendorGlobalAnalysis, getVendorGlobalAnalysisHistory } from '@/lib/vendor-global-analysis'

export const maxDuration = 60

// Admin: acceso a cualquier vendedor. Supervisor: solo a los vendedores donde
// users.supervisor_id === su propio id. Vendedor: sin acceso (ni ver ni generar
// su propio análisis global — decisión explícita del alcance de este feature).
async function authorizeVendorAccess(vendorId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!profile || !['admin', 'supervisor'].includes(profile.role)) {
    return { error: NextResponse.json({ error: 'Sin permisos' }, { status: 403 }) }
  }

  if (profile.role === 'supervisor') {
    const service = createServiceSupabaseClient()
    const { data: vendor } = await service.from('users').select('supervisor_id').eq('id', vendorId).single()
    if (!vendor || vendor.supervisor_id !== user.id) {
      return { error: NextResponse.json({ error: 'Sin permisos sobre este vendedor' }, { status: 403 }) }
    }
  }

  return { error: null, userId: user.id }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const vendorId = searchParams.get('vendorId')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '14'), 60)

  if (!vendorId) return NextResponse.json({ error: 'vendorId requerido' }, { status: 400 })

  const { error } = await authorizeVendorAccess(vendorId)
  if (error) return error

  const service = createServiceSupabaseClient()
  try {
    const history = await getVendorGlobalAnalysisHistory(service, vendorId, limit)
    return NextResponse.json({ history })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error interno' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { vendorId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Body inválido' }, { status: 400 })
  }

  const vendorId = body.vendorId
  if (!vendorId) return NextResponse.json({ ok: false, error: 'vendorId requerido' }, { status: 400 })

  const { error, userId } = await authorizeVendorAccess(vendorId)
  if (error) return error

  const service = createServiceSupabaseClient()
  const result = await generateVendorGlobalAnalysis(service, vendorId, userId!)
  return NextResponse.json(result)
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 3: Verificación manual — requiere la migración del Task 1 ya ejecutada en Supabase**

```bash
npm run dev
```

Con sesión de admin iniciada en el navegador:

```bash
curl -X POST http://localhost:3010/api/vendors/global-analysis \
  -H "Content-Type: application/json" \
  --cookie "<cookie de sesión del navegador>" \
  -d '{"vendorId":"<id de un vendedor real con conversaciones analizadas>"}'
```

Expected: `{"ok":true,"data":{...}}` con `conversations_analyzed > 0` (si ese vendedor tuvo análisis en las últimas 72hs) y `summary_text`/`coaching_plan` con texto generado. Repetir la misma llamada un par de veces y confirmar que sigue habiendo una sola fila para ese vendedor/día en la tabla (upsert, no duplica).

- [ ] **Step 4: Commit**

```bash
git add app/api/vendors/global-analysis/route.ts
git commit -m "feat: endpoint para generar y consultar el analisis global de vendedor"
```

**Rollback:** endpoint nuevo y aditivo — `git revert` lo elimina sin efecto en el resto de la app.

---

### Task 4: UI en el perfil del vendedor

**Files:**
- Modify: `app/(dashboard)/vendors/[id]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/vendors/global-analysis?vendorId=...` → `{ history: VendorDailyAnalysis[] }`; `POST /api/vendors/global-analysis` → `{ ok: boolean, data?: VendorDailyAnalysis, error?: string }`; tipo `VendorDailyAnalysis` de `@/types`.

- [ ] **Step 1: Agregar el import del tipo**

En `app/(dashboard)/vendors/[id]/page.tsx`, en el import de `@/types` (línea 6 actual), agregar `VendorDailyAnalysis`:

```ts
import { Conversation, AIAnalysis, User, ConversationStage, VendorDailyAnalysis } from '@/types'
```

Y agregar `Lock` y `RefreshCw` al import de `lucide-react` (línea 10 actual):

```ts
import { ArrowLeft, Wifi, WifiOff, TrendingUp, Pencil, Trash2, X, Lock, RefreshCw } from 'lucide-react'
```

- [ ] **Step 2: Ampliar `checkRole` para saber si el usuario actual es el supervisor de este vendedor**

Reemplazar el estado y la función `checkRole` (líneas 224 y 233-238 actuales):

```ts
const [isAdmin, setIsAdmin] = useState(false)
const [canSeeGlobalAnalysis, setCanSeeGlobalAnalysis] = useState(false)
```

```ts
const checkRole = async (vendorSupervisorId: string | null) => {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
  const admin = data?.role === 'admin'
  setIsAdmin(admin)
  setCanSeeGlobalAnalysis(admin || (data?.role === 'supervisor' && vendorSupervisorId === user.id))
}
```

`checkRole` ahora necesita el `supervisor_id` del vendedor cargado, así que se llama después de tener `vendor`, no en paralelo. Cambiar el `useEffect` (línea 228-231 actual):

```ts
useEffect(() => {
  loadVendorData()
}, [id])
```

Y dentro de `loadVendorData`, después de `setVendor(vendorRes.data)` (línea 260 actual), agregar la llamada:

```ts
setVendor(vendorRes.data)
if (vendorRes.data) checkRole(vendorRes.data.supervisor_id)
```

- [ ] **Step 3: Agregar estado y funciones para el análisis global**

Junto a los demás `useState` (después de `showDelete`, línea 226 actual):

```ts
const [globalHistory, setGlobalHistory] = useState<VendorDailyAnalysis[]>([])
const [loadingGlobalHistory, setLoadingGlobalHistory] = useState(false)
const [generatingGlobal, setGeneratingGlobal] = useState(false)
const [globalError, setGlobalError] = useState<string | null>(null)
```

Agregar las funciones (cerca de `moveConversation`, después de línea 276 actual):

```ts
const loadGlobalHistory = async () => {
  setLoadingGlobalHistory(true)
  try {
    const res = await fetch(`/api/vendors/global-analysis?vendorId=${id}`)
    if (!res.ok) return
    const { history } = await res.json() as { history: VendorDailyAnalysis[] }
    setGlobalHistory(history)
  } finally {
    setLoadingGlobalHistory(false)
  }
}

const generateGlobalAnalysis = async () => {
  setGeneratingGlobal(true)
  setGlobalError(null)
  try {
    const res = await fetch('/api/vendors/global-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendorId: id }),
    })
    const result = await res.json() as { ok: boolean; data?: VendorDailyAnalysis; error?: string }
    if (result.ok) {
      await loadGlobalHistory()
    } else {
      setGlobalError(result.error ?? 'No se pudo generar el análisis')
    }
  } catch {
    setGlobalError('Error de red al generar el análisis')
  } finally {
    setGeneratingGlobal(false)
  }
}
```

Cargar el histórico cuando `canSeeGlobalAnalysis` pasa a `true` — agregar un `useEffect` nuevo (después del `useEffect` de `loadVendorData`):

```ts
useEffect(() => {
  if (canSeeGlobalAnalysis) loadGlobalHistory()
}, [canSeeGlobalAnalysis, id])
```

- [ ] **Step 4: Agregar la sección en el JSX**

Insertar esta sección nueva entre el "Gráfico de evolución" y el "Pipeline Kanban" (entre las líneas 389 y 391 del archivo actual — después del `{chartData.length > 1 && (...)}`, antes del comentario `{/* Pipeline Kanban */}`):

```tsx
{/* Análisis global diario (últimos 3 días) */}
{canSeeGlobalAnalysis && (
  <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-semibold text-body">Análisis Global (últimos 3 días)</h3>
      <button
        onClick={generateGlobalAnalysis}
        disabled={generatingGlobal}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary hover:bg-primary-dark text-white font-semibold transition-colors disabled:opacity-60"
      >
        <RefreshCw size={14} className={generatingGlobal ? 'animate-spin' : ''} />
        {generatingGlobal ? 'Generando...' : 'Generar análisis de hoy'}
      </button>
    </div>

    {globalError && (
      <p className="text-sm text-red-500 mb-3">{globalError}</p>
    )}

    {loadingGlobalHistory ? (
      <p className="text-sm text-gray-400">Cargando...</p>
    ) : globalHistory.length === 0 ? (
      <p className="text-sm text-gray-400 text-center py-4">
        Todavía no se generó ningún análisis global para este vendedor.
      </p>
    ) : (
      <div className="space-y-4">
        {(() => {
          const latest = globalHistory[0]
          const trend = latest.avg_quality_score !== null && latest.avg_quality_score_prev_window !== null
            ? latest.avg_quality_score - latest.avg_quality_score_prev_window
            : null
          return (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-xs text-gray-400">
                  {new Date(latest.date).toLocaleDateString('es-AR')} · {latest.conversations_analyzed} conversaciones analizadas
                </span>
                {latest.avg_quality_score !== null && (
                  <ScoreBadge score={Math.round(latest.avg_quality_score)} size="sm" />
                )}
                {trend !== null && (
                  <span className={`text-xs font-semibold ${trend > 0 ? 'text-green-600' : trend < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {trend > 0 ? '▲' : trend < 0 ? '▼' : '='} {Math.abs(trend).toFixed(1)} vs. período anterior
                  </span>
                )}
              </div>

              {latest.summary_text && (
                <p className="text-sm text-gray-700 leading-relaxed mb-3">{latest.summary_text}</p>
              )}

              {(latest.recurring_strengths.length > 0 || latest.recurring_weaknesses.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  {latest.recurring_strengths.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-green-700 mb-1">Fortalezas recurrentes</p>
                      <ul className="text-xs text-gray-600 space-y-0.5 list-disc list-inside">
                        {latest.recurring_strengths.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {latest.recurring_weaknesses.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-red-600 mb-1">Debilidades recurrentes</p>
                      <ul className="text-xs text-gray-600 space-y-0.5 list-disc list-inside">
                        {latest.recurring_weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {latest.coaching_plan && (
                <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-4 mb-3">
                  <h4 className="font-semibold text-yellow-800 flex items-center gap-2 mb-2 text-sm">
                    <Lock size={14} /> Plan de Coaching (Privado)
                  </h4>
                  <p className="text-sm text-yellow-900 leading-relaxed">{latest.coaching_plan}</p>
                </div>
              )}
            </div>
          )
        })()}

        {globalHistory.length > 1 && (
          <div className="pt-3 border-t border-border">
            <p className="text-xs font-semibold text-gray-500 mb-2">Histórico</p>
            <div className="space-y-1">
              {globalHistory.slice(1).map(h => (
                <div key={h.id} className="flex items-center justify-between text-xs text-gray-500 py-1">
                  <span>{new Date(h.date).toLocaleDateString('es-AR')} · {h.conversations_analyzed} conversaciones</span>
                  {h.avg_quality_score !== null && <ScoreBadge score={Math.round(h.avg_quality_score)} size="sm" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Verificación manual**

```bash
npm run dev
```

Entrar a `/vendors` → click en un vendedor → confirmar:
- Si el usuario logueado es admin, o supervisor de ese vendedor: aparece la sección "Análisis Global (últimos 3 días)".
- Si es supervisor de OTRO vendedor (no de este): la sección no aparece.
- Click en "Generar análisis de hoy" → el botón muestra "Generando..." → al terminar aparece el resumen, fortalezas/debilidades recurrentes, plan de coaching, y el score con la tendencia vs. el período anterior.
- Volver a clickear "Generar" el mismo día → se actualiza la misma entrada (no aparece una segunda fila duplicada en "Histórico").

- [ ] **Step 7: Commit**

```bash
git add "app/(dashboard)/vendors/[id]/page.tsx"
git commit -m "feat: seccion de analisis global diario en el perfil del vendedor"
```

**Rollback:** cambio acotado a un archivo de página — `git revert` sin efecto en datos (la tabla `vendor_daily_analyses` queda con historial pero nadie más la lee).

---

## Fuera de este plan

- **Automatizar la generación diaria con un cron real** (Vercel Cron + `vercel.json` + secret de autenticación) — el usuario decidió explícitamente arrancar con botón manual. Si más adelante se quiere automatizar, es un plan aparte que reutiliza `generateVendorGlobalAnalysis` tal cual, solo cambia el disparador.
- **Análisis global agregado de todo el equipo** (no por vendedor individual) — no fue pedido, y el prompt/tabla actuales son por-vendedor.
- **Mostrar el análisis global en el listado de Vendedores o al propio vendedor** — explícitamente descartado en las respuestas del usuario; si se quiere después, es un cambio acotado a Task 4 (agregar una columna/badge en `/vendors` y ampliar `canSeeGlobalAnalysis` para incluir al vendedor sobre sí mismo).
