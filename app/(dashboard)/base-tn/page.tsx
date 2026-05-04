'use client'

import { useEffect, useRef, useState } from 'react'
import { Upload, FileSpreadsheet, Trash2, CheckCircle, AlertCircle, X, Loader2, Eye, ChevronLeft, ChevronRight } from 'lucide-react'

type Source = 'naranja' | 'cancela_renueva'

type Batch = {
  batch_id: string
  periodo: string
  sucursal: string
  source: string
  created_at: string
  count: number
}

type ImportResult = {
  imported: number
  batch_id: string
}

type BatchRecord = {
  id: string
  cod_cliente: string | null
  nombre_cliente: string | null
  cuit_dni: string | null
  telefono_1: string | null
  telefono_2: string | null
  domicilio: string | null
  cuotas_a_vencer: string | null
}

const SOURCE_LABELS: Record<Source, string> = {
  naranja: 'Base Tarjeta Naranja',
  cancela_renueva: 'Base Cancela y Renueva',
}

// ── Modal de registros ────────────────────────────────────────────────────────
function RecordsModal({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const [records, setRecords] = useState<BatchRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const PAGE_SIZE = 100
  const isCancela = batch.source === 'cancela_renueva'

  useEffect(() => { loadPage(1) }, [batch.batch_id])

  const loadPage = async (p: number) => {
    setLoading(true)
    const res = await fetch(`/api/base-tn?batch_id=${batch.batch_id}&page=${p}`)
    const data = await res.json()
    setRecords((data.data ?? []) as BatchRecord[])
    setTotal(data.total ?? 0)
    setPage(p)
    setLoading(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const filtered = search.trim()
    ? records.filter(r =>
        [r.cod_cliente, r.nombre_cliente, r.cuit_dni, r.telefono_1, r.telefono_2, r.domicilio, r.cuotas_a_vencer]
          .some(v => v?.toLowerCase().includes(search.toLowerCase()))
      )
    : records

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-lg font-bold text-body">Registros del lote</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {batch.periodo} · {batch.sucursal} ·{' '}
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
            placeholder="Buscar por nombre, DNI, teléfono..."
            className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {search && (
            <p className="text-xs text-gray-400 mt-1">
              {filtered.length} resultado{filtered.length !== 1 ? 's' : ''} en esta página
            </p>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-16">
              <Loader2 size={16} className="animate-spin" /> Cargando registros...
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">Sin resultados</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg border-b border-border">
                <tr>
                  {isCancela ? (
                    <>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">DNI</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Nombre</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Domicilio</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Cuotas</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Teléfono</th>
                    </>
                  ) : (
                    <>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Cód. Cliente</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Nombre</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">CUIT / DNI</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Teléfono 1</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Teléfono 2</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(r => (
                  <tr key={r.id} className="hover:bg-bg transition-colors">
                    {isCancela ? (
                      <>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.cuit_dni ?? '—'}</td>
                        <td className="px-4 py-2.5 font-medium text-body">{r.nombre_cliente ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{r.domicilio ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500">{r.cuotas_a_vencer ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500">{r.telefono_1 ?? '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.cod_cliente ?? '—'}</td>
                        <td className="px-4 py-2.5 font-medium text-body">{r.nombre_cliente ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500">{r.cuit_dni ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500">{r.telefono_1 ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500">{r.telefono_2 ?? '—'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && !search && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
            <p className="text-xs text-gray-400">
              Página {page} de {totalPages} · mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total.toLocaleString('es-AR')}
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => loadPage(page - 1)} disabled={page === 1 || loading}
                className="p-1.5 rounded border border-border text-gray-500 hover:bg-bg disabled:opacity-40 transition-colors">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => loadPage(page + 1)} disabled={page === totalPages || loading}
                className="p-1.5 rounded border border-border text-gray-500 hover:bg-bg disabled:opacity-40 transition-colors">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function BaseTNPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [activeTab, setActiveTab] = useState<Source>('naranja')

  const [periodo, setPeriodo] = useState('')
  const [sucursal, setSucursal] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [batches, setBatches] = useState<Batch[]>([])
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [deletingBatch, setDeletingBatch] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [viewingBatch, setViewingBatch] = useState<Batch | null>(null)

  useEffect(() => { loadBatches() }, [])

  // Limpiar formulario al cambiar de pestaña
  useEffect(() => {
    setFile(null)
    setPeriodo('')
    setSucursal('')
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [activeTab])

  const loadBatches = async () => {
    setLoadingBatches(true)
    const res = await fetch('/api/base-tn')
    const data = await res.json()
    setBatches(data.data ?? [])
    setLoadingBatches(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) setFile(dropped)
  }

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !periodo || !sucursal) return

    setImporting(true)
    setError(null)
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('periodo', periodo)
    formData.append('sucursal', sucursal)
    formData.append('source', activeTab)

    const res = await fetch('/api/base-tn', { method: 'POST', body: formData })
    const data = await res.json()
    setImporting(false)

    if (!res.ok) {
      setError(data.error ?? 'Error al importar')
    } else {
      setResult({ imported: data.imported, batch_id: data.batch_id })
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadBatches()
    }
  }

  const handleDelete = async (batchId: string) => {
    setDeletingBatch(batchId)
    await fetch(`/api/base-tn?batch_id=${batchId}`, { method: 'DELETE' })
    setDeletingBatch(null)
    setConfirmDelete(null)
    await loadBatches()
  }

  const filteredBatches = batches.filter(b =>
    (b.source ?? 'naranja') === activeTab
  )

  const tabs: { id: Source; label: string; color: string }[] = [
    { id: 'naranja',          label: 'Base Tarjeta Naranja',   color: 'text-orange-600' },
    { id: 'cancela_renueva',  label: 'Base Cancela y Renueva', color: 'text-blue-600'   },
  ]

  return (
    <>
      {viewingBatch && (
        <RecordsModal batch={viewingBatch} onClose={() => setViewingBatch(null)} />
      )}

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-body">Importar Bases de Clientes</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Gestioná los padrones de Tarjeta Naranja y Base Cancela y Renueva.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border gap-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? `border-primary ${tab.color}`
                  : 'border-transparent text-gray-500 hover:text-body'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Formulario de importación */}
        <div className="bg-surface rounded-lg border border-border shadow-sm p-6">
          <h2 className="font-semibold text-body mb-5 flex items-center gap-2">
            <FileSpreadsheet size={18} className="text-primary" />
            Nueva importación — {SOURCE_LABELS[activeTab]}
          </h2>

          <form onSubmit={handleImport} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-body mb-1">
                  Período <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={periodo}
                  onChange={e => setPeriodo(e.target.value)}
                  placeholder="Ej: Enero 2025"
                  required
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-body mb-1">
                  Sucursal <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={sucursal}
                  onChange={e => setSucursal(e.target.value)}
                  placeholder="Ej: Centro"
                  required
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>

            {activeTab === 'cancela_renueva' && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-700">
                Campos que se importan: <strong>DNI · Nombre Completo · Domicilio · Cuotas a Vencer · Teléfono</strong>.
                La primera fila de datos debe estar en la fila 4 del Excel.
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-body mb-1">
                Archivo Excel <span className="text-red-500">*</span>
              </label>
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  dragging ? 'border-primary bg-primary/5'
                  : file   ? 'border-green-400 bg-green-50'
                           : 'border-border hover:border-primary hover:bg-primary/5'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={e => setFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileSpreadsheet size={28} className="text-green-600" />
                    <div className="text-left">
                      <p className="text-sm font-semibold text-body">{file.name}</p>
                      <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                      className="ml-2 text-gray-400 hover:text-red-500"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <div>
                    <Upload size={32} className="mx-auto text-gray-300 mb-2" />
                    <p className="text-sm text-body font-medium">Arrastrá el archivo acá o hacé click para seleccionar</p>
                    <p className="text-xs text-gray-400 mt-1">Formatos aceptados: .xlsx, .xls</p>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-4 py-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}
            {result && (
              <div className="flex items-start gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-4 py-3">
                <CheckCircle size={16} className="mt-0.5 shrink-0" />
                <span>
                  Importación exitosa — <strong>{result.imported.toLocaleString('es-AR')}</strong> registros cargados.
                </span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={importing || !file || !periodo || !sucursal}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-dark text-white text-sm font-semibold rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? (
                  <><Loader2 size={15} className="animate-spin" /> Importando...</>
                ) : (
                  <><Upload size={15} /> Importar</>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Historial */}
        <div className="bg-surface rounded-lg border border-border shadow-sm p-6">
          <h2 className="font-semibold text-body mb-4">
            Historial — {SOURCE_LABELS[activeTab]}
          </h2>

          {loadingBatches ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
              <Loader2 size={14} className="animate-spin" /> Cargando...
            </div>
          ) : filteredBatches.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No hay importaciones registradas aún</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg border-b border-border text-left">
                    <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Período</th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Sucursal</th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Registros</th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Fecha</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBatches.map(batch => (
                    <tr key={batch.batch_id} className="hover:bg-bg transition-colors">
                      <td className="px-4 py-3 font-medium text-body">{batch.periodo}</td>
                      <td className="px-4 py-3 text-gray-500">{batch.sucursal}</td>
                      <td className="px-4 py-3">
                        <span className="bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5 rounded-full">
                          {batch.count.toLocaleString('es-AR')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {new Date(batch.created_at).toLocaleDateString('es-AR', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => setViewingBatch(batch)}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark font-medium transition-colors"
                          >
                            <Eye size={13} /> Ver
                          </button>

                          {confirmDelete === batch.batch_id ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-red-500">¿Eliminar?</span>
                              <button
                                onClick={() => handleDelete(batch.batch_id)}
                                disabled={deletingBatch === batch.batch_id}
                                className="text-xs text-red-600 font-semibold hover:text-red-700 disabled:opacity-50"
                              >
                                {deletingBatch === batch.batch_id ? <Loader2 size={12} className="animate-spin" /> : 'Sí'}
                              </button>
                              <button onClick={() => setConfirmDelete(null)} className="text-xs text-gray-400 hover:text-gray-600">
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDelete(batch.batch_id)}
                              className="text-gray-400 hover:text-red-500 transition-colors"
                              title="Eliminar importación"
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
            </div>
          )}
        </div>
      </div>
    </>
  )
}
