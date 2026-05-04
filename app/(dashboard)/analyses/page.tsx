'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { STAGE_LABELS, STAGE_COLORS, getScoreColor } from '@/lib/utils'
import ScoreBadge from '@/components/ui/ScoreBadge'
import { Brain, ExternalLink, Filter, Loader2, RefreshCw, Smile, Meh, Frown, ChevronLeft, ChevronRight, Play } from 'lucide-react'
import { ConversationStage, SentimentType } from '@/types'

type AnalysisRow = {
  id: string
  quality_score: number
  conversation_stage: ConversationStage
  sentiment: SentimentType
  analyzed_at: string
  model_used: string | null
  conversation: { id: string; client_name: string | null; client_phone: string; display_name: string | null } | null
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
  const [batching,     setBatching]     = useState(false)
  const [batchResult,  setBatchResult]  = useState<{ analyzed: number; failed: number; message?: string } | null>(null)
  const [batchLimit,   setBatchLimit]   = useState(10)

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
    const res  = await fetch('/api/analyze/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: batchLimit }),
    })
    const data = await res.json()
    setBatchResult(data)
    setBatching(false)
    if (data.analyzed > 0) loadAnalyses(1)
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
          <div className="flex items-center gap-2 flex-wrap">
            {batchResult && (
              <span className={`text-xs font-medium px-2 py-1 rounded-md ${batchResult.analyzed > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {batchResult.message ?? `✓ ${batchResult.analyzed} analizados, ${batchResult.failed} fallidos`}
              </span>
            )}
            <select
              value={batchLimit}
              onChange={e => setBatchLimit(Number(e.target.value))}
              className="text-xs border border-border rounded-md px-2 py-1.5"
              disabled={batching}
            >
              {[5, 10, 15].map(n => <option key={n} value={n}>{n} conversaciones</option>)}
            </select>
            <button
              onClick={handleBatch}
              disabled={batching}
              className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-xs font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-50"
            >
              {batching
                ? <><Loader2 size={13} className="animate-spin" /> Analizando…</>
                : <><Play size={13} /> Analizar pendientes</>
              }
            </button>
            <button onClick={() => loadAnalyses(page)} className="text-muted hover:text-body p-1.5">
              <RefreshCw size={15} />
            </button>
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
                const clientName = a.conversation?.display_name ?? a.conversation?.client_name ?? a.conversation?.client_phone ?? '—'
                return (
                  <tr
                    key={a.id}
                    onClick={() => router.push(`/analysis/${a.id}`)}
                    className="hover:bg-bg cursor-pointer transition-colors"
                  >
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
                    <td className="px-4 py-3">
                      <ExternalLink size={14} className="text-muted hover:text-primary" />
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
