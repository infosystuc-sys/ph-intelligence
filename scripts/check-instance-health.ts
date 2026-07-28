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
    if (result.connectionCheckError) console.log(`   Error conexión: ${result.connectionCheckError}`)
    if (result.disconnectedAt) console.log(`   Desconectada desde: ${result.disconnectedAt}`)
    console.log(`   Webhook: ${!result.webhookVerified ? 'no verificado' : result.webhookOk ? 'OK' : `mal configurado (url: ${result.webhookUrl ?? 'ninguna'})`}`)
    if (result.webhookCheckError) console.log(`   Error webhook: ${result.webhookCheckError}`)
    console.log(`   Último mensaje recibido: ${result.lastInboundMessageAt ?? 'sin registros'}`)
    console.log('')
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
