# Estado real de instancias WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En Configuración > Instancias WhatsApp, mostrar un semáforo veraz por instancia (conexión WhatsApp + webhook + último mensaje recibido) que se verifica automáticamente contra Evolution API y Supabase al abrir la pestaña, en vez del campo `status` desactualizado que hoy se lee directo de la base.

**Architecture:** Se extrae la lógica de verificación a `lib/instance-health.ts` (una función pura reusable), se extiende el endpoint ya existente `/api/instances/refresh-status` para usarla y devolver el detalle completo, y se agrega un componente de UI (`InstanceHealthBadge`) que la pestaña de Configuración dispara automáticamente al montarse.

**Tech Stack:** Next.js 16 App Router (Route Handlers), React 19, Supabase (service role), Evolution API v2 (self-signed cert vía `evolutionFetch` existente), Tailwind, lucide-react.

## Global Constraints

- Este repo **no tiene framework de tests** (sin jest/vitest, sin script `test` en `package.json`). La verificación de cada tarea usa: `npx tsc --noEmit` para tipos, un script standalone (`npx tsx scripts/...`) contra las APIs reales para la lógica de negocio, y arranque del dev server para confirmar que las rutas compilan y responden. La verificación visual final en el navegador (login como admin) queda para que la haga un humano — el agente no tiene ni debe pedir la contraseña del admin de producción.
- **No hacer `git commit` en ningún paso** salvo que el usuario lo pida explícitamente — regla del proyecto, tiene prioridad sobre la convención genérica de "commitear seguido" de la skill de planes.
- Todas las llamadas nuevas a Evolution API usan `evolutionFetch` de `lib/evolution.ts` (agente HTTPS que acepta el certificado autofirmado de Easypanel) — nunca `fetch` nativo.
- Todas las llamadas nuevas a Evolution API llevan timeout de 5s vía `AbortController`, igual que el código existente en `refresh-status/route.ts`.
- La URL base de Evolution siempre se resuelve como `process.env.EVOLUTION_API_BASE_URL || instance.api_url` (con `.replace(/\/$/, '')`), igual que el código existente — nunca usar `instance.api_url` solo.
- Ningún dato se infiere cuando no se pudo verificar: se marca explícitamente como "no verificado", nunca se asume conectado ni desconectado.
- Textos de UI en español, mismo tono que el resto de `settings/page.tsx` (directo, sin adornos).

---

### Task 1: Lógica de verificación (`lib/instance-health.ts`)

**Files:**
- Create: `lib/instance-health.ts`
- Modify: `types/index.ts` (agregar tipos al final del archivo, después de la sección de Instancias WhatsApp)

**Interfaces:**
- Consumes: `evolutionFetch` de `lib/evolution.ts` (`(url: string, init?: RequestInit) => Promise<Response>`); `SupabaseClient` de `@supabase/supabase-js`.
- Produces: `checkInstanceHealth(instance: { id: string; instance_name: string; api_key: string; api_url: string }, supabase: SupabaseClient): Promise<InstanceHealthResult>` — usada por Task 3 (ruta API) y Task 2 (script de verificación). Tipos `ConnectionState`, `InstanceHealthColor`, `InstanceHealthResult` exportados desde `types/index.ts`.

- [ ] **Step 1: Agregar los tipos a `types/index.ts`**

Al final del archivo (después del bloque de `WhatsappInstance`, línea 38 aprox.), agregar:

```ts
// ── Estado real de instancias WhatsApp (conexión + webhook + últimos mensajes) ─
export type ConnectionState = 'open' | 'close' | 'connecting' | 'unknown'
export type InstanceHealthColor = 'green' | 'yellow' | 'red'

export interface InstanceHealthResult {
  instanceId: string
  connected: boolean
  connectionVerified: boolean
  connectionState: ConnectionState
  disconnectReason: string | null
  disconnectedAt: string | null
  webhookVerified: boolean
  webhookOk: boolean | null
  webhookUrl: string | null
  lastInboundMessageAt: string | null
  health: InstanceHealthColor
}
```

