# Diagnóstico de red + reconciliación de instancias WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el estado de las 11 instancias WhatsApp en Configuración deje de mostrar "No verificado" sin motivo, agregando (1) diagnóstico detallado de por qué el chequeo de red falla en producción, y (2) una herramienta asistida para corregir instancias con `instance_name`/`phone_number` desalineados contra Evolution API.

**Architecture:** Dos piezas independientes sobre el código existente (`lib/evolution.ts`, `lib/instance-health.ts`, pestaña Instancias en `app/(dashboard)/settings/page.tsx`), sin tocar el contrato del endpoint `/api/instances/refresh-status` que ya consume el Dashboard. Nada de infraestructura nueva.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + `@supabase/supabase-js`), sin framework de testing — el proyecto verifica con scripts `tsx` ad-hoc (ver `scripts/check-instance-health.ts`) y verificación manual en producción, se sigue ese mismo patrón acá.

## Global Constraints

- No se modifica el contrato de `/api/instances/refresh-status` (el Dashboard lo consume y no debe romperse).
- Todas las llamadas a Evolution API siguen pasando por `evolutionFetch` (maneja el certificado autofirmado de Easypanel vía `sslAgent`).
- Cada cambio debe ser revertible: commits separados por task, sin migraciones destructivas, con mecanismo de deshacer para cualquier `UPDATE` sobre `whatsapp_instances`.
- Este repo deploya a producción automáticamente al pushear a `master` (no hay entorno de staging) — cada task se prueba localmente antes de pushear.

---

### Task 1: Diagnóstico detallado de timeout en `evolutionFetch`

**Files:**
- Modify: `lib/evolution.ts:12-44` (función `evolutionFetch`)

**Interfaces:**
- Consumes: nada nuevo — mismo signature `evolutionFetch(url: string, init?: RequestInit): Promise<Response>`.
- Produces: cuando la request se aborta por timeout, `Response`/`Error` sigue teniendo `name: 'AbortError'` (lo consume `app/api/instances/test/route.ts:80`), pero `error.message` ahora incluye cuánto tardó y si el socket TCP llegó a conectar. Este mensaje ya viaja sin cambios adicionales hasta `connectionCheckError`/`webhookCheckError` en `lib/instance-health.ts:159-160` y se muestra en `components/settings/InstanceHealthBadge.tsx:68,87`.

- [ ] **Step 1: Reemplazar la implementación de `evolutionFetch`**

En `lib/evolution.ts`, reemplazar el bloque completo de la función (líneas 12-44) por:

```ts
export async function evolutionFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const secure = u.protocol === 'https:'
    const startedAt = Date.now()
    let connectedAt: number | null = null
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
    // Registra si el socket TCP llegó a conectar y cuándo. Es la única forma de
    // distinguir, cuando el abort dispara, entre "nunca conectó" (bloqueo de red/
    // firewall) y "conectó pero nadie respondió" (proxy/servidor colgado) — hoy
    // ambos casos se ven idénticos como un "AbortError" sin más info.
    req.on('socket', (socket) => {
      if (!socket.connecting) {
        connectedAt = Date.now() // socket reciclado ya conectado (agente keep-alive)
      } else {
        socket.once('connect', () => { connectedAt = Date.now() })
      }
    })
    req.on('error', reject)
    if (init?.signal) {
      ;(init.signal as AbortSignal).addEventListener('abort', () => {
        req.destroy()
        const elapsedMs = Date.now() - startedAt
        const detail = connectedAt
          ? `socket conectado a los ${connectedAt - startedAt}ms, sin respuesta ${elapsedMs}ms después`
          : `socket nunca conectó en ${elapsedMs}ms`
        reject(Object.assign(new Error(`Timeout tras ${elapsedMs}ms (${detail})`), { name: 'AbortError' }))
      })
    }
    const body = init?.body
    if (typeof body === 'string') req.write(body)
    req.end()
  })
}
```

- [ ] **Step 2: Verificar localmente con un script temporal**

Crear `scripts/_tmp_verify_timeout.ts`:

```ts
import http from 'http'
import { evolutionFetch } from '../lib/evolution'

async function main() {
  const server = http.createServer(() => { /* nunca responde, simula un proxy colgado */ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('sin puerto asignado')

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)

  try {
    await evolutionFetch(`http://127.0.0.1:${address.port}/x`, { signal: controller.signal })
    console.error('FALLO: se esperaba que la request abortara')
    process.exitCode = 1
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log('Mensaje capturado:', msg)
    const ok = /Timeout tras \d+ms \(socket conectado a los \d+ms, sin respuesta \d+ms después\)/.test(msg)
    console.log(ok ? 'OK: el mensaje incluye el diagnóstico esperado' : 'FALLO: formato inesperado')
    if (!ok) process.exitCode = 1
  } finally {
    server.close()
  }
}

