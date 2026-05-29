import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const maxDuration = 60

/**
 * POST /api/conversations/bulk-archive
 *
 * Mueve conversaciones a histórico según condiciones combinables.
 * Body:
 *   dryRun?            boolean  — si true, solo cuenta/lista sin archivar (default false)
 *   unrespondedByClient? boolean — último mensaje enviado por el vendedor (cliente no respondió)
 *   maxMessages?       number   — conversaciones con message_count <= N
 *   minInactiveDays?   number   — sin actividad hace N+ días
 *   dateFrom?          string   — ISO: last_message_at >= dateFrom
 *   dateTo?            string   — ISO: last_message_at <= dateTo
 *
 * Responde:
 *   { count, preview: [{id, client_name, client_phone, message_count, last_message_at}] }
 *   En dry-run devuelve hasta 50 conversaciones de preview.
 *   En ejecución real devuelve { archived, ids }.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users').select('role').eq('id', user.id).single()
    if (!['admin', 'supervisor'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const {
      dryRun            = false,
      archiveAll        = false,
      unrespondedByClient = false,
      maxMessages,
      minInactiveDays,
      dateFrom,
      dateTo,
    } = body as {
      dryRun?: boolean
      archiveAll?: boolean
      unrespondedByClient?: boolean
      maxMessages?: number
      minInactiveDays?: number
      dateFrom?: string
      dateTo?: string
    }

    // Requiere al menos una condición o archiveAll explícito
    const hasCondition = archiveAll || unrespondedByClient || maxMessages != null || minInactiveDays != null || dateFrom || dateTo
    if (!hasCondition) {
      return NextResponse.json({ error: 'Debe especificar al menos una condición de filtro' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()

    // ── Construir query base ──────────────────────────────────────────────────
    let query = service
      .from('conversations')
      .select('id, client_name, display_name, client_phone, message_count, last_message_at, last_message:messages(from_me, msg_timestamp)')
      .eq('status', 'active')
      .order('last_message_at', { ascending: true })

    // Rango de fechas sobre last_message_at
    if (dateFrom) query = query.gte('last_message_at', dateFrom)
    if (dateTo)   query = query.lte('last_message_at', dateTo)

    // Menos de N mensajes
    if (maxMessages != null) query = query.lte('message_count', maxMessages)

    // Sin actividad hace N+ días
    if (minInactiveDays != null) {
      const cutoff = new Date(Date.now() - minInactiveDays * 24 * 60 * 60 * 1000).toISOString()
      query = query.lte('last_message_at', cutoff)
    }

    const { data: rows, error } = await query.limit(2000)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    type Row = {
      id: string
      client_name: string | null
      display_name: string | null
      client_phone: string
      message_count: number
      last_message_at: string | null
      last_message: { from_me: boolean; msg_timestamp: string } | Array<{ from_me: boolean; msg_timestamp: string }> | null
    }

    // ── Filtro en memoria: última dir del mensaje (no es filtrable en SQL sin join) ─
    let filtered = (rows as Row[])

    if (unrespondedByClient) {
      // Mantener solo conversaciones donde el ÚLTIMO mensaje fue del vendedor
      // (cliente no respondió = from_me === true en el último mensaje)
      filtered = filtered.filter(c => {
        const msg = Array.isArray(c.last_message) ? c.last_message[0] : c.last_message
        return msg?.from_me === true
      })
    }

    const count = filtered.length
    const ids   = filtered.map(c => c.id)

    const preview = filtered.slice(0, 50).map(c => ({
      id: c.id,
      name: c.display_name ?? c.client_name ?? c.client_phone,
      client_phone: c.client_phone,
      message_count: c.message_count,
      last_message_at: c.last_message_at,
    }))

    // Dry-run: devolver solo conteo y preview
    if (dryRun) {
      return NextResponse.json({ count, preview })
    }

    // Ejecución real: archivar en lotes de 100
    if (ids.length === 0) {
      return NextResponse.json({ archived: 0, ids: [] })
    }

    const BATCH = 100
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const { error: updateError } = await service
        .from('conversations')
        .update({ status: 'historico' })
        .in('id', batch)

      if (updateError) {
        console.error('[BulkArchive] Error al actualizar lote:', updateError.message)
        // Devolver el error de DB para que el cliente lo muestre
        return NextResponse.json({
          error: `Error al archivar: ${updateError.message}. Puede que el valor 'historico' no sea válido en la columna status. Ejecutá la migración supabase/fix_conversations_status_historico.sql`,
        }, { status: 500 })
      }
    }

    console.log(`[BulkArchive] Archivadas ${ids.length} conversaciones por ${profile?.role} ${user.id}`)

    return NextResponse.json({ archived: ids.length, ids })
  } catch (err) {
    console.error('[BulkArchive] Error:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