- [ ] **Step 2: Crear `lib/instance-health.ts`**

```ts
import { SupabaseClient } from '@supabase/supabase-js'
import { evolutionFetch } from './evolution'
import { ConnectionState, InstanceHealthResult } from '@/types'

const CHECK_TIMEOUT_MS = 5000

// Códigos de desconexión de Baileys/Evolution (WhiskeySockets/Baileys DisconnectReason).
// Verificado en vivo el 28/7/2026: 401 = sesión cerrada/dispositivo desvinculado
// (motivo real detrás de 8 de las 9 instancias caídas encontradas ese día).
const DISCONNECT_REASONS: Record<number, string> = {
  401: 'Sesión cerrada (dispositivo desvinculado o inicio de sesión en otro lugar)',
  403: 'Prohibido por WhatsApp (posible restricción de cuenta)',
  408: 'Tiempo de espera agotado',
  411: 'Sesión reemplazada por otro dispositivo',
  428: 'Conexión cerrada por WhatsApp',
  440: 'Sesión reemplazada (se inició en otro dispositivo)',
  500: 'Error interno del servidor Evolution',
  515: 'Reinicio de sesión requerido',
}

function describeDisconnectReason(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null
  return DISCONNECT_REASONS[code] ?? `Código de desconexión ${code}`
}

type InstanceRef = { instance_name: string; api_key: string }

async function fetchConnectionInfo(baseUrl: string, instance: InstanceRef): Promise<{
  state: ConnectionState
  disconnectReason: string | null
  disconnectedAt: string | null
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await evolutionFetch(`${baseUrl}/instance/fetchInstances`, {
      headers: { apikey: instance.api_key },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Array<{
      connectionStatus?: string
      disconnectionReasonCode?: number | null
      disconnectionAt?: string | null
    }>
    const info = Array.isArray(data) ? data[0] : null
    if (!info) throw new Error('Respuesta vacía de fetchInstances')
    return {
      state: (info.connectionStatus as ConnectionState) ?? 'unknown',
      disconnectReason: describeDisconnectReason(info.disconnectionReasonCode),
      disconnectedAt: info.disconnectionAt ?? null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchWebhookInfo(baseUrl: string, instance: InstanceRef): Promise<{
  ok: boolean
  url: string | null
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await evolutionFetch(`${baseUrl}/webhook/find/${instance.instance_name}`, {
      headers: { apikey: instance.api_key },
      signal: controller.signal,
    })
    // 404 = Evolution respondió que no hay webhook registrado para esta instancia.
    // Es una respuesta válida y definitiva, no un fallo de red — cuenta como "verificado".
    if (res.status === 404) return { ok: false, url: null }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { url?: string; enabled?: boolean; events?: string[] }
    const expectedUrl = process.env.N8N_WEBHOOK_URL
    const ok = !!data.enabled && !!expectedUrl && data.url === expectedUrl && !!data.events?.includes('MESSAGES_UPSERT')
    return { ok, url: data.url ?? null }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchLastInboundMessage(supabase: SupabaseClient, instanceId: string): Promise<string | null> {
  const { data } = await supabase
    .from('conversations')
    .select('last_message_at')
    .eq('instance_id', instanceId)
    .eq('last_message_from_me', false)
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { last_message_at: string } | null)?.last_message_at ?? null
}

// Verifica las 3 señales de una instancia en paralelo. Nunca lanza — cada señal
// que falla queda marcada como "no verificada" en el resultado en vez de tirar
// abajo el chequeo completo de la instancia.
export async function checkInstanceHealth(
  instance: { id: string; instance_name: string; api_key: string; api_url: string },
  supabase: SupabaseClient,
): Promise<InstanceHealthResult> {
  const baseUrl = (process.env.EVOLUTION_API_BASE_URL || instance.api_url).replace(/\/$/, '')

  const [connSettled, webhookSettled, lastMsgSettled] = await Promise.allSettled([
    fetchConnectionInfo(baseUrl, instance),
    fetchWebhookInfo(baseUrl, instance),
    fetchLastInboundMessage(supabase, instance.id),
  ])

  const conn = connSettled.status === 'fulfilled' ? connSettled.value : null
  const webhook = webhookSettled.status === 'fulfilled' ? webhookSettled.value : null
  const lastInboundMessageAt = lastMsgSettled.status === 'fulfilled' ? lastMsgSettled.value : null

  const connectionVerified = conn !== null
  const connectionState: ConnectionState = conn?.state ?? 'unknown'
  const connected = connectionVerified && connectionState === 'open'
  const connectionBad = connectionVerified && !connected

  const webhookVerified = webhook !== null
  const webhookOk = webhook?.ok ?? null
  const webhookBad = webhookVerified && webhookOk === false

  // Precedencia: rojo gana sobre amarillo. Si ya hay evidencia concreta de un
  // problema (conexión cerrada o webhook mal configurado), mostrar "no
  // verificado" por la otra señal sería menos veraz que mostrar el problema real.
  const health: InstanceHealthResult['health'] =
    connectionBad || webhookBad ? 'red'
    : (!connectionVerified || !webhookVerified) ? 'yellow'
    : 'green'

  return {
    instanceId: instance.id,
    connected,
    connectionVerified,
    connectionState,
    disconnectReason: conn?.disconnectReason ?? null,
    disconnectedAt: conn?.disconnectedAt ?? null,
    webhookVerified,
    webhookOk,
    webhookUrl: webhook?.url ?? null,
    lastInboundMessageAt,
    health,
  }
}
```