main()
```

Run: `npx tsx scripts/_tmp_verify_timeout.ts`
Expected: imprime `Mensaje capturado: Timeout tras ~500ms (socket conectado a los <1-5>ms, sin respuesta ~500ms después)` seguido de `OK: el mensaje incluye el diagnóstico esperado`.

- [ ] **Step 3: Borrar el script temporal**

```bash
rm scripts/_tmp_verify_timeout.ts
```

- [ ] **Step 4: Verificar que el chequeo real sigue funcionando**

Run: `npx tsx scripts/check-instance-health.ts`
Expected: misma salida que antes del cambio (7 instancias 🟢, "9000"/"Galpon"/"Trancas" 🔴 con `HTTP 401: Unauthorized`, "Lajitas" 🔴 con motivo de desconexión) — este cambio no debe alterar ningún resultado, solo enriquecer el mensaje cuando hay timeout.

- [ ] **Step 5: Commit**

```bash
git add lib/evolution.ts
git commit -m "fix: diagnostico detallado de timeout en evolutionFetch (conecto vs nunca conecto)"
```

- [ ] **Step 6: Deploy y checkpoint en producción (manual, requiere al usuario)**

```bash
git push origin master
```

Esperar el deploy de Vercel, entrar a `https://ph-intelligence.vercel.app/settings` → pestaña "Instancias WhatsApp" → click en el badge "No verificado" de cualquier instancia → copiar el texto que ahora aparece en "Conexión WhatsApp" y "Webhook". Ese texto dice si el socket nunca conectó (bloqueo de red) o si conectó y no hubo respuesta (saturación/proxy) — con eso se decide la Fase 3 (no incluida en este plan, se planifica aparte con esa evidencia).

**Rollback:** `git revert` del commit del Step 5. Cambio de un solo archivo, sin estado ni datos involucrados.

---

### Task 2: Backend de reconciliación de instancias

**Files:**
- Create: `supabase/migrations/006_instance_previous_values.sql`
- Create: `lib/instance-reconcile.ts`
- Create: `app/api/instances/reconcile/route.ts`

**Interfaces:**
- Consumes: `evolutionFetch` de `lib/evolution.ts`; `createServerSupabaseClient`/`createServiceSupabaseClient` de `lib/supabase-server.ts` (mismo patrón de auth que `app/api/instances/route.ts:6-48`).
- Produces:
  - `findReconcileDiscrepancies(instances: ReconcileInstanceRow[]): Promise<ReconcileFinding[]>`
  - `applyReconcileFix(supabase: SupabaseClient, instanceId: string): Promise<{ ok: true } | { ok: false; error: string }>`
  - `undoReconcileFix(supabase: SupabaseClient, instanceId: string): Promise<{ ok: true } | { ok: false; error: string }>`
  - Tipo `ReconcileFinding` (usado por Task 3 en el frontend).
  - `GET /api/instances/reconcile` → `{ findings: ReconcileFinding[] }`
  - `POST /api/instances/reconcile` con body `{ action: 'apply' | 'undo', id: string }` → `{ ok: true } | { ok: false, error: string }`

- [ ] **Step 1: Migración — columna para poder deshacer**

Crear `supabase/migrations/006_instance_previous_values.sql`:

```sql
-- Guarda instance_name/phone_number previos cuando se aplica una corrección de
-- reconciliación, para poder deshacerla desde la UI sin tocar la base a mano.
ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS previous_values JSONB;
```

Ejecutar en el SQL Editor de Supabase (mismo flujo manual que las migraciones anteriores, ver `RESUMEN-FASE1.md`).

- [ ] **Step 2: Escribir `lib/instance-reconcile.ts`**

