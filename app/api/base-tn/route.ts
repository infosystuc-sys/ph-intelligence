import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import * as XLSX from 'xlsx'
import { randomUUID } from 'crypto'

// ── GET: historial de importaciones O registros de un lote ───────────────────
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service = createServiceSupabaseClient()
    const { searchParams } = new URL(req.url)
    const batchId = searchParams.get('batch_id')
    const page = parseInt(searchParams.get('page') ?? '1', 10)
    const PAGE_SIZE = 100

    // Si viene batch_id → devolver registros paginados del lote
    if (batchId) {
      const from = (page - 1) * PAGE_SIZE
      const to = from + PAGE_SIZE - 1

      const { data, error, count } = await service
        .from('base_tn')
        .select('id, cod_cliente, nombre_cliente, cuit_dni, telefono_1, telefono_2', { count: 'exact' })
        .eq('batch_id', batchId)
        .order('nombre_cliente', { ascending: true })
        .range(from, to)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ data, total: count ?? 0, page, page_size: PAGE_SIZE })
    }

    // Sin batch_id → devolver historial agrupado por lote usando RPC
    // (GROUP BY en la BD evita traer miles de filas individuales)
    const { data, error } = await service.rpc('get_base_tn_batches')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data: data ?? [] })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// ── POST: importar Excel ──────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden importar' }, { status: 403 })
    }

    const formData = await req.formData()
    const file    = formData.get('file')    as File   | null
    const periodo = (formData.get('periodo') as string | null)?.trim()
    const sucursal = (formData.get('sucursal') as string | null)?.trim()
    const source  = (formData.get('source')  as string | null)?.trim() ?? 'naranja'

    if (!file)     return NextResponse.json({ error: 'Archivo requerido' },          { status: 400 })
    if (!periodo)  return NextResponse.json({ error: 'El período es requerido' },    { status: 400 })
    if (!sucursal) return NextResponse.json({ error: 'La sucursal es requerida' },   { status: 400 })
    if (!['naranja', 'cancela_renueva'].includes(source)) {
      return NextResponse.json({ error: 'Fuente no válida' }, { status: 400 })
    }

    const buffer   = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheet    = workbook.Sheets[workbook.SheetNames[0]]

    const allRows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    })

    const batchId = randomUUID()
    type RowRecord = {
      batch_id: string; periodo: string; sucursal: string; source: string
      cod_cliente: string | null; nombre_cliente: string | null
      cuit_dni: string | null; telefono_1: string | null; telefono_2: string | null
      domicilio: string | null; cuotas_a_vencer: string | null
      imported_by: string
    }

    let records: RowRecord[]

    if (source === 'cancela_renueva') {
      // Fila 1 vacía (eliminada por blankrows:false), Fila 2 = "JVG", Fila 3 = headers
      // → datos desde índice 2 del array filtrado
      // Col A vacía → SheetJS arranca en col B (índice 0)
      // 0 = DNI | 1 = Nombre Completo | 2 = Domicilio | 3 = Cuotas a Vencer | 4 = Teléfono
      records = allRows
        .slice(2)
        .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
        .map(row => {
          const r = row as (string | number | null)[]
          return {
            batch_id: batchId, periodo, sucursal, source,
            cod_cliente:     null,
            cuit_dni:        String(r[0] ?? '').trim() || null,
            nombre_cliente:  String(r[1] ?? '').trim() || null,
            domicilio:       String(r[2] ?? '').trim() || null,
            cuotas_a_vencer: String(r[3] ?? '').trim() || null,
            telefono_1:      String(r[4] ?? '').trim() || null,
            telefono_2:      null,
            imported_by:     user.id,
          }
        })
        .filter(r => r.cuit_dni || r.nombre_cliente)
    } else {
      // Naranja: primeras 4 filas son encabezados
      // Col A vacía → SheetJS arranca en col B (índice 0)
      // 0 = COD.CLIENTE | 1 = NOMBRE | 2 = CUIT/DNI | 3 = TEL 1 | 4 = TEL 2
      records = allRows
        .slice(4)
        .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
        .map(row => {
          const r = row as (string | number | null)[]
          return {
            batch_id: batchId, periodo, sucursal, source: 'naranja',
            cod_cliente:    String(r[0] ?? '').trim() || null,
            nombre_cliente: String(r[1] ?? '').trim() || null,
            cuit_dni:       String(r[2] ?? '').trim() || null,
            telefono_1:     String(r[3] ?? '').trim() || null,
            telefono_2:     String(r[4] ?? '').trim() || null,
            domicilio:      null,
            cuotas_a_vencer: null,
            imported_by:    user.id,
          }
        })
        .filter(r => r.cod_cliente || r.nombre_cliente)
    }

    if (records.length === 0) {
      return NextResponse.json({ error: 'No se encontraron registros válidos en el archivo' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()

    // Insertar en lotes de 500 para no superar límites
    const BATCH_SIZE = 500
    let totalInserted = 0

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE)
      const { error } = await service.from('base_tn').insert(chunk)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      totalInserted += chunk.length
    }

    return NextResponse.json({ success: true, imported: totalInserted, batch_id: batchId })
  } catch (err) {
    console.error('Error importando base TN:', err)
    return NextResponse.json({ error: 'Error interno al procesar el archivo' }, { status: 500 })
  }
}

// ── DELETE: eliminar un lote completo ─────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const batchId = searchParams.get('batch_id')
    if (!batchId) return NextResponse.json({ error: 'batch_id requerido' }, { status: 400 })

    const service = createServiceSupabaseClient()
    const { error } = await service.from('base_tn').delete().eq('batch_id', batchId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
