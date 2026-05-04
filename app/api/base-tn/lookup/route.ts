import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { normalizePhone } from '@/lib/utils'

export interface BaseMatch {
  cod_cliente: string | null
  source: string
}

// GET /api/base-tn/lookup
// Devuelve mapa teléfono normalizado → { cod_cliente, source }
// El frontend lo usa como fallback para conversaciones sin cod_cliente en BD
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { data, error } = await service
      .from('base_tn')
      .select('cod_cliente, telefono_1, telefono_2, source')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const map: Record<string, BaseMatch> = {}

    for (const row of data ?? []) {
      const entry: BaseMatch = {
        cod_cliente: row.cod_cliente ?? null,
        source: row.source ?? 'naranja',
      }
      if (row.telefono_1) {
        const norm = normalizePhone(row.telefono_1)
        if (norm.length >= 8 && !map[norm]) map[norm] = entry
      }
      if (row.telefono_2) {
        const norm = normalizePhone(row.telefono_2)
        if (norm.length >= 8 && !map[norm]) map[norm] = entry
      }
    }

    return NextResponse.json({ data: map })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
