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
// Presupuesto de tiempo total para el loop de reconciliación. maxDuration del route
// es 120s; con 11 instancias y TIMEOUT_MS=10s el peor caso ronda 110s, demasiado
// cerca del límite — si Vercel corta la función a los 120s no queda ni respuesta
// parcial. Con este budget, si se acerca el límite cortamos el loop y devolvemos
// lo que ya se procesó en vez de morir sin respuesta.
const BUDGET_MS = 90000

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
export async function findReconcileDiscrepancies(
  instances: ReconcileInstanceRow[],
): Promise<{ findings: ReconcileFinding[]; truncated: boolean }> {
  const findings: ReconcileFinding[] = []
  const startedAt = Date.now()
  let truncated = false
  for (const inst of instances) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true
      break
    }
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
  return { findings, truncated }
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
