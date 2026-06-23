'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { STAGE_LABELS, STAGE_COLORS, getScoreColor } from '@/lib/utils'
import ScoreBadge from '@/components/ui/ScoreBadge'
import { Brain, ExternalLink, Filter, Loader2, RefreshCw, Smile, Meh, Frown, ChevronLeft, ChevronRight, Play, ChevronDown, AlertCircle, CheckCircle, Trash2, Check, X, CheckSquare, MessageSquare } from 'lucide-react'
import { ConversationStage, SentimentType } from '@/types'

type AnalysisRow = {
  id: string
  quality_score: number
  conversation_stage: ConversationStage
  sentiment: SentimentType
  analyzed_at: string
  model_used: string | null
  conversation: { id: string; client_name: string | null; client_phone: string; display_name: string | null; base_cliente: string | null } | null
  vendedor: { id: string; full_name: string } | null
}

type Vendor = { id: string; full_name: string }

const sentimentIcon: Record<SentimentType, React.ReactNode> = {
  positive: <Smile size={13} className="text-green-500" />,
  neutral:  <Meh  size={13} className="text-yellow-500" />,
  negative: <Frown size={13} className="text-red-500" />,
}
const sentimentLabel: Record<SentimentType, string> = {
  positive: 'Positivo', neutral: 'Neutral', negative: 'Negativo',
}

const PAGE_SIZE = 50

