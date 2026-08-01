'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { Conversation, AIAnalysis, User, ConversationStage, VendorDailyAnalysis } from '@/types'
import VendorAvatar from '@/components/ui/VendorAvatar'
import ScoreBadge from '@/components/ui/ScoreBadge'
import { STAGE_LABELS, STAGE_COLORS, formatDistanceToNow } from '@/lib/utils'
import { ArrowLeft, Wifi, WifiOff, TrendingUp, Pencil, Trash2, X, Lock, RefreshCw } from 'lucide-react'

// `date` llega como string "YYYY-MM-DD" (columna DATE de Postgres). Formatearla
// con `new Date(iso)` la interpreta como medianoche UTC, que en un navegador en
// horario de Argentina (UTC-3) muestra el día anterior. Formateamos el string
// directamente, sin pasar por el parseo UTC de Date.
function formatDateAR(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

function ScoreLineChart({ data }: { data: { date: string; score: number }[] }) {
  if (data.length < 2) return null
  const W = 560
  const H = 180
  const PL = 32, PR = 12, PT = 10, PB = 28
  const iW = W - PL - PR
  const iH = H - PT - PB
  const xOf = (i: number) => PL + (i / (data.length - 1)) * iW
  const yOf = (v: number) => PT + iH - (v / 100) * iH
  const points = data.map((d, i) => `${xOf(i)},${yOf(d.score)}`).join(' ')
  const gridLines = [0, 25, 50, 75, 100]
  const labelStep = Math.ceil(data.length / 7)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }}>
      {gridLines.map(v => (
        <g key={v}>
          <line x1={PL} x2={W - PR} y1={yOf(v)} y2={yOf(v)} stroke="#f0f0f0" strokeWidth={1} />
          <text x={PL - 4} y={yOf(v)} textAnchor="end" fontSize={9} fill="#aaa" dominantBaseline="middle">{v}</text>
        </g>
      ))}
      {data.map((d, i) => (
        i % labelStep === 0 && (
          <text key={i} x={xOf(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="#aaa">{d.date}</text>
        )
      ))}
      <polyline points={points} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinejoin="round" />
      {data.map((d, i) => (
        <circle key={i} cx={xOf(i)} cy={yOf(d.score)} r={3} fill="var(--color-primary)" />
      ))}
    </svg>
  )
}

type ConvWithAnalysis = Conversation & {
  ai_analysis: AIAnalysis[]
}

const STAGES: ConversationStage[] = ['new', 'negotiation', 'proposal', 'closed_won', 'closed_lost']

