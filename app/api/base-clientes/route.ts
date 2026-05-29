import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import * as XLSX from 'xlsx'
import { randomUUID } from 'crypto'

// ── GET: historial de lotes O registros de un lote ───────────────────────────
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

    if (batchId) {
      const from = (page - 1) * PAGE_SIZE
      const to = from + PAGE_SIZE - 1
      const { data, error, count } = await service
        .from('base_clientes')
        .select('id, localidad, cliente, cuit_dni, telefono_1, telefono_2, tarjeta, observacion', { count: 'exact' })
        .eq('batch_id', batchId)
        .order('cliente', { ascending: true })
        .range(from, to)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ data, total: count ?? 0, page, page_size: PAGE_SIZE })
    }

    const { data, error } = await service.rpc('get_base_clientes_batches')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: data ?? [] })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// Normaliza una celda del CSV (string, number, null) a string limpio
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    // xlsx a veces convierte teléfonos largos a notación científica (3,81155E+11)
    // Number.toString() de un número grande devuelve "3.81155e+11" → inservible.
    // Si el número es entero, lo convertimos directo. Si vino como científico ya, lo dejamos.
    if (Number.isInteger(value)) return String(value)
    return String(value)
  }
  return String(value).trim()
}

// ── POST: importar CSV ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden importar' }, { status: 403 })
    }

    const formData  = await req.formData()
    const file      = formData.get('file') as File | null
    const batchName = (formData.get('batch_name') as string | null)?.trim()

    if (!file)      return NextResponse.json({ error: 'Archivo requerido' }, { status: 400 })
    if (!batchName) return NextResponse.json({ error: 'El nombre del lote es requerido' }, { status: 400 })

    // xlsx lee tanto Excel como CSV (auto-detecta separador ; o ,)
    const buffer   = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellNF: false })
    const sheet    = workbook.Sheets[workbook.SheetNames[0]]

    // Leer como array de arrays para tolerar headers en español con caracteres especiales
    const allRows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false,   // forzar valores como strings cuando sea posible
    })

    if (allRows.length < 2) {
      return NextResponse.json({ error: 'El archivo no contiene datos' }, { status: 400 })
    }

    // Detectar columnas por header. El header está en la primera fila no vacía.
    const headerRow = (allRows[0] as unknown[]).map(c => cellToString(c).toLowerCase())
    const findCol = (...keywords: string[]): number => {
      return headerRow.findIndex(h => keywords.some(k => h.includes(k)))
    }
    const colLocalidad   = findCol('localidad')
    const colCliente     = findCol('cliente', 'nombre')
    const colCuitDni     = findCol('cuit', 'dni')
    const colTelefono1   = findCol('telefono 1', 'tel 1', 'tel1', 'teléfono 1')
    const colTelefono2   = findCol('telefono 2', 'tel 2', 'tel2', 'teléfono 2')
    const colTarjeta     = findCol('tarjeta')
    const colObservacion = findCol('observacion', 'observación', 'obs')

    if (colCliente === -1) {
      return NextResponse.json(
        { error: 'No se encontró la columna CLIENTE en el archivo. Headers detectados: ' + headerRow.join(' | ') },
        { status: 400 },
      )
    }

    const batchId = randomUUID()
    type RowRecord = {
      batch_id:    string
      batch_name:  string
      localidad:   string | null
      cliente:     string | null
      cuit_dni:    string | null
      telefono_1:  string | null
      telefono_2:  string | null
      tarjeta:     string | null
      observacion: string | null
      imported_by: string
    }

    const records: RowRecord[] = allRows
      .slice(1)
      .filter(row => Array.isArray(row) && row.some(cell => cellToString(cell) !== ''))
      .map(row => {
        const r = row as unknown[]
        const get = (idx: number) => idx >= 0 ? cellToString(r[idx]) : ''
        return {
          batch_id:    batchId,
          batch_name:  batchName,
          localidad:   get(colLocalidad)   || null,
          cliente:     get(colCliente)     || null,
          cuit_dni:    get(colCuitDni)     || null,
          telefono_1:  get(colTelefono1)   || null,
          telefono_2:  get(colTelefono2)   || null,
          tarjeta:     get(colTarjeta)     || null,
          observacion: get(colObservacion) || null,
          imported_by: user.id,
        }
      })
      .filter(r => r.cliente)   // descartar filas sin nombre de cliente

    if (records.length === 0) {
      return NextResponse.json({ error: 'No se encontraron registros válidos en el archivo' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    const BATCH_SIZE = 500
    let totalInserted = 0

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE)
      const { error } = await service.from('base_clientes').insert(chunk)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      totalInserted += chunk.length
    }

    return NextResponse.json({ success: true, imported: totalInserted, batch_id: batchId })
  } catch (err) {
    console.error('Error importando base_clientes:', err)
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
      .from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const batchId = searchParams.get('batch_id')
    if (!batchId) return NextResponse.json({ error: 'batch_id requerido' }, { status: 400 })

    const service = createServiceSupabaseClient()
    const { error } = await service.from('base_clientes').delete().eq('batch_id', batchId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
