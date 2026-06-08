'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, FileSpreadsheet, Trash2, CheckCircle, AlertCircle, X, Loader2, Eye, ChevronLeft, ChevronRight, MessageSquare, Download } from 'lucide-react'

type Batch = {
  batch_id:   string
  batch_name: string
  created_at: string
  count:      number
}

type ImportResult = {
  imported: number
  batch_id: string
}

type BatchRecord = {
  id:          string
  localidad:   string | null
  cliente:     string | null
  cuit_dni:    string | null
  telefono_1:  string | null
  telefono_2:  string | null
  tarjeta:     string | null
  observacion: string | null
}

// ── Modal de registros ────────────────────────────────────────────────────────
function RecordsModal({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const [records, setRecords] = useState<BatchRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const PAGE_SIZE = 100

  useEffect(() => { loadPage(1) }, [batch.batch_id])  // eslint-disable-line react-hooks/exhaustive-deps

  const loadPage = async (p: number) => {
    setLoading(true)
    const res = await fetch(`/api/base-clientes?batch_id=${batch.batch_id}&page=${p}`)
    const data = await res.json()
    setRecords((data.data ?? []) as BatchRecord[])
    setTotal(data.total ?? 0)
    setPage(p)
    setLoading(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const filtered = search.trim()
    ? records.filter(r =>
        [r.localidad, r.cliente, r.cuit_dni, r.telefono_1, r.telefono_2, r.tarjeta, r.observacion]
          .some(v => v?.toLowerCase().includes(search.toLowerCase())),
      )
    : records

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-lg font-bold text-body">{batch.batch_name}</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-primary">{total.toLocaleString('es-AR')} registros</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-body mt-0.5">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-border shrink-0">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre, DNI, teléfono, localidad..."
            className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-muted py-16 text-sm">
              <Loader2 size={18} className="animate-spin" /> Cargando registros…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-muted text-sm">Sin registros</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-bg border-b border-border sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Localidad</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Cliente</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">CUIT/DNI</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Teléfono 1</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Teléfono 2</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Tarjeta</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted">Observación</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(r => (
                  <tr key={r.id} className="hover:bg-bg">
                    <td className="px-4 py-2 text-xs">{r.localidad ?? '—'}</td>
                    <td className="px-4 py-2 text-xs font-medium text-body">{r.cliente ?? '—'}</td>
                    <td className="px-4 py-2 text-xs font-mono">{r.cuit_dni ?? '—'}</td>
                    <td className="px-4 py-2 text-xs font-mono">{r.telefono_1 ?? '—'}</td>
                    <td className="px-4 py-2 text-xs font-mono">{r.telefono_2 ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">{r.tarjeta ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-muted">{r.observacion ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0 text-xs text-muted">
            <span>Página {page} de {totalPages}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => loadPage(page - 1)} disabled={page <= 1}
                      className="p-1 disabled:opacity-30 hover:text-body">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => loadPage(page + 1)} disabled={page >= totalPages}
                      className="p-1 disabled:opacity-30 hover:text-body">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type MatchItem = {
  conversation_id: string
  instance:        string | null
  vendedor:        string | null
  status:          string | null
  phone:           string
  whatsapp_name:   string | null
  cliente:         string | null
  cuit_dni:        string | null
  localidad:       string | null
  tarjetas:        string[]
  observacion:     string | null
  telefono_1:      string | null
  telefono_2:      string | null
}

type MatchResult = {
  matched: number
  items:   MatchItem[]
}

export default function BaseClientesPage() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [batchName, setBatchName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Batch | null>(null)

  const [matching, setMatching] = useState(false)
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [matchSearch, setMatchSearch] = useState('')
  const [exportingExcel, setExportingExcel] = useState(false)

  useEffect(() => { loadBatches() }, [])

  const loadBatches = async () => {
    setLoadingBatches(true)
    const res = await fetch('/api/base-clientes')
    const data = await res.json()
    setBatches(data.data ?? [])
    setLoadingBatches(false)
  }

  const handleImport = async () => {
    if (!file)      { setError('Seleccioná un archivo'); return }
    if (!batchName.trim()) { setError('Ingresá un nombre para el lote'); return }

    setImporting(true)
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('batch_name', batchName.trim())

      const res = await fetch('/api/base-clientes', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Error al importar')
      } else {
        setResult({ imported: data.imported, batch_id: data.batch_id })
        setFile(null)
        setBatchName('')
        if (fileRef.current) fileRef.current.value = ''
        await loadBatches()
      }
    } finally {
      setImporting(false)
    }
  }

  const handleDelete = async (batchId: string) => {
    const res = await fetch(`/api/base-clientes?batch_id=${batchId}`, { method: 'DELETE' })
    if (res.ok) {
      setConfirmDelete(null)
      await loadBatches()
    }
  }

  const handleMatch = async () => {
    setMatching(true)
    setMatchResult(null)
    setMatchError(null)
    setMatchSearch('')
    try {
      const res = await fetch('/api/base-clientes/match-retroactive', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) setMatchError(data.error ?? 'Error en el match')
      else setMatchResult({ matched: data.matched, items: data.items ?? [] })
    } finally {
      setMatching(false)
    }
  }

  // Exporta el resultado del match a Excel. Dynamic import para no inflar el bundle
  // de la página hasta que se necesite.
  const handleExportExcel = async () => {
    if (!matchResult || matchResult.items.length === 0) return
    setExportingExcel(true)
    try {
      const XLSX = await import('xlsx')
      const rows = matchResult.items.map(item => ({
        'Instancia':         item.instance     ?? '',
        'Vendedor':          item.vendedor     ?? '',
        'Status':            item.status       ?? '',
        'Nombre cliente':    item.whatsapp_name ?? '',
        'Teléfono':          item.phone,
        'Localidad':         item.localidad    ?? '',
        'Cliente (CSV)':     item.cliente      ?? '',
        'CUIT/DNI':          item.cuit_dni     ?? '',
        'Teléfono 1':        item.telefono_1   ?? '',
        'Teléfono 2':        item.telefono_2   ?? '',
        'Tarjeta':           (item.tarjetas ?? []).join(', '),
        'Observación':       item.observacion  ?? '',
      }))
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Match')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `match-conversaciones-${stamp}.xlsx`)
    } finally {
      setExportingExcel(false)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-body flex items-center gap-2">
          <FileSpreadsheet size={22} className="text-primary" /> Base Clientes
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Importá la base de clientes desde un archivo CSV con las columnas:
          <span className="font-mono text-xs ml-1">LOCALIDAD, CLIENTE, CUIT/DNI, TELEFONO 1, TELEFONO 2, TARJETA, OBSERVACION</span>
        </p>
      </div>

      {/* Formulario de importación */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-body flex items-center gap-2">
          <Upload size={16} className="text-primary" /> Importar nuevo lote
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nombre del lote</label>
            <input
              type="text"
              value={batchName}
              onChange={e => setBatchName(e.target.value)}
              placeholder='Ej: "Mayo 2026 - Tucumán"'
              className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={importing}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Archivo CSV / Excel</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-primary file:text-white file:font-semibold file:cursor-pointer"
              disabled={importing}
            />
          </div>
        </div>

        <button
          onClick={handleImport}
          disabled={!file || !batchName.trim() || importing}
          className="flex items-center gap-2 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50"
        >
          {importing
            ? <><Loader2 size={14} className="animate-spin" /> Importando…</>
            : <><Upload size={14} /> Importar</>
          }
        </button>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span className="wrap-break-word">{error}</span>
          </div>
        )}

        {result && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">
            <CheckCircle size={16} />
            <span>Importados {result.imported.toLocaleString('es-AR')} registros correctamente</span>
          </div>
        )}
      </div>

      {/* Match retroactivo */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-3">
        <h3 className="font-semibold text-body">Vincular conversaciones con la base</h3>
        <p className="text-xs text-gray-500">
          Cruza los teléfonos de las conversaciones de WhatsApp con la base importada y guarda la localidad y tarjeta de cada cliente.
        </p>
        <button
          onClick={handleMatch}
          disabled={matching || batches.length === 0}
          className="flex items-center gap-2 bg-body hover:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-md disabled:opacity-50"
        >
          {matching
            ? <><Loader2 size={14} className="animate-spin" /> Procesando…</>
            : 'Ejecutar match'
          }
        </button>
        {matchResult && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2.5">
              <CheckCircle size={14} /> {matchResult.matched.toLocaleString('es-AR')} conversaciones vinculadas
            </div>

            {matchResult.matched > 0 && (
              <>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <input
                    type="text"
                    value={matchSearch}
                    onChange={e => setMatchSearch(e.target.value)}
                    placeholder="Filtrar por nombre, DNI, teléfono, tarjeta…"
                    className="flex-1 min-w-50 max-w-sm border border-border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-gray-500">
                      {matchResult.items.length} resultados
                    </span>
                    <button
                      onClick={handleExportExcel}
                      disabled={exportingExcel}
                      title="Descargar resultado del match en Excel"
                      className="flex items-center gap-1.5 text-xs bg-green-600 hover:bg-green-700 text-white font-medium px-3 py-1.5 rounded-md disabled:opacity-50"
                    >
                      {exportingExcel
                        ? <><Loader2 size={12} className="animate-spin" /> Generando…</>
                        : <><Download size={12} /> Descargar Excel</>
                      }
                    </button>
                  </div>
                </div>

                <div className="border border-border rounded-lg overflow-hidden max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-bg sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Cliente (CSV)</th>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">DNI/CUIT</th>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Teléfono</th>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Localidad</th>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Tarjetas</th>
                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Observación</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {matchResult.items
                        .filter(item => {
                          if (!matchSearch.trim()) return true
                          const q = matchSearch.toLowerCase()
                          return [item.cliente, item.cuit_dni, item.phone, item.localidad, item.observacion, ...(item.tarjetas ?? [])]
                            .some(v => v?.toLowerCase().includes(q))
                        })
                        .map((item, idx) => (
                          <tr key={idx} className="hover:bg-bg">
                            <td className="px-3 py-2 text-body font-medium truncate max-w-44">
                              {item.cliente ?? '—'}
                              {item.whatsapp_name && item.whatsapp_name !== item.cliente && (
                                <div className="text-[10px] text-gray-400 font-normal truncate">
                                  WhatsApp: {item.whatsapp_name}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-gray-600">{item.cuit_dni ?? '—'}</td>
                            <td className="px-3 py-2 font-mono text-gray-500">{item.phone}</td>
                            <td className="px-3 py-2">{item.localidad ?? '—'}</td>
                            <td className="px-3 py-2 text-gray-600 truncate max-w-32">
                              {item.tarjetas.join(', ') || '—'}
                            </td>
                            <td className="px-3 py-2 text-gray-500 italic truncate max-w-44">
                              {item.observacion ?? ''}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => router.push(`/conversations?id=${item.conversation_id}`)}
                                className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark font-medium whitespace-nowrap"
                                title="Ir a la conversación"
                              >
                                <MessageSquare size={12} /> Ver chat
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
        {matchError && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="wrap-break-word">{matchError}</span>
          </div>
        )}
      </div>

      {/* Listado de lotes */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="font-semibold text-body">Lotes importados</h3>
        </div>
        {loadingBatches ? (
          <div className="flex items-center justify-center gap-2 text-muted py-12 text-sm">
            <Loader2 size={18} className="animate-spin" /> Cargando…
          </div>
        ) : batches.length === 0 ? (
          <div className="py-12 text-center text-muted text-sm">Aún no hay lotes importados</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Lote</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Fecha</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Registros</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {batches.map(b => (
                <tr key={b.batch_id} className="hover:bg-bg">
                  <td className="px-4 py-3 font-medium text-body">{b.batch_name}</td>
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                    {new Date(b.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-xs text-body font-semibold">{b.count.toLocaleString('es-AR')}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setViewing(b)}
                        className="text-muted hover:text-primary p-1 rounded"
                        title="Ver registros"
                      >
                        <Eye size={14} />
                      </button>
                      {confirmDelete === b.batch_id ? (
                        <>
                          <button
                            onClick={() => handleDelete(b.batch_id)}
                            className="text-xs text-red-600 font-semibold hover:underline"
                          >
                            Confirmar
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-xs text-muted hover:text-body"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(b.batch_id)}
                          className="text-muted hover:text-red-600 p-1 rounded"
                          title="Borrar lote"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewing && <RecordsModal batch={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