```ts
import { SupabaseClient } from '@supabase/supabase-js'
import { evolutionFetch } from './evolution'

export type ReconcileInstanceRow = {
  id: string
  instance_name: string
  api_key: string
  api_url: string
  phone_number: string | null
}

export type ReconcileFinding =
  | {
      id: string
      kind: 'label_mismatch'
      storedName: string
      storedPhone: string | null
      realName: string
      realPhone: string | null
    }
  | {
      id: string
      kind: 'invalid_credential'
      storedName: string
      storedPhone: string | null
      error: string
    }

const TIMEOUT_MS = 10000

type Identity = { name: string; phone: string | null }

async function fetchRealIdentity(baseUrl: string, apiKey: string): Promise<Identity | { error: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await evolutionFetch(`${baseUrl}/instance/fetchInstances`, {
      headers: { apikey: apiKey },
      signal: controller.signal,
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const data = await res.json() as Array<{ name?: string; ownerJid?: string | null }>
    const info = Array.isArray(data) ? data[0] : null
    if (!info?.name) return { error: 'Evolution no devolvió datos de la instancia' }
    const phone = info.ownerJid ? info.ownerJid.replace('@s.whatsapp.net', '') : null
    return { name: info.name, phone }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timeout)
  }
}

function hasDiscrepancy(inst: ReconcileInstanceRow, identity: Identity): boolean {
  const nameMismatch = identity.name !== inst.instance_name
  const phoneMismatch = !!identity.phone && !!inst.phone_number && identity.phone !== inst.phone_number
  return nameMismatch || phoneMismatch
}

// Secuencial a propósito (no Promise.all): esto corre solo cuando un admin abre
// el panel de reconciliación, nunca en carga automática de página — no hace
// falta paralelizar 11 pedidos y sumar más presión sobre Evolution/Easypanel
// mientras se investiga si la concurrencia es parte del problema de timeouts.
export async function findReconcileDiscrepancies(instances: ReconcileInstanceRow[]): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = []
  for (const inst of instances) {
    const baseUrl = (process.env.EVOLUTION_API_BASE_URL || inst.api_url).replace(/\/$/, '')
    const identity = await fetchRealIdentity(baseUrl, inst.api_key)
    if ('error' in identity) {
      findings.push({
        id: inst.id,
        kind: 'invalid_credential',
        storedName: inst.instance_name,
        storedPhone: inst.phone_number,
        error: identity.error,
      })
      continue
    }
    if (hasDiscrepancy(inst, identity)) {
      findings.push({
        id: inst.id,
        kind: 'label_mismatch',
        storedName: inst.instance_name,
        storedPhone: inst.phone_number,
        realName: identity.name,
        realPhone: identity.phone,
      })
    }
  }
  return findings
}

// Solo corrige instance_name/phone_number — nunca api_key. Si fetchInstances
// respondió 200 con esa api_key, la key ya es la correcta para esa instancia;
// lo único desalineado es el nombre/teléfono que la app tenía guardado.
export async function applyReconcileFix(
  supabase: SupabaseClient,
  instanceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: inst } = await supabase
    .from('whatsapp_instances')
    .select('id, instance_name, api_key, api_url, phone_number')
    .eq('id', instanceId)
    .single()

  if (!inst) return { ok: false, error: 'Instancia no encontrada' }

  const baseUrl = (process.env.EVOLUTION_API_BASE_URL || inst.api_url).replace(/\/$/, '')
  const identity = await fetchRealIdentity(baseUrl, inst.api_key)
  if ('error' in identity) return { ok: false, error: `No se pudo reverificar contra Evolution: ${identity.error}` }
  if (!hasDiscrepancy(inst, identity)) {
    return { ok: false, error: 'Ya no hay discrepancia para esta instancia (puede que ya se haya corregido)' }
  }

  const { error } = await supabase
    .from('whatsapp_instances')
    .update({
      instance_name: identity.name,
      phone_number: identity.phone ?? inst.phone_number,
      previous_values: { instance_name: inst.instance_name, phone_number: inst.phone_number },
    })
    .eq('id', instanceId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function undoReconcileFix(
  supabase: SupabaseClient,
  instanceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: inst } = await supabase
    .from('whatsapp_instances')
    .select('previous_values')
    .eq('id', instanceId)
    .single()

  const prev = inst?.previous_values as { instance_name?: string; phone_number?: string | null } | null
  if (!prev?.instance_name) return { ok: false, error: 'No hay valores anteriores guardados para esta instancia' }

  const { error } = await supabase
    .from('whatsapp_instances')
    .update({ instance_name: prev.instance_name, phone_number: prev.phone_number ?? null, previous_values: null })
    .eq('id', instanceId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
```