- [ ] **Step 3: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos relacionados a `lib/instance-health.ts` ni `types/index.ts` (pueden preexistir errores en otros archivos no tocados por este plan; si aparecen, confirmar que ya existían antes de este cambio).

---

### Task 2: Script de verificación contra datos reales (`scripts/check-instance-health.ts`)

Sirve dos propósitos: (1) verificar `checkInstanceHealth` contra Evolution API y Supabase reales sin necesitar login de admin en el navegador, comparando contra el resultado ya confirmado manualmente el 28/7/2026 (Lajitas/Saravia/Galpon/9000/Tucuman1-3/Trancas/SanPedro = rojo, JVGonzalez/Quebrachal = verde); (2) queda como herramienta permanente de diagnóstico por CLI, útil para revisar el estado sin abrir el navegador.

**Files:**
- Create: `scripts/check-instance-health.ts`

**Interfaces:**
- Consumes: `checkInstanceHealth` de `lib/instance-health.ts` (Task 1).

- [ ] **Step 1: Crear el script**

```ts
/**
 * DIAGNÓSTICO — Estado real de instancias WhatsApp
 *
 * Corre el mismo chequeo de 3 señales (conexión, webhook, último mensaje
 * recibido) que usa Configuración > Instancias, pero por CLI — útil para
 * revisar el estado sin abrir el navegador, o para depurar sin necesitar
 * sesión de admin.
 *
 * Uso: npx tsx scripts/check-instance-health.ts
 * Requiere: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *           EVOLUTION_API_BASE_URL, N8N_WEBHOOK_URL en .env.local
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { checkInstanceHealth } from '../lib/instance-health'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
  const { data: instances, error } = await supabase
    .from('whatsapp_instances')
    .select('id, instance_name, api_key, api_url')
    .order('instance_name')

  if (error) throw error
  if (!instances?.length) {
    console.log('No hay instancias configuradas.')
    return
  }

  for (const inst of instances) {
    const result = await checkInstanceHealth(inst, supabase)
    const icon = result.health === 'green' ? '🟢' : result.health === 'red' ? '🔴' : '🟡'
    console.log(`${icon} ${inst.instance_name}`)
    console.log(`   Conexión: ${result.connectionVerified ? result.connectionState : 'no verificado'}${result.disconnectReason ? ` — ${result.disconnectReason}` : ''}`)
    if (result.disconnectedAt) console.log(`   Desconectada desde: ${result.disconnectedAt}`)
    console.log(`   Webhook: ${!result.webhookVerified ? 'no verificado' : result.webhookOk ? 'OK' : `mal configurado (url: ${result.webhookUrl ?? 'ninguna'})`}`)
    console.log(`   Último mensaje recibido: ${result.lastInboundMessageAt ?? 'sin registros'}`)
    console.log('')
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Correr el script y comparar contra el estado real conocido**

Run: `npx tsx scripts/check-instance-health.ts`

Expected: JVGonzalez y Quebrachal en 🟢 con `Conexión: open`; las otras 9 instancias (Lajitas, Saravia, Galpon, 9000, Tucuman1, Tucuman2, Tucuman3, Trancas, SanPedro) en 🔴 con `Conexión: close` y un `disconnectReason` no vacío (la mayoría "Sesión cerrada…", Tucuman3 con el texto de 403). Todas las instancias deberían mostrar `Webhook: OK` (confirmado en vivo el 28/7 que las 11 tienen webhook bien configurado — si alguna aparece distinta, revisar si cambió algo en Evolution desde entonces antes de asumir un bug en el código). Si algún resultado no coincide con esta tabla, el bug está en `lib/instance-health.ts`, no en los datos — depurar ahí antes de seguir a la Task 3.

---

### Task 3: Extender el endpoint `/api/instances/refresh-status`

**Files:**
- Modify: `app/api/instances/refresh-status/route.ts`

**Interfaces:**
- Consumes: `checkInstanceHealth` de `lib/instance-health.ts` (Task 1).
- Produces: `POST /api/instances/refresh-status` → `{ results: InstanceHealthResult[] }`. Sigue actualizando `whatsapp_instances.status` en la DB (compatibilidad con el Dashboard, que solo lee `.connected`).

- [ ] **Step 1: Reemplazar el contenido del archivo**

```ts
import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { checkInstanceHealth } from '@/lib/instance-health'
import { InstanceHealthResult } from '@/types'