// ── Modal de edición ──────────────────────────────────────────────────────────
function EditModal({
  vendor,
  onClose,
  onSaved,
}: {
  vendor: User
  onClose: () => void
  onSaved: (updated: User) => void
}) {
  const [fullName, setFullName] = useState(vendor.full_name)
  const [email, setEmail] = useState(vendor.email)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/vendors', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: vendor.id, full_name: fullName, email }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error al guardar')
      onSaved(json.data as User)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-body">Editar vendedor</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-body">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-body mb-1">Nombre completo</label>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              required
              className="w-full border border-border rounded-md px-3 py-2 text-sm text-body bg-bg focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-body mb-1">
              Email <span className="text-gray-400 font-normal text-xs">(opcional)</span>
            </label>
            <input
              type="text"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="vendedor@empresa.com"
              className="w-full border border-border rounded-md px-3 py-2 text-sm text-body bg-bg focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-border text-body hover:bg-bg transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm rounded-md bg-primary hover:bg-primary-dark text-white font-semibold transition-colors disabled:opacity-60"
            >
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Modal de confirmación de eliminación ──────────────────────────────────────
function DeleteModal({
  vendor,
  onClose,
  onDeleted,
}: {
  vendor: User
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/vendors?id=${vendor.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error al eliminar')
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado')
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-body">Eliminar vendedor</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-body">
            <X size={20} />
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-2">
          ¿Estás seguro que querés eliminar a{' '}
          <span className="font-semibold text-body">{vendor.full_name}</span>?
        </p>
        <p className="text-xs text-red-500 mb-5">
          Esta acción es irreversible. Se eliminarán el usuario y todos sus datos asociados.
        </p>

        {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-border text-body hover:bg-bg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 text-sm rounded-md bg-red-600 hover:bg-red-700 text-white font-semibold transition-colors disabled:opacity-60"
          >
            {deleting ? 'Eliminando...' : 'Sí, eliminar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function VendorProfilePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = createBrowserSupabaseClient()

  const [vendor, setVendor] = useState<User | null>(null)
  const [instance, setInstance] = useState<{ status: string; phone_number: string | null } | null>(null)
  const [conversations, setConversations] = useState<ConvWithAnalysis[]>([])
  const [kpis, setKpis] = useState<Array<{ date: string; avg_quality_score: number }>>([])
  const [loading, setLoading] = useState(true)
  const [movingConv, setMovingConv] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [canSeeGlobalAnalysis, setCanSeeGlobalAnalysis] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [globalHistory, setGlobalHistory] = useState<VendorDailyAnalysis[]>([])
  const [loadingGlobalHistory, setLoadingGlobalHistory] = useState(false)
  const [generatingGlobal, setGeneratingGlobal] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)

  useEffect(() => {
    loadVendorData()
  }, [id])

  useEffect(() => {
    if (canSeeGlobalAnalysis) loadGlobalHistory()
  }, [canSeeGlobalAnalysis, id])

  const checkRole = async (vendorSupervisorId: string | null) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
    const admin = data?.role === 'admin'
    setIsAdmin(admin)
    setCanSeeGlobalAnalysis(admin || (data?.role === 'supervisor' && vendorSupervisorId === user.id))
  }

  const loadVendorData = async () => {
    setLoading(true)
    const [vendorRes, convsRes, kpisRes, instanceRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', id).single(),
      supabase.from('conversations')
        .select('*, ai_analysis:ai_analyses(id, quality_score, conversation_stage, analyzed_at)')
        .eq('vendedor_id', id)
        .order('last_message_at', { ascending: false })
        .limit(50),
      supabase.from('daily_kpis')
        .select('date, avg_quality_score')
        .eq('vendedor_id', id)
        .order('date', { ascending: true })
        .limit(28),
      supabase.from('whatsapp_instances')
        .select('status, phone_number')
        .eq('vendedor_id', id)
        .single(),
    ])

    setVendor(vendorRes.data)
    if (vendorRes.data) checkRole(vendorRes.data.supervisor_id)
    setConversations((convsRes.data ?? []) as ConvWithAnalysis[])
    setKpis(kpisRes.data ?? [])
    setInstance(instanceRes.data)
    setLoading(false)
  }

  const moveConversation = async (convId: string, stage: ConversationStage) => {
    setMovingConv(convId)
    await fetch('/api/pipeline', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, stage }),
    })
    await loadVendorData()
    setMovingConv(null)
  }

  const loadGlobalHistory = async () => {
    setLoadingGlobalHistory(true)
    try {
      const res = await fetch(`/api/vendors/global-analysis?vendorId=${id}`)
      if (!res.ok) {
        setGlobalError('No se pudo cargar el histórico del análisis global')
        return
      }
      const { history } = await res.json() as { history: VendorDailyAnalysis[] }
      setGlobalHistory(history)
      setGlobalError(null)
    } catch {
      setGlobalError('Error de red al cargar el histórico')
    } finally {
      setLoadingGlobalHistory(false)
    }
  }

  const generateGlobalAnalysis = async () => {
    setGeneratingGlobal(true)
    setGlobalError(null)
    try {
      const res = await fetch('/api/vendors/global-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorId: id }),
      })
      const result = await res.json() as { ok: boolean; data?: VendorDailyAnalysis; error?: string }
      if (result.ok) {
        await loadGlobalHistory()
      } else {
        setGlobalError(result.error ?? 'No se pudo generar el análisis')
      }
    } catch {
      setGlobalError('Error de red al generar el análisis')
    } finally {
      setGeneratingGlobal(false)
    }
  }

  const getConvsByStage = (stage: ConversationStage) => {
    return conversations.filter(c => {
      const analysis = c.ai_analysis?.[0]
      return analysis?.conversation_stage === stage
    })
  }

  const unstagedConvs = conversations.filter(c => !c.ai_analysis?.[0])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="text-gray-400 text-sm">Cargando perfil...</div>
      </div>
    )
  }

  if (!vendor) {
    return <div className="p-6 text-red-500">Vendedor no encontrado</div>
  }

  const latestScore = kpis.length > 0 ? kpis[kpis.length - 1].avg_quality_score : 0
  const chartData = kpis.map(k => ({
    date: new Date(k.date).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }),
    score: Math.round(k.avg_quality_score),
  }))

  return (
    <>
      {showEdit && vendor && (
        <EditModal
          vendor={vendor}
          onClose={() => setShowEdit(false)}
          onSaved={updated => {
            setVendor(updated)
            setShowEdit(false)
          }}
        />
      )}
      {showDelete && vendor && (
        <DeleteModal
          vendor={vendor}
          onClose={() => setShowDelete(false)}
          onDeleted={() => router.push('/vendors')}
        />
      )}

      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => router.back()} className="text-gray-400 hover:text-body">
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-2xl font-bold text-body">Perfil del Vendedor</h1>
          </div>

          {isAdmin && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowEdit(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-md text-body hover:bg-bg transition-colors"
              >
                <Pencil size={14} />
                Editar
              </button>
              <button
                onClick={() => setShowDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
              >
                <Trash2 size={14} />
                Eliminar
              </button>
            </div>
          )}
        </div>

        {/* Card de perfil */}
        <div className="bg-surface rounded-lg shadow-sm border border-border p-6">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <VendorAvatar vendor={vendor} size="lg" />
            <div className="flex-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-body">{vendor.full_name}</h2>
                  <p className="text-gray-500 text-sm">{vendor.email}</p>
                  <p className="text-gray-400 text-xs mt-1">
                    {instance?.phone_number ? `📱 ${instance.phone_number}` : 'Sin número configurado'}
                    {' · '}
                    <span className={`inline-flex items-center gap-1 ${instance?.status === 'connected' ? 'text-green-600' : 'text-gray-400'}`}>
                      {instance?.status === 'connected' ? <><Wifi size={10} /> Online</> : <><WifiOff size={10} /> Offline</>}
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <ScoreBadge score={Math.round(latestScore)} size="lg" showLabel />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Gráfico de evolución */}
        {chartData.length > 1 && (
          <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
            <h3 className="font-semibold text-body flex items-center gap-2 mb-4">
              <TrendingUp size={16} className="text-primary" />
              Evolución del Score (últimas {chartData.length} sesiones)
            </h3>
            <ScoreLineChart data={chartData} />
          </div>
        )}

        {/* Análisis global diario (últimos 3 días) */}
        {canSeeGlobalAnalysis && (
          <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-body">Análisis Global (últimos 3 días)</h3>
              <button
                onClick={generateGlobalAnalysis}
                disabled={generatingGlobal}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary hover:bg-primary-dark text-white font-semibold transition-colors disabled:opacity-60"
              >
                <RefreshCw size={14} className={generatingGlobal ? 'animate-spin' : ''} />
                {generatingGlobal ? 'Generando...' : 'Generar análisis de hoy'}
              </button>
            </div>

            {globalError && (
              <p className="text-sm text-red-500 mb-3">{globalError}</p>
            )}

            {loadingGlobalHistory ? (
              <p className="text-sm text-gray-400">Cargando...</p>
            ) : globalHistory.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                Todavía no se generó ningún análisis global para este vendedor.
              </p>
            ) : (
              <div className="space-y-4">
                {(() => {
                  const latest = globalHistory[0]
                  const trend = latest.avg_quality_score !== null && latest.avg_quality_score_prev_window !== null
                    ? latest.avg_quality_score - latest.avg_quality_score_prev_window
                    : null
                  return (
                    <div>
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-xs text-gray-400">
                          {formatDateAR(latest.date)} · {latest.conversations_analyzed} conversaciones analizadas
                        </span>
                        {latest.avg_quality_score !== null && (
                          <ScoreBadge score={Math.round(latest.avg_quality_score)} size="sm" />
                        )}
                        {trend !== null && (
                          <span className={`text-xs font-semibold ${trend > 0 ? 'text-green-600' : trend < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                            {trend > 0 ? '▲' : trend < 0 ? '▼' : '='} {Math.abs(trend).toFixed(1)} vs. período anterior
                          </span>
                        )}
                      </div>

                      {latest.summary_text && (
                        <p className="text-sm text-gray-700 leading-relaxed mb-3">{latest.summary_text}</p>
                      )}

                      {(latest.recurring_strengths.length > 0 || latest.recurring_weaknesses.length > 0) && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                          {latest.recurring_strengths.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-green-700 mb-1">Fortalezas recurrentes</p>
                              <ul className="text-xs text-gray-600 space-y-0.5 list-disc list-inside">
                                {latest.recurring_strengths.map((s, i) => <li key={i}>{s}</li>)}
                              </ul>
                            </div>
                          )}
                          {latest.recurring_weaknesses.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-red-600 mb-1">Debilidades recurrentes</p>
                              <ul className="text-xs text-gray-600 space-y-0.5 list-disc list-inside">
                                {latest.recurring_weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}

                      {latest.coaching_plan && (
                        <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-4 mb-3">
                          <h4 className="font-semibold text-yellow-800 flex items-center gap-2 mb-2 text-sm">
                            <Lock size={14} /> Plan de Coaching (Privado)
                          </h4>
                          <p className="text-sm text-yellow-900 leading-relaxed">{latest.coaching_plan}</p>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {globalHistory.length > 1 && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-semibold text-gray-500 mb-2">Histórico</p>
                    <div className="space-y-1">
                      {globalHistory.slice(1).map(h => (
                        <div key={h.id} className="flex items-center justify-between text-xs text-gray-500 py-1">
                          <span>{formatDateAR(h.date)} · {h.conversations_analyzed} conversaciones</span>
                          {h.avg_quality_score !== null && <ScoreBadge score={Math.round(h.avg_quality_score)} size="sm" />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Pipeline Kanban */}
        <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
          <h3 className="font-semibold text-body mb-4">Pipeline de Conversaciones</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3 overflow-x-auto">
            {STAGES.map(stage => {
              const stageConvs = getConvsByStage(stage)
              return (
                <div key={stage} className="min-w-[180px]">
                  <div className={`text-xs font-semibold px-2 py-1.5 rounded-t-md border ${STAGE_COLORS[stage]} mb-2`}>
                    {STAGE_LABELS[stage]}
                    <span className="ml-1 bg-white/60 px-1 rounded-full">{stageConvs.length}</span>
                  </div>
                  <div className="space-y-2 min-h-[80px]">
                    {stageConvs.map(conv => (
                      <div
                        key={conv.id}
                        className="bg-bg border border-border rounded-md p-2.5 text-xs cursor-pointer hover:border-primary transition-colors"
                        onClick={() => router.push(`/conversations`)}
                      >
                        <p className="font-medium text-body truncate">
                          {conv.client_name ?? conv.client_phone}
                        </p>
                        <p className="text-gray-400 truncate mt-0.5">
                          {conv.last_message_at ? formatDistanceToNow(new Date(conv.last_message_at)) : '—'}
                        </p>
                        {conv.ai_analysis?.[0] && (
                          <ScoreBadge score={conv.ai_analysis[0].quality_score} size="sm" />
                        )}
                        <select
                          value={stage}
                          onClick={e => e.stopPropagation()}
                          onChange={e => moveConversation(conv.id, e.target.value as ConversationStage)}
                          disabled={movingConv === conv.id}
                          className="mt-1.5 w-full text-xs border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          {STAGES.map(s => (
                            <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {stageConvs.length === 0 && (
                      <div className="text-xs text-gray-300 text-center py-4">Sin conversaciones</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {unstagedConvs.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-xs text-gray-500 mb-2">
                {unstagedConvs.length} conversación(es) sin analizar aún
              </p>
            </div>
          )}
        </div>

        {/* Historial de análisis */}
        <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
          <h3 className="font-semibold text-body mb-4">Últimas Conversaciones Analizadas</h3>
          <div className="space-y-2">
            {conversations
              .filter(c => c.ai_analysis?.length > 0)
              .slice(0, 10)
              .map(conv => (
                <div
                  key={conv.id}
                  className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-bg transition-colors cursor-pointer"
                  onClick={() => router.push(`/analysis/${conv.ai_analysis[0].id}`)}
                >
                  <div>
                    <p className="text-sm font-medium text-body">
                      {conv.client_name ?? conv.client_phone}
                    </p>
                    <p className="text-xs text-gray-400">
                      {new Date(conv.ai_analysis[0].analyzed_at).toLocaleDateString('es-AR')}
                    </p>
                  </div>
                  <ScoreBadge score={conv.ai_analysis[0].quality_score} size="sm" />
                </div>
              ))}
            {conversations.filter(c => c.ai_analysis?.length > 0).length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No hay análisis generados aún</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