- [ ] **Step 3: Escribir la ruta `app/api/instances/reconcile/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { findReconcileDiscrepancies, applyReconcileFix, undoReconcileFix } from '@/lib/instance-reconcile'

export const maxDuration = 30

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: NextResponse.json({ error: 'Sin permisos' }, { status: 403 }) }

  return { error: null }
}

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const service = createServiceSupabaseClient()
  const { data: instances, error: dbError } = await service
    .from('whatsapp_instances')
    .select('id, instance_name, api_key, api_url, phone_number')

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  const findings = await findReconcileDiscrepancies(instances ?? [])
  return NextResponse.json({ findings })
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin()
  if (error) return error

  const body = await req.json()
  const { action, id } = body as { action: 'apply' | 'undo'; id: string }

  if (!id || (action !== 'apply' && action !== 'undo')) {
    return NextResponse.json({ ok: false, error: 'Parámetros inválidos' }, { status: 400 })
  }

  const service = createServiceSupabaseClient()
  const result = action === 'apply'
    ? await applyReconcileFix(service, id)
    : await undoReconcileFix(service, id)

  return NextResponse.json(result)
}
```

- [ ] **Step 4: Verificar localmente contra datos reales**

Run (con `.env.local` apuntando a producción, mismo patrón que `scripts/check-instance-health.ts`):

```bash
npx tsx -e "
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { findReconcileDiscrepancies } from './lib/instance-reconcile'
dotenv.config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
;(async () => {
  const { data } = await supabase.from('whatsapp_instances').select('id, instance_name, api_key, api_url, phone_number')
  const findings = await findReconcileDiscrepancies(data ?? [])
  console.log(JSON.stringify(findings, null, 2))
})()
"
```

Expected: al menos las filas `9000`, `Galpon`, `Trancas` con `kind: 'invalid_credential'`, y cualquier instancia cuyo `name` real de Evolution no coincida con el `instance_name` guardado como `kind: 'label_mismatch'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/006_instance_previous_values.sql lib/instance-reconcile.ts app/api/instances/reconcile/route.ts
git commit -m "feat: endpoint de reconciliacion de instancias WhatsApp (diagnostico + aplicar/deshacer)"
```

**Rollback:** el endpoint es nuevo y aditivo — revertir el commit lo elimina sin efecto en el resto de la app. La columna `previous_values` puede quedar en la tabla sin problema aunque se revierta el código (columna nullable, nadie más la lee).

---

### Task 3: Panel de reconciliación en Configuración

**Files:**
- Modify: `app/(dashboard)/settings/page.tsx` (pestaña Instancias, cerca de `remoteInstances` ~línea 44-46 y ~línea 804-820)

**Interfaces:**
- Consumes: `GET /api/instances/reconcile` → `{ findings: ReconcileFinding[] }`; `POST /api/instances/reconcile` → `{ ok: boolean, error?: string }`; tipo `ReconcileFinding` de `@/lib/instance-reconcile`.

- [ ] **Step 1: Agregar estado y funciones**

En `app/(dashboard)/settings/page.tsx`, junto a los demás `useState` de instancias (cerca de la línea 44-48):

```ts
const [reconcileFindings, setReconcileFindings] = useState<ReconcileFinding[] | null>(null)
const [loadingReconcile, setLoadingReconcile] = useState(false)
const [reconcileActionId, setReconcileActionId] = useState<string | null>(null)
```

Agregar el import de tipo junto a los demás imports de `@/types`... en realidad `ReconcileFinding` vive en `@/lib/instance-reconcile`, así que agregar una línea de import aparte:

```ts
import type { ReconcileFinding } from '@/lib/instance-reconcile'
```

Agregar las funciones (cerca de `checkInstancesHealth`, línea ~142-152):

```ts
const loadReconcileFindings = async () => {
  setLoadingReconcile(true)
  try {
    const res = await fetch('/api/instances/reconcile')
    if (!res.ok) return
    const { findings } = await res.json() as { findings: ReconcileFinding[] }
    setReconcileFindings(findings)
  } finally {
    setLoadingReconcile(false)
  }
}

const applyReconcile = async (id: string) => {
  setReconcileActionId(id)
  try {
    const res = await fetch('/api/instances/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply', id }),
    })
    const result = await res.json() as { ok: boolean; error?: string }
    if (result.ok) {
      await loadData()
      await loadReconcileFindings()
    } else {
      alert(result.error ?? 'No se pudo aplicar la corrección')
    }
  } finally {
    setReconcileActionId(null)
  }
}

const undoReconcile = async (id: string) => {
  setReconcileActionId(id)
  try {
    const res = await fetch('/api/instances/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'undo', id }),
    })
    const result = await res.json() as { ok: boolean; error?: string }
    if (result.ok) {
      await loadData()
    } else {
      alert(result.error ?? 'No se pudo deshacer')
    }
  } finally {
    setReconcileActionId(null)
  }
}
```