export const maxDuration = 30

// POST /api/instances/refresh-status
// Verifica conexión + webhook + último mensaje recibido de cada instancia
// contra Evolution API y la base, y actualiza whatsapp_instances.status.
// Responde con { results: InstanceHealthResult[] }
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data: instances } = await service
      .from('whatsapp_instances')
      .select('id, instance_name, api_key, api_url')

    if (!instances?.length) return NextResponse.json({ results: [] })

    const checks = await Promise.allSettled(
      instances.map(async (inst): Promise<InstanceHealthResult> => {
        const result = await checkInstanceHealth(inst, service)
        await service
          .from('whatsapp_instances')
          .update({ status: result.connected ? 'connected' : 'disconnected' })
          .eq('id', inst.id)
        return result
      })
    )

    const results: InstanceHealthResult[] = checks.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            instanceId: instances[i].id,
            connected: false,
            connectionVerified: false,
            connectionState: 'unknown',
            disconnectReason: null,
            disconnectedAt: null,
            webhookVerified: false,
            webhookOk: null,
            webhookUrl: null,
            lastInboundMessageAt: null,
            health: 'yellow',
          }
    )

    return NextResponse.json({ results })
  } catch (err) {
    console.error('[refresh-status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos.

- [ ] **Step 3: Verificar que la ruta exige autenticación**

Run: `npm run dev` (en una terminal aparte, dejarlo corriendo) y luego:
`curl -s -X POST http://localhost:3010/api/instances/refresh-status`

Expected: `{"error":"No autorizado"}` con status 401 (sin cookie de sesión). Esto confirma que el guard de auth sigue intacto después del cambio — no es posible verificar el path autenticado (200) sin login real de admin en el navegador, eso queda para la verificación manual final (Task 6, Step 4).

---

### Task 4: Actualizar el tipo usado por el Dashboard

El Dashboard (`app/(dashboard)/dashboard/page.tsx`) ya llama a este mismo endpoint en segundo plano y solo lee `.connected` — no necesita ningún campo nuevo, pero su anotación de tipo local quedaría desalineada con la respuesta real si no se actualiza. Cambio mínimo, sin tocar comportamiento.

**Files:**
- Modify: `app/(dashboard)/dashboard/page.tsx:213-216`

**Interfaces:**
- Consumes: `InstanceHealthResult` de `types/index.ts` (Task 1).

- [ ] **Step 1: Actualizar la anotación de tipo**

Reemplazar:

```ts
      const { results } = await res.json() as {
        results: { instanceId: string; connected: boolean; state: string }[]
      }
```

por:

```ts
      const { results } = await res.json() as { results: InstanceHealthResult[] }
```

Y agregar `InstanceHealthResult` al import ya existente en la línea 9 del archivo:

```ts
import { DashboardStats, User, InstanceHealthResult } from '@/types'
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos. El resto del archivo sigue usando `r.connected` exactamente igual que antes — no debería haber ningún otro cambio necesario.

---

### Task 5: Utilidad de fecha para timestamps genuinamente UTC (`lib/utils.ts`)

`formatDistanceToNow` (ya usada en todo el proyecto) resta 3 horas a propósito porque N8N guarda hora argentina mal etiquetada como UTC (ver comentario en el archivo). El campo `disconnectedAt` que se va a mostrar en el badge **no** viene de N8N — viene directo de Evolution API con un timestamp UTC real y correcto. Aplicarle esa misma resta de 3 horas mostraría una fecha incorrecta. Se necesita una función separada que no aplique esa compensación.

**Files:**
- Modify: `lib/utils.ts` (agregar función nueva cerca de `formatDistanceToNow`, no reemplazarla)

**Interfaces:**
- Produces: `formatDistanceToNowUTC(date: Date): string` — usada por Task 6 (componente del badge).

- [ ] **Step 1: Agregar la función**

Insertar después de la función `formatDistanceToNow` existente (después de la línea 21 del archivo, antes de `formatDateLong`):

```ts
// ── Formatear tiempo relativo para timestamps genuinamente UTC ───────────────
// A diferencia de formatDistanceToNow, esta NO compensa los -3h de N8N: úsala
// para timestamps que ya vienen correctamente etiquetados en UTC (ej. los que
// devuelve Evolution API directamente, como disconnectionAt), nunca para
// campos poblados por el pipeline de N8N.
export function formatDistanceToNowUTC(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr  = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffMin < 1) return 'ahora'
  if (diffMin < 60) return `hace ${diffMin}m`
  if (diffHr  < 24) return `hace ${diffHr}h`
  if (diffDay < 7)  return `hace ${diffDay}d`
  return date.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' })
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos.

---

### Task 6: Componente del badge (`components/settings/InstanceHealthBadge.tsx`)

**Files:**
- Create: `components/settings/InstanceHealthBadge.tsx`

**Interfaces:**
- Consumes: `InstanceHealthResult` de `types/index.ts` (Task 1); `formatDistanceToNow` y `formatDistanceToNowUTC` de `lib/utils.ts` (Task 5).
- Produces: `export default function InstanceHealthBadge({ health, checking }: { health: InstanceHealthResult | undefined; checking: boolean }): JSX.Element` — usado por Task 7 (`settings/page.tsx`).

- [ ] **Step 1: Crear el componente**

```tsx
'use client'

import { useState } from 'react'
import { Wifi, WifiOff, Webhook, MessageCircle, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { InstanceHealthResult } from '@/types'
import { formatDistanceToNow, formatDistanceToNowUTC } from '@/lib/utils'

const HEALTH_STYLES: Record<InstanceHealthResult['health'], { bg: string; text: string; label: string }> = {
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Operativa' },
  yellow: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'No verificado' },
  red:    { bg: 'bg-red-100',    text: 'text-red-600',    label: 'Sin recibir mensajes' },
}

export default function InstanceHealthBadge({
  health,
  checking,
}: {
  health: InstanceHealthResult | undefined
  checking: boolean
}) {
  const [open, setOpen] = useState(false)

  if (checking) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-500 text-xs font-medium px-2 py-0.5">
        Verificando…
      </span>
    )
  }

  if (!health) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-400 text-xs font-medium px-2 py-0.5">
        Sin verificar
      </span>
    )
  }

  const style = HEALTH_STYLES[health.health]

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(p => !p)}
        className={`inline-flex items-center gap-1 rounded-full font-medium text-xs px-2 py-0.5 ${style.bg} ${style.text}`}
      >
        {style.label}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-72 bg-surface border border-border rounded-lg shadow-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-start gap-2">
            {health.connected
              ? <Wifi size={14} className="text-green-600 mt-0.5 shrink-0" />
              : <WifiOff size={14} className="text-red-500 mt-0.5 shrink-0" />}
            <div>
              <p className="font-medium text-body">
                Conexión WhatsApp: {!health.connectionVerified ? 'no se pudo verificar' : health.connected ? 'abierta' : 'cerrada'}
              </p>
              {health.disconnectReason && (
                <p className="text-gray-500 mt-0.5">{health.disconnectReason}</p>
              )}
              {health.disconnectedAt && (
                <p className="text-gray-400 mt-0.5">Desde {formatDistanceToNowUTC(new Date(health.disconnectedAt))}</p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            {!health.webhookVerified
              ? <HelpCircle size={14} className="text-yellow-500 mt-0.5 shrink-0" />
              : <Webhook size={14} className={health.webhookOk ? 'text-green-600 mt-0.5 shrink-0' : 'text-red-500 mt-0.5 shrink-0'} />}
            <div>
              <p className="font-medium text-body">
                Webhook: {!health.webhookVerified ? 'no se pudo verificar' : health.webhookOk ? 'configurado correctamente' : 'ausente o mal configurado'}
              </p>
              {health.webhookVerified && !health.webhookOk && (
                <p className="text-gray-500 mt-0.5 break-all">
                  {health.webhookUrl ? `Apunta a: ${health.webhookUrl}` : 'No hay webhook registrado'}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <MessageCircle size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-body">Último mensaje recibido</p>
              <p className="text-gray-500 mt-0.5">
                {health.lastInboundMessageAt
                  ? formatDistanceToNow(new Date(health.lastInboundMessageAt))
                  : 'sin mensajes registrados'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos. Confirmar que `lucide-react` exporta `Webhook`, `MessageCircle` y `HelpCircle` (ya se usan íconos de la misma librería en `settings/page.tsx`, así que deberían existir); si el compilador marca alguno como inexistente, buscar el ícono equivalente disponible en la versión instalada (`Radio` o `Link2` en vez de `Webhook`, por ejemplo) y ajustar el import.

---

### Task 7: Conectar el badge a la pestaña de Instancias (`app/(dashboard)/settings/page.tsx`)

**Files:**
- Modify: `app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: `InstanceHealthBadge` (Task 6), `InstanceHealthResult` de `types/index.ts` (Task 1).

- [ ] **Step 1: Agregar el import del componente**

Junto a los demás imports al inicio del archivo (después de la línea `import { useSyncContext } from '@/contexts/SyncContext'`):

```ts
import InstanceHealthBadge from '@/components/settings/InstanceHealthBadge'
```

Y agregar `InstanceHealthResult` al import existente de tipos:

```ts
import { User, WhatsappInstance, InstanceHealthResult } from '@/types'
```

- [ ] **Step 2: Agregar estado y el efecto de auto-chequeo**

Cerca de las demás declaraciones de estado de instancias (después de `const [remoteInstances, setRemoteInstances] = useState<string[] | null>(null)`):

```ts
  const [instanceHealth, setInstanceHealth] = useState<Record<string, InstanceHealthResult>>({})
  const [checkingHealth, setCheckingHealth] = useState(false)
  const healthCheckedRef = useRef(false)
```

Junto a los demás `useEffect` del componente (después del `useEffect` de `checkAdminAccess`/`loadData`):

```ts
  useEffect(() => {
    if (activeTab === 'instances' && !healthCheckedRef.current) {
      healthCheckedRef.current = true
      checkInstancesHealth()
    }
  }, [activeTab])

  const checkInstancesHealth = async () => {
    setCheckingHealth(true)
    try {
      const res = await fetch('/api/instances/refresh-status', { method: 'POST' })
      if (!res.ok) return
      const { results } = await res.json() as { results: InstanceHealthResult[] }
      setInstanceHealth(Object.fromEntries(results.map(r => [r.instanceId, r])))
    } finally {
      setCheckingHealth(false)
    }
  }
```

- [ ] **Step 3: Reemplazar la columna "Estado"**

Reemplazar el bloque final (el `else` que hoy lee `inst.status`, líneas 1076-1080 del archivo original):

```tsx
                          ) : (
                            <span className={`flex items-center gap-1 text-xs font-medium ${inst.status === 'connected' ? 'text-green-600' : 'text-gray-400'}`}>
                              {inst.status === 'connected' ? <><Wifi size={12} /> Conectada</> : <><WifiOff size={12} /> {inst.status}</>}
                            </span>
                          )}
```

por:

```tsx
                          ) : (
                            <InstanceHealthBadge
                              health={instanceHealth[inst.id]}
                              checking={checkingHealth && !instanceHealth[inst.id]}
                            />
                          )}
```

El resto de la celda (los casos `test?.loading` y `test`, que muestran el resultado del botón "Probar") queda exactamente igual — solo cambia el `else` final.

- [ ] **Step 4: Verificar tipos y compilación**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos.

Run: `npm run build`
Expected: build exitoso (confirma que no hay errores de sintaxis/imports que `tsc --noEmit` no capture, ya que este proyecto no tiene lint/test configurado — el build es la última red de seguridad automática).

- [ ] **Step 5: Verificación manual en navegador (humano)**

Este paso lo tiene que hacer un humano con acceso a la cuenta admin — el agente no tiene ni debe pedir esa contraseña de producción.

1. `npm run dev`
2. Entrar como admin, ir a Configuración > Instancias WhatsApp.
3. Confirmar que al entrar a la pestaña se dispara la verificación sola (badges en "Verificando…" y después se resuelven).
4. Confirmar contra la tabla de la Task 2: JVGonzalez y Quebrachal en verde ("Operativa"), las otras 9 en rojo ("Sin recibir mensajes").
5. Hacer click en un badge rojo (ej. Lajitas) y confirmar que el detalle muestra "Sesión cerrada..." y "Desde hace 13d" (o el valor que corresponda a esa fecha en el momento de la prueba).
6. Hacer click en un badge verde y confirmar que no muestra ningún motivo de desconexión.
7. Confirmar que el botón "Probar" de cada fila sigue funcionando igual que antes (no se tocó esa lógica).

---

## Resumen de cobertura del spec

- Señal de conexión (con motivo real de caída) → Task 1 + 3.
- Señal de webhook (URL/enabled/evento correctos) → Task 1 + 3.
- Señal de último mensaje recibido (sin umbral de alerta) → Task 1 + 3.
- Precedencia rojo > amarillo cuando hay señal mixta → Task 1 (lógica en `checkInstanceHealth`).
- Auto-refresh al abrir la pestaña → Task 7.
- Semáforo + detalle al click → Task 6 + 7.
- Timestamps veraces (sin aplicar la compensación de N8N a datos que no vienen de N8N) → Task 5.
- Compatibilidad con el Dashboard existente → Task 4.