export default function AnalysesPage() {
  const router = useRouter()
  const supabase = createBrowserSupabaseClient()
  const [analyses, setAnalyses]   = useState<AnalysisRow[]>([])
  const [total, setTotal]         = useState(0)
  const [page, setPage]           = useState(1)
  const [loading, setLoading]     = useState(true)
  const [vendors, setVendors]     = useState<Vendor[]>([])
  const [userRole, setUserRole]   = useState('')

  // Filtros
  const [vendorId,  setVendorId]  = useState('')
  const [stage,     setStage]     = useState('')
  const [sentiment, setSentiment] = useState('')
  const [minScore,  setMinScore]  = useState(0)
  const [maxScore,  setMaxScore]  = useState(100)

  // Batch
  type BatchResultRow = {
    conversationId: string
    conversationName: string
    success: boolean
    analysisId?: string
    error?: string
    attempts: number
  }
  type BatchResult = {
    analyzed: number
    failed: number
    skipped?: number
    stoppedEarly?: boolean
    remaining?: number
    message?: string
    results?: BatchResultRow[]
  }
  const [batching,       setBatching]       = useState(false)
  const [batchResult,    setBatchResult]     = useState<BatchResult | null>(null)
  const [batchLimit,     setBatchLimit]      = useState<number | 'nocturno'>(10)
  const [showFailReport, setShowFailReport]  = useState(false)
  const [batchError,     setBatchError]      = useState<string | null>(null)

  // Modo selección para borrado manual
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds,   setSelectedIds]   = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [deleteError,   setDeleteError]   = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('users').select('role').eq('id', user.id).single()
        .then(({ data }) => { if (data) setUserRole(data.role) })
    })
    fetch('/api/vendors').then(r => r.json()).then(d => setVendors(d.data ?? []))
  }, [supabase])

  const loadAnalyses = useCallback(async (p = 1) => {
    setLoading(true)
    const params = new URLSearchParams({
      page: String(p), limit: String(PAGE_SIZE),
      minScore: String(minScore), maxScore: String(maxScore),
    })
    if (vendorId)  params.set('vendorId', vendorId)
    if (stage)     params.set('stage', stage)
    if (sentiment) params.set('sentiment', sentiment)

    const res  = await fetch(`/api/analyses?${params}`)
    const data = await res.json()
    setAnalyses(data.data ?? [])
    setTotal(data.count ?? 0)
    setPage(p)
    setLoading(false)
  }, [vendorId, stage, sentiment, minScore, maxScore])

  useEffect(() => { loadAnalyses(1) }, [loadAnalyses])

  const handleBatch = async () => {
    setBatching(true)
    setBatchResult(null)
    setBatchError(null)
    setShowFailReport(false)

    // El endpoint corta a los 300s (maxDuration de Vercel) — si la conexión no
    // responde ni un poco más allá de eso, algo se rompió en el camino (function
    // matada sin devolver respuesta, red caída, etc). Sin este timeout el botón
    // quedaba "Analizando..." para siempre si el fetch nunca resolvía.
    const controller = new AbortController()
    const timeoutId   = setTimeout(() => controller.abort(), 310_000)

    try {
      const res = await fetch('/api/analyze/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          batchLimit === 'nocturno' ? { mode: 'nocturno' } : { limit: batchLimit }
        ),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`El servidor respondió con error (${res.status})`)
      }
      const data = await res.json()
      setBatchResult(data)
      if (data.analyzed > 0) loadAnalyses(1)
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      setBatchError(
        aborted
          ? 'Se agotó el tiempo de espera. El análisis puede haber quedado a mitad de camino en el servidor — revisá la lista antes de reintentar.'
          : `No se pudo completar el análisis: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      clearTimeout(timeoutId)
      setBatching(false)
    }
  }

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else              next.add(id)
      return next
    })
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmDelete(false)
    setDeleteError(null)
  }

  const handleDeleteSelected = async () => {
    if (!selectedIds.size) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch('/api/analyses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDeleteError(data.error ?? `HTTP ${res.status}`)
        return
      }
      exitSelectionMode()
      await loadAnalyses(page)
    } finally {
      setDeleting(false)
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-body flex items-center gap-2">
            <Brain size={20} className="text-primary" /> Análisis IA
          </h1>
          <p className="text-sm text-muted mt-0.5">
            {total > 0 ? `${total} análisis registrados` : 'Sin resultados'}
          </p>
        </div>

        {/* Batch trigger — solo admin/supervisor */}
        {['admin', 'supervisor'].includes(userRole) && (
          <div className="flex flex-col items-end gap-2 min-w-0">
            {/* Controles */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <select
                value={batchLimit}
                onChange={e => setBatchLimit(e.target.value === 'nocturno' ? 'nocturno' : Number(e.target.value))}
                className="text-xs border border-border rounded-md px-2 py-1.5"
                disabled={batching}
              >
                {[5, 10, 15, 30].map(n => <option key={n} value={n}>{n} conversaciones</option>)}
                <option value="nocturno">Nocturno (todo el backlog)</option>
              </select>
              <button
                onClick={handleBatch}
                disabled={batching}
                title={batchLimit === 'nocturno' ? 'Procesa todas las conversaciones pendientes, priorizando las más antiguas — igual que el análisis automático nocturno' : undefined}
                className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-xs font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-50"
              >
                {batching
                  ? <><Loader2 size={13} className="animate-spin" /> Analizando…</>
                  : <><Play size={13} /> {batchLimit === 'nocturno' ? 'Analizar nocturno' : 'Analizar pendientes'}</>
                }
              </button>
              <button onClick={() => loadAnalyses(page)} className="text-muted hover:text-body p-1.5">
                <RefreshCw size={15} />
              </button>
              {!selectionMode ? (
                <button
                  onClick={() => setSelectionMode(true)}
                  disabled={batching || !analyses.length}
                  className="flex items-center gap-1.5 border border-border text-body hover:bg-bg text-xs font-medium px-2.5 py-2 rounded-md transition-colors disabled:opacity-50"
                  title="Seleccionar análisis para borrar"
                >
                  <CheckSquare size={13} /> Seleccionar
                </button>
              ) : (
                <button
                  onClick={exitSelectionMode}
                  disabled={deleting}
                  className="flex items-center gap-1.5 border border-border text-muted hover:bg-bg text-xs font-medium px-2.5 py-2 rounded-md transition-colors disabled:opacity-50"
                >
                  <X size={13} /> Cancelar
                </button>
              )}
            </div>

            {/* Barra de acción en modo selección */}
            {selectionMode && (
              <div className="w-full flex items-center justify-end gap-2 flex-wrap">
                <span className="text-xs text-muted">
                  {selectedIds.size} seleccionado{selectedIds.size === 1 ? '' : 's'}
                </span>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    disabled={!selectedIds.size || deleting}
                    className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={13} /> Borrar seleccionados
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-red-700 font-medium">¿Confirmar borrado?</span>
                    <button
                      onClick={handleDeleteSelected}
                      disabled={deleting}
                      className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-50"
                    >
                      {deleting
                        ? <><Loader2 size={13} className="animate-spin" /> Borrando…</>
                        : <><Check size={13} /> Sí, borrar {selectedIds.size}</>
                      }
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="text-xs text-muted hover:text-body px-2 py-1.5"
                    >
                      No
                    </button>
                  </>
                )}
              </div>
            )}
            {deleteError && (
              <div className="w-full max-w-lg flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="wrap-break-word text-xs">{deleteError}</span>
              </div>
            )}
            {batchError && (
              <div className="w-full max-w-lg flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="wrap-break-word text-xs">{batchError}</span>
              </div>
            )}

            {/* Reporte de resultado */}
            {batchResult && !batchResult.message && (
              <div className="w-full max-w-lg space-y-2">
                {/* Resumen */}
                <div className="flex items-center gap-3 text-xs flex-wrap">
                  <span className="flex items-center gap-1 text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1 font-medium">
                    <CheckCircle size={12} /> {batchResult.analyzed} analizados
                  </span>
                  {batchResult.failed > 0 && (
                    <button
                      onClick={() => setShowFailReport(v => !v)}
                      className="flex items-center gap-1 text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1 font-medium hover:bg-red-100 transition-colors"
                    >
                      <AlertCircle size={12} /> {batchResult.failed} fallidos
                      <ChevronDown size={11} className={`transition-transform ${showFailReport ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                  {batchResult.skipped != null && batchResult.skipped > 0 && (
                    <span className="text-gray-400">· {batchResult.skipped} omitidos</span>
                  )}
                </div>

                {/* Aviso de corte por tiempo en modo nocturno */}
                {batchResult.stoppedEarly && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                    Se alcanzó el límite de tiempo de la función con {batchResult.remaining} conversación{batchResult.remaining === 1 ? '' : 'es'} todavía pendiente{batchResult.remaining === 1 ? '' : 's'}.
                    Apretá &quot;Analizar nocturno&quot; de nuevo para seguir con el resto del backlog.
                  </p>
                )}

                {/* Detalle de fallidos */}
                {showFailReport && batchResult.failed > 0 && (
                  <div className="border border-red-200 rounded-lg overflow-hidden bg-white">
                    <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs font-semibold text-red-700">
                      Detalle de análisis fallidos
                    </div>
                    <div className="divide-y divide-red-100 max-h-64 overflow-y-auto">
                      {batchResult.results?.filter(r => !r.success).map((r, i) => (
                        <div key={i} className="px-3 py-2.5 space-y-0.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-medium text-body truncate max-w-[200px]">
                              {r.conversationName}
                            </p>
                            <span className="text-[10px] text-gray-400 shrink-0">
                              {r.attempts} intento{r.attempts !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <p className="text-[11px] text-red-600 leading-snug">{r.error}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sin pendientes */}
            {batchResult?.message && (
              <span className="text-xs text-gray-500 bg-gray-50 border border-border rounded-md px-2 py-1">
                {batchResult.message}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-1.5 mb-3 text-xs font-semibold text-muted">
          <Filter size={12} /> Filtros
        </div>
        <div className="flex flex-wrap gap-3">
          {['admin', 'supervisor'].includes(userRole) && (
            <select value={vendorId} onChange={e => setVendorId(e.target.value)} className="text-xs border border-border rounded-md px-2 py-1.5 min-w-[160px]">
              <option value="">Todos los vendedores</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.full_name}</option>)}
            </select>
          )}
          <select value={stage} onChange={e => setStage(e.target.value)} className="text-xs border border-border rounded-md px-2 py-1.5">
            <option value="">Todas las etapas</option>
            {Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select value={sentiment} onChange={e => setSentiment(e.target.value)} className="text-xs border border-border rounded-md px-2 py-1.5">
            <option value="">Todos los sentimientos</option>
            <option value="positive">Positivo</option>
            <option value="neutral">Neutral</option>
            <option value="negative">Negativo</option>
          </select>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted whitespace-nowrap">Score</span>
            <input type="number" min={0} max={100} value={minScore} onChange={e => setMinScore(Number(e.target.value))}
              className="w-14 border border-border rounded-md px-2 py-1.5 text-center" />
            <span className="text-muted">–</span>
            <input type="number" min={0} max={100} value={maxScore} onChange={e => setMaxScore(Number(e.target.value))}
              className="w-14 border border-border rounded-md px-2 py-1.5 text-center" />
          </div>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-muted py-16 text-sm">
            <Loader2 size={18} className="animate-spin" /> Cargando análisis…
          </div>
        ) : analyses.length === 0 ? (
          <div className="py-16 text-center text-muted text-sm">Sin análisis con los filtros actuales</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg border-b border-border">
              <tr>
                {selectionMode && (
                  <th className="px-3 py-2.5 w-8">
                    <button
                      onClick={() => {
                        if (selectedIds.size === analyses.length) setSelectedIds(new Set())
                        else                                       setSelectedIds(new Set(analyses.map(a => a.id)))
                      }}
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                        selectedIds.size === analyses.length && analyses.length > 0
                          ? 'bg-primary border-primary'
                          : 'border-gray-300 bg-white hover:border-gray-400'
                      }`}
                      title={selectedIds.size === analyses.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                    >
                      {selectedIds.size === analyses.length && analyses.length > 0 && <Check size={10} className="text-white" />}
                    </button>
                  </th>
                )}
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Fecha</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Cliente</th>
                {['admin', 'supervisor'].includes(userRole) && (
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Vendedor</th>
                )}
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Score</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Etapa</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Sentimiento</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted">Modelo</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {analyses.map(a => {
                const clientName = a.conversation?.base_cliente ?? a.conversation?.display_name ?? a.conversation?.client_name ?? a.conversation?.client_phone ?? '—'
                const checked = selectedIds.has(a.id)
                return (
                  <tr
                    key={a.id}
                    onClick={() => {
                      if (selectionMode) toggleSelected(a.id)
                      else               router.push(`/analysis/${a.id}`)
                    }}
                    className={`cursor-pointer transition-colors ${checked ? 'bg-primary/5' : 'hover:bg-bg'}`}
                  >
                    {selectionMode && (
                      <td className="px-3 py-3 w-8" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => toggleSelected(a.id)}
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                            checked ? 'bg-primary border-primary' : 'border-gray-300 bg-white hover:border-gray-400'
                          }`}
                        >
                          {checked && <Check size={10} className="text-white" />}
                        </button>
                      </td>
                    )}
                    <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                      {new Date(a.analyzed_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-body truncate max-w-[180px] block">{clientName}</span>
                      <span className="text-[11px] text-muted">{a.conversation?.client_phone}</span>
                    </td>
                    {['admin', 'supervisor'].includes(userRole) && (
                      <td className="px-4 py-3 text-xs text-muted">{a.vendedor?.full_name ?? '—'}</td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ScoreBadge score={a.quality_score} size="sm" />
                        <span className="text-xs font-semibold" style={{ color: getScoreColor(a.quality_score) }}>
                          {a.quality_score}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${STAGE_COLORS[a.conversation_stage]}`}>
                        {STAGE_LABELS[a.conversation_stage]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-xs">
                        {sentimentIcon[a.sentiment]}
                        {sentimentLabel[a.sentiment]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted font-mono truncate max-w-[120px]">
                      {a.model_used ?? '—'}
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        {a.conversation?.id && (
                          <button
                            onClick={() => router.push(`/conversations?id=${a.conversation!.id}`)}
                            className="text-muted hover:text-primary p-1 rounded transition-colors"
                            title="Ir a la conversación"
                          >
                            <MessageSquare size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => router.push(`/analysis/${a.id}`)}
                          className="text-muted hover:text-primary p-1 rounded transition-colors"
                          title="Ver detalle del análisis"
                        >
                          <ExternalLink size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Paginación */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Página {page} de {totalPages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => loadAnalyses(page - 1)}
              disabled={page <= 1 || loading}
              className="p-1.5 rounded hover:bg-bg disabled:opacity-40"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              onClick={() => loadAnalyses(page + 1)}
              disabled={page >= totalPages || loading}
              className="p-1.5 rounded hover:bg-bg disabled:opacity-40"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