- [ ] **Step 2: Agregar el botón y el panel en la pestaña Instancias**

En el JSX, justo después del botón "Ver en Evolution" (`app/(dashboard)/settings/page.tsx:786-793`), agregar un botón hermano:

```tsx
<button
  onClick={loadReconcileFindings}
  disabled={loadingReconcile}
  className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 disabled:opacity-40"
>
  <AlertCircle size={12} className={loadingReconcile ? 'animate-pulse' : ''} />
  {loadingReconcile ? 'Revisando...' : 'Revisar discrepancias'}
</button>
```

(`AlertCircle` ya está importado en la línea 8 del archivo.)

Justo después del bloque `{remoteInstances !== null && (...)}` (línea 805-820), agregar el panel de resultados:

```tsx
{reconcileFindings !== null && (
  <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 space-y-3">
    <p className="text-xs font-semibold text-yellow-800">
      {reconcileFindings.length === 0
        ? 'Sin discrepancias: todas las instancias coinciden con Evolution API.'
        : `${reconcileFindings.length} instancia(s) con datos desalineados:`}
    </p>
    {reconcileFindings.map(f => (
      <div key={f.id} className="bg-surface border border-yellow-200 rounded-md px-3 py-2 text-xs space-y-1">
        {f.kind === 'label_mismatch' ? (
          <>
            <p>
              La app dice <span className="font-mono font-semibold">{f.storedName}</span>
              {f.storedPhone && <> ({f.storedPhone})</>} — Evolution dice{' '}
              <span className="font-mono font-semibold">{f.realName}</span>
              {f.realPhone && <> ({f.realPhone})</>}
            </p>
            <button
              onClick={() => applyReconcile(f.id)}
              disabled={reconcileActionId === f.id}
              className="text-primary hover:underline font-medium disabled:opacity-40"
            >
              {reconcileActionId === f.id ? 'Aplicando...' : 'Corregir'}
            </button>
          </>
        ) : (
          <p className="text-red-600">
            <span className="font-mono font-semibold">{f.storedName}</span>
            {f.storedPhone && <> ({f.storedPhone})</>} — API Key inválida ({f.error}). No se puede identificar
            automáticamente: buscá este número en Evolution Manager y actualizá el API Key desde &quot;Editar&quot;.
          </p>
        )}
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 3: Agregar botón "Deshacer" en la tabla principal para filas con corrección aplicada**

En la fila de la tabla de instancias (cerca de `InstanceHealthBadge` en la línea ~1062), junto a las acciones existentes, agregar condicionalmente:

```tsx
{inst.previous_values && (
  <button
    onClick={() => undoReconcile(inst.id)}
    disabled={reconcileActionId === inst.id}
    className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40"
  >
    {reconcileActionId === inst.id ? 'Deshaciendo...' : 'Deshacer corrección'}
  </button>
)}
```

Esto requiere agregar `previous_values: Record<string, unknown> | null` al tipo `WhatsappInstance` en `types/index.ts:25-38` (junto a `phone_number`), y que `instances` en el estado (`app/(dashboard)/settings/page.tsx:34`) lo reciba — ya viaja solo porque `GET /api/instances` hace `select('*')`.

- [ ] **Step 4: Verificación manual local**

```bash
npm run dev
```

Entrar a `/settings` → pestaña "Instancias WhatsApp" → click "Revisar discrepancias" → confirmar que aparecen las 3-4 filas esperadas (según lo visto en Task 2 Step 4) → aplicar una corrección de tipo `label_mismatch` (si hay alguna) → confirmar que la tabla principal actualiza el nombre y aparece "Deshacer corrección" → click "Deshacer corrección" → confirmar que vuelve al valor anterior.

- [ ] **Step 5: Commit**

```bash
git add app/\(dashboard\)/settings/page.tsx types/index.ts
git commit -m "feat: panel de reconciliacion de instancias en Configuracion"
```

- [ ] **Step 6: Deploy**

```bash
git push origin master
```

**Rollback:** cambio acotado a un componente de página y un campo de tipo opcional — `git revert` sin efecto en datos (la columna `previous_values` queda huérfana en la tabla pero no rompe nada).

---

## Fuera de este plan

La Fase 3 del spec (arreglo del chequeo de red en sí — bajar concurrencia, o mover el chequeo a n8n) depende de la evidencia que deje el Task 1 en producción. No se planifica en detalle acá porque escribir código para ambas ramas antes de saber cuál aplica sería trabajo tirado — se retoma en un plan separado una vez que el checkpoint del Task 1 (Step 6) tenga respuesta.
