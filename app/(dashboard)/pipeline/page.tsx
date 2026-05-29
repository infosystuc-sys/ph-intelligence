'use client'

import { useEffect, useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { Conversation, ConversationStage, User } from '@/types'
import { STAGE_LABELS, STAGE_COLORS, formatDistanceToNow } from '@/lib/utils'
import ScoreBadge from '@/components/ui/ScoreBadge'
import VendorAvatar from '@/components/ui/VendorAvatar'

type ConvWithAnalysis = Conversation & {
  ai_analysis: Array<{ id: string; quality_score: number; conversation_stage: ConversationStage; analyzed_at: string }>
}

const STAGES: ConversationStage[] = ['new', 'negotiation', 'proposal', 'closed_won', 'closed_lost']

// Devuelve el análisis más reciente de una conversación
function latestAnalysis(conv: ConvWithAnalysis) {
  if (!conv.ai_analysis?.length) return null
  return [...conv.ai_analysis].sort(
    (a, b) => new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime()
  )[0]
}

export default function PipelinePage() {
  const supabase = createBrowserSupabaseClient()
  const [conversations, setConversations] = useState<ConvWithAnalysis[]>([])
  const [vendors, setVendors] = useState<User[]>([])
  const [selectedVendor, setSelectedVendor] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [dragging, setDragging] = useState<string | null>(null)
  const [employeePhones, setEmployeePhones] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadData()
    fetch('/api/employee-phones')
      .then(r => r.json())
      .then(d => {
        const phones = (d.data ?? []).map((p: { phone: string }) => p.phone)
        setEmployeePhones(new Set(phones))
      })
  }, [])

  const loadData = async () => {
    setLoading(true)

    // Supabase/PostgREST cap-ea .select() a 1000 filas. Para que el pipeline muestre
    // el total real necesitamos paginar manualmente hasta agotar la tabla.
    const PAGE = 1000
    const all: ConvWithAnalysis[] = []
    let from = 0
    const vendorsPromise = fetch('/api/vendors').then(r => r.json())

    while (true) {
      const { data, error } = await supabase
        .from('conversations')
        .select('*, vendedor:users!vendedor_id(id, full_name, avatar_url), ai_analysis:ai_analyses(id, quality_score, conversation_stage, analyzed_at)')
        .neq('status', 'historico')
        .not('remote_jid', 'ilike', '%@g.us')
        .order('last_message_at', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) { console.error('[pipeline] error cargando conversaciones:', error); break }
      if (!data || data.length === 0) break
      all.push(...(data as ConvWithAnalysis[]))
      if (data.length < PAGE) break
      from += PAGE
    }

    const vendorsRes = await vendorsPromise
    setConversations(all)
    setVendors(vendorsRes.data ?? [])
    setLoading(false)
  }

  const moveConversation = async (convId: string, stage: ConversationStage) => {
    await fetch('/api/pipeline', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, stage }),
    })
    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c
      const now = new Date().toISOString()
      const existing = c.ai_analysis?.length
        ? [{ ...c.ai_analysis[0], conversation_stage: stage, analyzed_at: now }]
        : [{ id: '', quality_score: 0, conversation_stage: stage, analyzed_at: now }]
      return { ...c, ai_analysis: existing }
    }))
  }

  // Conversaciones filtradas: excluye grupos, empleados, aplica vendor seleccionado
  const visibleConvs = conversations.filter(c =>
    !employeePhones.has(c.client_phone) &&
    (selectedVendor === 'all' || c.vendedor_id === selectedVendor)
  )

  const getStageConvs = (stage: ConversationStage) =>
    visibleConvs.filter(c => {
      const la = latestAnalysis(c)
      const cStage = la?.conversation_stage
      return cStage === stage || (stage === 'new' && !cStage)
    })

  // Contar conversaciones por vendor (para el badge en el tab)
  const countByVendor = (vendorId: string) =>
    conversations.filter(c =>
      c.vendedor_id === vendorId && !employeePhones.has(c.client_phone)
    ).length

  const handleDragStart = (convId: string) => setDragging(convId)
  const handleDragOver  = (e: React.DragEvent) => e.preventDefault()
  const handleDrop = (stage: ConversationStage) => {
    if (dragging) { moveConversation(dragging, stage); setDragging(null) }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-0 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-body">Pipeline</h1>
            <p className="text-sm text-muted mt-0.5">
              {visibleConvs.length} conversaciones · Arrastrá las cards para mover etapas
            </p>
          </div>
        </div>

        {/* Tabs de vendedores */}
        <div className="flex gap-1 overflow-x-auto scrollbar-none border-b border-border pb-0">
          {/* Tab "Todos" */}
          <button
            onClick={() => setSelectedVendor('all')}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-md border-b-2 whitespace-nowrap transition-colors shrink-0 ${
              selectedVendor === 'all'
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted hover:text-body hover:border-border'
            }`}
          >
            Todos
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${
              selectedVendor === 'all' ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-gray-500'
            }`}>
              {conversations.filter(c => !employeePhones.has(c.client_phone)).length}
            </span>
          </button>

          {/* Un tab por vendedor */}
          {vendors.map(vendor => {
            const count   = countByVendor(vendor.id)
            const active  = selectedVendor === vendor.id
            return (
              <button
                key={vendor.id}
                onClick={() => setSelectedVendor(vendor.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-md border-b-2 whitespace-nowrap transition-colors shrink-0 ${
                  active
                    ? 'border-primary text-primary bg-primary/5'
                    : 'border-transparent text-muted hover:text-body hover:border-border'
                }`}
              >
                <VendorAvatar vendor={vendor} size="sm" />
                <span className="truncate max-w-[100px]">
                  {vendor.full_name.split(' ')[0]}
                </span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${
                  active ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-gray-500'
                }`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Kanban */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Cargando pipeline...
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto p-6 pt-4">
          <div className="flex gap-4 h-full min-w-max">
            {STAGES.map(stage => {
              const stageConvs = getStageConvs(stage)
              return (
                <div
                  key={stage}
                  className="w-56 flex flex-col"
                  onDragOver={handleDragOver}
                  onDrop={() => handleDrop(stage)}
                >
                  {/* Cabecera de columna */}
                  <div className={`text-xs font-semibold px-3 py-2 rounded-t-md border ${STAGE_COLORS[stage]} flex items-center justify-between shrink-0`}>
                    <span>{STAGE_LABELS[stage]}</span>
                    <span className="bg-white/60 px-1.5 rounded-full">{stageConvs.length}</span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 bg-bg rounded-b-md border border-t-0 border-border p-2 space-y-2 overflow-y-auto min-h-[400px]">
                    {stageConvs.map(conv => {
                      const la = latestAnalysis(conv)
                      return (
                        <div
                          key={conv.id}
                          draggable
                          onDragStart={() => handleDragStart(conv.id)}
                          className={`bg-surface border border-border rounded-md p-3 cursor-grab active:cursor-grabbing hover:shadow-md transition-all ${
                            dragging === conv.id ? 'opacity-50 ring-2 ring-primary' : ''
                          }`}
                        >
                          {/* Nombre + score */}
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <p className="text-sm font-medium text-body leading-tight line-clamp-2">
                              {conv.display_name ?? conv.client_name ?? conv.client_phone}
                            </p>
                            {la && la.quality_score > 0 && (
                              <ScoreBadge score={la.quality_score} size="sm" />
                            )}
                          </div>

                          {/* Vendedor (solo en tab "Todos") */}
                          {selectedVendor === 'all' && conv.vendedor && (
                            <div className="flex items-center gap-1.5 mb-2">
                              <VendorAvatar vendor={conv.vendedor} size="sm" />
                              <span className="text-xs text-gray-500 truncate">
                                {(conv.vendedor as User).full_name.split(' ')[0]}
                              </span>
                            </div>
                          )}

                          {/* Tiempo */}
                          <p className="text-xs text-gray-400">
                            {conv.last_message_at
                              ? formatDistanceToNow(new Date(conv.last_message_at))
                              : '—'}
                          </p>

                          {/* Selector de etapa */}
                          <select
                            value={la?.conversation_stage ?? 'new'}
                            onClick={e => e.stopPropagation()}
                            onChange={e => moveConversation(conv.id, e.target.value as ConversationStage)}
                            className="mt-2 w-full text-xs border border-border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-primary bg-bg"
                          >
                            {STAGES.map(s => (
                              <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                            ))}
                          </select>
                        </div>
                      )
                    })}

                    {stageConvs.length === 0 && (
                      <div className="text-xs text-gray-300 text-center py-8 border-2 border-dashed border-gray-200 rounded-md">
                        Soltá aquí
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
