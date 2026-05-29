'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import ConvList from '@/components/conversations/ConvList'
import ChatBubble from '@/components/conversations/ChatBubble'
import ScoreBadge from '@/components/ui/ScoreBadge'
import { Conversation, Message } from '@/types'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { Search, Filter, Brain, ExternalLink, RefreshCw, X, Loader2, PhoneOff, Users, ChevronDown, Pencil, Check, ScrollText, CheckCircle, AlertCircle, Clock, Trash2, Archive, CheckSquare } from 'lucide-react'
import { STAGE_LABELS, formatPhone, normalizePhone } from '@/lib/utils'
import { WhatsappInstance } from '@/types'

export default function ConversationsPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState(searchParams.get('status') ?? '')
  const [filterStage, setFilterStage] = useState('')
  const [selectedInstance, setSelectedInstance] = useState('')
  const [instances, setInstances] = useState<WhatsappInstance[]>([])
  const [hideEmployeePhones, setHideEmployeePhones] = useState(true)
  const [employeePhones, setEmployeePhones] = useState<Set<string>>(new Set())
  const [groupsExpanded, setGroupsExpanded] = useState(false)
  const [addingPhone, setAddingPhone] = useState(false)
  const [addPhoneMsg, setAddPhoneMsg] = useState<{ type: 'ok' | 'error' | 'exists'; text: string } | null>(null)
  const [baseMap, setBaseMap] = useState<Record<string, { cliente: string | null; cuit_dni: string | null; localidad: string | null; tarjetas: string[]; observacion: string | null }>>({})

  // Edición de nombre en el header
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [savingName, setSavingName] = useState(false)

  // Rol del usuario (para mostrar acciones de admin/supervisor)
  const [userRole, setUserRole] = useState<string>('')

  // Selección múltiple
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  // Eliminar conversación individual
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false)
  const [deletingSelected, setDeletingSelected] = useState(false)

  // Log de análisis IA por conversación
  type AnalysisLog = {
    id: string
    triggered_by: 'auto' | 'manual'
    status: 'success' | 'error'
    model_used: string | null
    error_message: string | null
    duration_ms: number | null
    message_count: number | null
    created_at: string
    analysis_id: string | null
  }
  const [showLogPanel, setShowLogPanel] = useState(false)
  const [aiLogs, setAiLogs] = useState<AnalysisLog[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)

  const supabase = createBrowserSupabaseClient()

  const loadConversations = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    // Carga TODAS las conversaciones (no historico) paginando internamente.
    // El cap de 1000 de PostgREST hacía que con tablas grandes vinieran truncadas.
    const res = await fetch('/api/conversations?all=true')
    const data = await res.json()
    setConversations(data.data ?? [])
    if (!silent) setLoading(false)
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  // Cargar rol del usuario una sola vez al montar
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('users').select('role').eq('id', user.id).single()
        .then(({ data }) => { if (data) setUserRole(data.role) })
    })
  }, [supabase])

  // Autoselección por ?id= en la URL (navegación desde /analyses → "Ir a conversación")
  useEffect(() => {
    const targetId = searchParams.get('id')
    if (!targetId || !conversations.length || selected?.id === targetId) return
    const match = conversations.find(c => c.id === targetId)
    if (match) selectConversation(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, searchParams])

  // Cargar datos auxiliares una sola vez al montar
  useEffect(() => {
    fetch('/api/employee-phones')
      .then(r => r.json())
      .then(d => {
        const phones = (d.data ?? []).map((p: { phone: string }) => p.phone)
        setEmployeePhones(new Set(phones))
      })

    fetch('/api/base-clientes/lookup')
      .then(r => r.json())
      .then(d => {
        if (d.data) setBaseMap(d.data)
      })

    fetch('/api/instances')
      .then(r => r.json())
      .then(d => {
        setInstances(d.data ?? [])
      })
  }, [])

  // Suscripción Realtime: actualiza la conversación localmente y re-ordena de inmediato.
  // No hace un fetch completo para no mostrar "Cargando..." en cada mensaje.
  useEffect(() => {
    const channel = supabase
      .channel('messages-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as {
            conversation_id: string
            content: string
            msg_timestamp: string
            from_me: boolean
            type: string
          }

          setConversations(prev => {
            const updated = prev.map(c => {
              if (c.id !== msg.conversation_id) return c
              return {
                ...c,
                last_message_at: msg.msg_timestamp,
                message_count: (c.message_count ?? 0) + 1,
                last_message: {
                  id: '',
                  conversation_id: c.id,
                  content: msg.content ?? '',
                  type: (msg.type ?? 'text') as Message['type'],
                  from_me: msg.from_me ?? false,
                  msg_timestamp: msg.msg_timestamp,
                  media_url: null,
                },
              }
            })
            // Re-ordenar por último mensaje desc
            return updated.sort((a, b) => {
              const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
              const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
              return bt - at
            })
          })

          // Si la conversación activa recibió el mensaje, recargar sus mensajes
          setSelected(prev => {
            if (prev?.id === msg.conversation_id) {
              fetch(`/api/messages?conversationId=${prev.id}`)
                .then(r => r.json())
                .then(d => setMessages(d.messages ?? []))
            }
            return prev
          })
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [supabase])

  // Realtime: cuando el auto-análisis crea un nuevo registro en ai_analyses,
  // actualizar el puntaje en la tarjeta y en el header sin esperar el refresco de 5 min.
  useEffect(() => {
    const channel = supabase
      .channel('ai-analyses-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_analyses' },
        (payload) => {
          const a = payload.new as {
            id: string
            conversation_id: string
            quality_score: number
            conversation_stage: string
            sentiment: string
            analyzed_at: string
          }
          const newAnalysis = { id: a.id, quality_score: a.quality_score, conversation_stage: a.conversation_stage, sentiment: a.sentiment, analyzed_at: a.analyzed_at }

          setConversations(prev => prev.map(c => {
            if (c.id !== a.conversation_id) return c
            const existing = Array.isArray(c.ai_analysis) ? c.ai_analysis : (c.ai_analysis ? [c.ai_analysis] : [])
            return { ...c, ai_analysis: [newAnalysis, ...existing] }
          }))

          setSelected(prev => {
            if (!prev || prev.id !== a.conversation_id) return prev
            const existing = Array.isArray(prev.ai_analysis) ? prev.ai_analysis : (prev.ai_analysis ? [prev.ai_analysis] : [])
            return { ...prev, ai_analysis: [newAnalysis, ...existing] }
          })
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [supabase])

  // Realtime: cuando una conversación cambia de status (p.ej. el auto-análisis la
  // mueve a historico), reflejar el cambio inmediatamente sin esperar el refresco de 5 min.
  useEffect(() => {
    const channel = supabase
      .channel('conversations-status-realtime')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' },
        (payload) => {
          const updated = payload.new as { id: string; status: string }
          if (updated.status === 'historico') {
            // Sacar de la lista activa
            setConversations(prev => prev.filter(c => c.id !== updated.id))
            setSelected(prev => {
              if (prev?.id === updated.id) { setMessages([]); return null }
              return prev
            })
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [supabase])

  // Análisis automático deshabilitado por el momento.
  // El toggle en Settings no persistía correctamente, así que se pausa la función
  // hasta resolver la causa raíz. Solo el análisis manual y por lote siguen activos.

  // Refresco silencioso de la lista cada 5 minutos (sin disparar análisis IA)
  useEffect(() => {
    const interval = setInterval(() => {
      loadConversations(true)
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loadConversations])

  const selectConversation = async (conv: Conversation) => {
    setSelected(conv)
    setMessages([])
    setEditingName(false)
    setShowLogPanel(false)
    setAiLogs([])
    setConfirmDeleteSelected(false)
    setLoadingMessages(true)
    try {
      const res = await fetch(`/api/messages?conversationId=${conv.id}`)
      const data = await res.json()
      setMessages(data.messages ?? [])
    } finally {
      setLoadingMessages(false)
    }
  }

  const loadAiLogs = async (conversationId: string) => {
    setLoadingLogs(true)
    try {
      const res = await fetch(`/api/analyze/logs?conversationId=${conversationId}&limit=20`)
      const data = await res.json()
      setAiLogs(data.data ?? [])
    } finally {
      setLoadingLogs(false)
    }
  }

  const toggleLogPanel = () => {
    if (!selected) return
    if (!showLogPanel) {
      loadAiLogs(selected.id)
    }
    setShowLogPanel(v => !v)
  }

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmBulkDelete(false)
  }

  const handleBulkMoveHistorico = async () => {
    if (!selectedIds.size) return
    setBulkWorking(true)
    const res = await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds], status: 'historico' }),
    })
    if (res.ok) {
      setConversations(prev => prev.filter(c => !selectedIds.has(c.id)))
      if (selected && selectedIds.has(selected.id)) { setSelected(null); setMessages([]) }
      exitSelectionMode()
    }
    setBulkWorking(false)
  }

  const handleBulkDelete = async () => {
    if (!selectedIds.size) return
    setBulkWorking(true)
    const res = await fetch('/api/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds] }),
    })
    if (res.ok) {
      setConversations(prev => prev.filter(c => !selectedIds.has(c.id)))
      if (selected && selectedIds.has(selected.id)) { setSelected(null); setMessages([]) }
      exitSelectionMode()
    }
    setBulkWorking(false)
  }

  const handleDeleteSelected = async () => {
    if (!selected) return
    setDeletingSelected(true)
    const res = await fetch('/api/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [selected.id] }),
    })
    setDeletingSelected(false)
    if (res.ok) {
      setConversations(prev => prev.filter(c => c.id !== selected.id))
      setSelected(null)
      setMessages([])
      setConfirmDeleteSelected(false)
    }
  }

  const handleAnalyze = async () => {
    if (!selected) return
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      const res = await fetch('/api/analyze/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selected.id }),
      })
      const data = await res.json()
      if (data.analysisId) {
        router.push(`/analysis/${data.analysisId}`)
      } else {
        const msg = data.error ?? 'No se pudo generar el análisis'
        setAnalyzeError(msg)
        setTimeout(() => setAnalyzeError(null), 8000)
      }
    } catch {
      setAnalyzeError('Error de conexión al analizar')
      setTimeout(() => setAnalyzeError(null), 8000)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleSaveName = async (conversationId: string, displayName: string | null) => {
    const res = await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversationId, display_name: displayName }),
    })
    if (res.ok) {
      setConversations(prev => prev.map(c =>
        c.id === conversationId ? { ...c, display_name: displayName } : c
      ))
      setSelected(prev => prev?.id === conversationId ? { ...prev, display_name: displayName } : prev)
    }
  }

  const handleSaveHeaderName = async () => {
    if (!selected) return
    setSavingName(true)
    await handleSaveName(selected.id, editNameValue.trim() || null)
    setSavingName(false)
    setEditingName(false)
  }

  const isGroup = (c: Conversation) => c.remote_jid?.endsWith('@g.us') ?? false

  const matchesSearch = (c: Conversation) => {
    if (!search) return true
    const q = search.toLowerCase()
    // Cuando hay debouncedSearch el API ya filtró por nombre/teléfono/cliente.
    const localFields = [
      c.display_name,
      c.client_name,
      c.client_phone,
      formatPhone(c.client_phone),
      c.base_localidad,
      ...(c.base_tarjetas ?? []),
      c.vendedor?.full_name,
      c.last_message?.content,
      c.status,
    ]
    return localFields.some(f => f?.toLowerCase().includes(q))
  }

  const getBaseMatch = (conv: Conversation) => {
    // 1) Si la conversación ya tiene los datos persistidos en DB, usar esos.
    if (conv.base_cliente || conv.base_localidad || (conv.base_tarjetas && conv.base_tarjetas.length > 0)) {
      return {
        cliente:     conv.base_cliente     ?? null,
        cuit_dni:    conv.base_cuit_dni    ?? null,
        localidad:   conv.base_localidad   ?? null,
        tarjetas:    conv.base_tarjetas    ?? [],
        observacion: conv.base_observacion ?? null,
      }
    }
    // 2) Fallback al lookup en memoria (base recién importada, sin match-retroactive todavía).
    // Match por los últimos 9 dígitos.
    const norm = normalizePhone(conv.client_phone)
    if (norm.length < 9) return null
    return baseMap[norm.slice(-9)] ?? null
  }

  const individualConvs = conversations.filter(c =>
    !isGroup(c) &&
    !(hideEmployeePhones && employeePhones.has(c.client_phone)) &&
    (!selectedInstance || c.instance_id === selectedInstance) &&
    (!filterStatus || c.status === filterStatus) &&
    matchesSearch(c)
  ).filter(c => {
    if (!filterStage) return true
    const analyses = c.ai_analysis as Array<{ conversation_stage: string; analyzed_at: string }> | null
    if (!analyses || analyses.length === 0) return false
    const latest = [...analyses].sort((a, b) => new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime())[0]
    return latest.conversation_stage === filterStage
  })

  const groupConvs = conversations.filter(c =>
    isGroup(c) &&
    (!selectedInstance || c.instance_id === selectedInstance) &&
    matchesSearch(c)
  )

  const handleAddEmployeePhone = async () => {
    if (!selected) return
    setAddingPhone(true)
    setAddPhoneMsg(null)

    // Verificar si ya existe antes de intentar insertar
    if (employeePhones.has(selected.client_phone)) {
      setAddPhoneMsg({ type: 'exists', text: 'Este número ya está en la lista de empleados.' })
      setAddingPhone(false)
      return
    }

    const res = await fetch('/api/employee-phones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: selected.client_phone, name: selected.client_name ?? '' }),
    })
    const data = await res.json()
    setAddingPhone(false)

    if (!res.ok) {
      const isExists = data.error?.includes('ya está registrado')
      setAddPhoneMsg({
        type: isExists ? 'exists' : 'error',
        text: data.error ?? 'Error al agregar el número.',
      })
    } else {
      setEmployeePhones(prev => new Set([...prev, selected.client_phone]))
      setAddPhoneMsg({ type: 'ok', text: 'Número agregado a la lista de empleados.' })
    }

    // Limpiar mensaje tras 3 segundos
    setTimeout(() => setAddPhoneMsg(null), 3000)
  }

  const latestAnalysis = selected
    ? (() => {
        const arr = Array.isArray(selected.ai_analysis)
          ? selected.ai_analysis
          : selected.ai_analysis ? [selected.ai_analysis] : []
        return (arr as Array<{ id: string; quality_score: number; analyzed_at: string }>)
          .sort((a, b) => new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime())[0] ?? null
      })()
    : null

  // Prioridad de nombre: base.cliente (CSV) > display_name (editable) > client_name (WhatsApp) > phone
  const selectedDisplayName = selected
    ? (selected.base_cliente ?? selected.display_name ?? selected.client_name ?? selected.client_phone)
    : ''

  return (
    <div className="flex h-full">
      {/* Panel izquierdo: lista de conversaciones */}
      <div className="w-[576px] border-r border-border bg-surface flex flex-col shrink-0">

        {/* Toolbar de selección múltiple */}
        {selectionMode && (
          <div className="px-3 py-2 border-b border-border bg-primary/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-primary">
                {selectedIds.size} seleccionada{selectedIds.size !== 1 ? 's' : ''}
              </span>
              <button onClick={exitSelectionMode} className="text-xs text-gray-400 hover:text-body">
                Cancelar
              </button>
            </div>
            {!confirmBulkDelete ? (
              <div className="flex gap-1.5">
                <button
                  onClick={handleBulkMoveHistorico}
                  disabled={!selectedIds.size || bulkWorking}
                  className="flex-1 flex items-center justify-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-2 py-1.5 rounded disabled:opacity-40 transition-colors"
                >
                  {bulkWorking ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
                  Histórico
                </button>
                <button
                  onClick={() => setConfirmBulkDelete(true)}
                  disabled={!selectedIds.size || bulkWorking}
                  className="flex-1 flex items-center justify-center gap-1 text-xs bg-red-600 hover:bg-red-700 text-white font-medium px-2 py-1.5 rounded disabled:opacity-40 transition-colors"
                >
                  <Trash2 size={11} /> Eliminar
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-red-600 font-medium">
                  ¿Eliminar {selectedIds.size} conversación{selectedIds.size !== 1 ? 'es' : ''} permanentemente?
                </p>
                <div className="flex gap-1.5">
                  <button
                    onClick={handleBulkDelete}
                    disabled={bulkWorking}
                    className="flex-1 text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-2 py-1.5 rounded disabled:opacity-50 transition-colors"
                  >
                    {bulkWorking ? <Loader2 size={11} className="animate-spin mx-auto" /> : 'Sí, eliminar'}
                  </button>
                  <button
                    onClick={() => setConfirmBulkDelete(false)}
                    className="flex-1 text-xs border border-border text-gray-500 hover:text-body px-2 py-1.5 rounded transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tabs por instancia */}
        {instances.length > 0 && (
          <div className="flex overflow-x-auto border-b border-border bg-surface shrink-0 px-2 py-1.5 gap-1 scrollbar-none">
            <button
              onClick={() => setSelectedInstance('')}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 transition-colors ${
                !selectedInstance ? 'bg-primary text-white' : 'text-muted hover:bg-bg hover:text-body'
              }`}
            >
              Todas
              <span className={`ml-1 text-[10px] ${!selectedInstance ? 'opacity-80' : 'text-gray-400'}`}>
                ({conversations.filter(c => !isGroup(c) && !(hideEmployeePhones && employeePhones.has(c.client_phone))).length})
              </span>
            </button>
            {instances.map(inst => {
              const count = conversations.filter(c =>
                !isGroup(c) &&
                c.instance_id === inst.id &&
                !(hideEmployeePhones && employeePhones.has(c.client_phone))
              ).length
              const active = selectedInstance === inst.id
              return (
                <button
                  key={inst.id}
                  onClick={() => setSelectedInstance(inst.id)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 transition-colors ${
                    active ? 'bg-primary text-white' : 'text-muted hover:bg-bg hover:text-body'
                  }`}
                >
                  {inst.instance_name.split(' ')[0]}
                  <span className={`ml-1 text-[10px] ${active ? 'opacity-80' : 'text-gray-400'}`}>
                    ({count})
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Filtros */}
        <div className="p-3 border-b border-border space-y-2 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Buscar conversación..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-xs border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex gap-2">
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="flex-1 text-xs border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Todos los estados</option>
              <option value="active">Activas</option>
              <option value="pending">Pendientes</option>
              <option value="closed">Cerradas</option>
            </select>

            <select
              value={filterStage}
              onChange={e => setFilterStage(e.target.value)}
              className="flex-1 text-xs border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Todas las etapas</option>
              {Object.entries(STAGE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            {/* Toggle: ocultar teléfonos de empleados */}
            {employeePhones.size > 0 && (
              <button
                onClick={() => setHideEmployeePhones(v => !v)}
                className={`flex items-center gap-1 flex-1 px-2 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  hideEmployeePhones
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-bg border-border text-gray-500 hover:border-primary/30 hover:text-primary'
                }`}
              >
                <PhoneOff size={11} />
                {hideEmployeePhones ? `Ocultando ${employeePhones.size} emp.` : 'Incl. empleados'}
              </button>
            )}

            {/* Botón Seleccionar — solo admin/supervisor */}
            {['admin', 'supervisor'].includes(userRole) && !selectionMode && (
              <button
                onClick={() => setSelectionMode(true)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium border border-border text-gray-500 hover:border-primary/30 hover:text-primary transition-colors"
              >
                <CheckSquare size={11} /> Seleccionar
              </button>
            )}
          </div>
        </div>

        {/* Contador */}
        {!loading && (
          <div className="px-3 py-1 border-b border-border bg-bg flex items-center justify-between shrink-0">
            <span className="text-[11px] text-muted">
              {individualConvs.length === 0
                ? 'Sin conversaciones'
                : `${individualConvs.length} conversación${individualConvs.length !== 1 ? 'es' : ''}`}
            </span>
            {conversations.length > 0 && (
              <span className="text-[10px] text-gray-400">
                {conversations.filter(c => !isGroup(c)).length} totales
              </span>
            )}
          </div>
        )}

        {/* Lista virtualizada */}
        <ConvList
          loading={loading}
          individualConvs={individualConvs}
          groupConvs={groupConvs}
          selected={selected}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          groupsExpanded={groupsExpanded}
          setGroupsExpanded={setGroupsExpanded}
          getBaseMatch={getBaseMatch}
          handleSaveName={handleSaveName}
          selectConversation={selectConversation}
          toggleSelection={toggleSelection}
          userRole={userRole}
        />
      </div>

      {/* Panel derecho: chat */}
      <div className="flex-1 flex flex-col bg-bg">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
            <Filter size={40} className="mb-3 opacity-30" />
            <p className="text-sm">Seleccioná una conversación para ver el chat</p>
          </div>
        ) : (
          <>
            {/* Header del chat */}
            <div className="bg-surface border-b border-border px-5 py-3 flex items-center justify-between">
              <div className="min-w-0 mr-4">
                {/* Nombre editable */}
                {editingName ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="text"
                      value={editNameValue}
                      onChange={e => setEditNameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSaveHeaderName()
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                      className="text-sm font-semibold border border-primary rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary min-w-0"
                      placeholder="Nombre del cliente"
                    />
                    <button
                      onClick={handleSaveHeaderName}
                      disabled={savingName}
                      className="text-green-600 hover:text-green-700 disabled:opacity-50"
                    >
                      {savingName ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    </button>
                    <button onClick={() => setEditingName(false)} className="text-gray-400 hover:text-gray-600">
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="group/hname flex items-center gap-1.5 min-w-0">
                    <h3 className="font-semibold text-body truncate">{selectedDisplayName}</h3>
                    <button
                      onClick={() => {
                        setEditNameValue(selected.display_name ?? selected.client_name ?? '')
                        setEditingName(true)
                      }}
                      className="shrink-0 opacity-0 group-hover/hname:opacity-100 text-gray-300 hover:text-primary transition-opacity"
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                )}
                {/* Nombre original si hay display_name */}
                {selected.display_name && selected.client_name && selected.display_name !== selected.client_name && (
                  <p className="text-[10px] text-gray-400 leading-tight">{selected.client_name}</p>
                )}
                <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {formatPhone(selected.client_phone)}
                  {getBaseMatch(selected) && (() => {
                    const m = getBaseMatch(selected)!
                    const primary = m.tarjetas[0] ?? null
                    const extra   = Math.max(0, m.tarjetas.length - 1)
                    const hasMatch = !!(m.cliente || m.localidad || primary)
                    if (!hasMatch) return null
                    const tooltip = [
                      m.cliente     && `Cliente: ${m.cliente}`,
                      m.cuit_dni    && `CUIT/DNI: ${m.cuit_dni}`,
                      m.localidad   && `Localidad: ${m.localidad}`,
                      m.tarjetas.length && `Tarjetas: ${m.tarjetas.join(', ')}`,
                      m.observacion && `Obs: ${m.observacion}`,
                    ].filter(Boolean).join('\n')
                    return (
                      <>
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200"
                          title={tooltip}
                        >
                          {m.localidad ?? 'Cliente'}
                          {primary && <span className="font-normal opacity-80"> · {primary}</span>}
                          {extra > 0 && <span className="font-normal opacity-80"> +{extra}</span>}
                        </span>
                        {m.cuit_dni && (
                          <span className="inline-flex text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full" title={tooltip}>
                            DNI {m.cuit_dni}
                          </span>
                        )}
                        {m.observacion && (
                          <span className="text-[10px] italic text-gray-600" title={m.observacion}>
                            &ldquo;{m.observacion}&rdquo;
                          </span>
                        )}
                      </>
                    )
                  })()}
                  <span>{' · '}{selected.vendedor?.full_name ?? '—'} · {selected.message_count} mensajes</span>
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {latestAnalysis ? (
                  <div className="flex items-center gap-2">
                    <ScoreBadge score={(latestAnalysis as { quality_score: number }).quality_score} size="sm" />
                    <button
                      onClick={async () => {
                        setLoadingReport(true)
                        await router.push(`/analysis/${(latestAnalysis as { id: string }).id}`)
                        setLoadingReport(false)
                      }}
                      disabled={loadingReport}
                      className="text-xs text-primary hover:text-primary-dark font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      {loadingReport ? (
                        <><Loader2 size={12} className="animate-spin" /> Cargando informe...</>
                      ) : (
                        <>Ver informe <ExternalLink size={12} /></>
                      )}
                    </button>
                  </div>
                ) : null}
                {!employeePhones.has(selected.client_phone) && !selected.remote_jid?.endsWith('@g.us') && (
                  <div className="flex flex-col items-start gap-1">
                    <button
                      onClick={handleAnalyze}
                      disabled={analyzing}
                      className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-xs font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-50"
                    >
                      <Brain size={14} />
                      {analyzing ? 'Analizando...' : latestAnalysis ? 'Re-analizar con IA' : '🤖 Analizar con IA'}
                    </button>
                    {analyzeError && (
                      <span className="text-xs text-red-500 font-medium">{analyzeError}</span>
                    )}
                  </div>
                )}
                {/* Agregar a empleados */}
                <div className="flex items-center gap-1.5">
                  {addPhoneMsg && (
                    <span className={`text-xs font-medium ${
                      addPhoneMsg.type === 'ok'     ? 'text-green-600' :
                      addPhoneMsg.type === 'exists' ? 'text-amber-600' :
                                                      'text-red-500'
                    }`}>
                      {addPhoneMsg.text}
                    </span>
                  )}
                  <button
                    onClick={handleAddEmployeePhone}
                    disabled={addingPhone || employeePhones.has(selected.client_phone)}
                    title={
                      employeePhones.has(selected.client_phone)
                        ? 'Este número ya está en la lista de empleados'
                        : 'Agregar número a empleados'
                    }
                    className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed ${
                      employeePhones.has(selected.client_phone)
                        ? 'border-amber-300 bg-amber-50 text-amber-600 opacity-70'
                        : 'border-border text-gray-500 hover:border-primary hover:text-primary'
                    }`}
                  >
                    {addingPhone
                      ? <Loader2 size={11} className="animate-spin" />
                      : <PhoneOff size={11} />
                    }
                    Empleado
                  </button>
                </div>

                {/* Eliminar conversación */}
                {!confirmDeleteSelected ? (
                  <button
                    onClick={() => setConfirmDeleteSelected(true)}
                    title="Eliminar conversación"
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border text-gray-500 hover:border-red-400 hover:text-red-500 font-medium transition-colors"
                  >
                    <Trash2 size={11} /> Eliminar
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-red-600 font-medium">¿Eliminar?</span>
                    <button
                      onClick={handleDeleteSelected}
                      disabled={deletingSelected}
                      className="text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-2 py-1 rounded disabled:opacity-50 transition-colors"
                    >
                      {deletingSelected ? <Loader2 size={10} className="animate-spin" /> : 'Sí'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteSelected(false)}
                      className="text-xs text-gray-400 hover:text-body px-1"
                    >
                      No
                    </button>
                  </div>
                )}

                <button onClick={() => selectConversation(selected)} className="text-muted hover:text-body">
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={toggleLogPanel}
                  title="Ver log de análisis IA"
                  className={`transition-colors ${showLogPanel ? 'text-primary' : 'text-muted hover:text-body'}`}
                >
                  <ScrollText size={14} />
                </button>
                <button onClick={() => { setSelected(null); setAddPhoneMsg(null); setEditingName(false) }} className="text-muted hover:text-body">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Panel de log IA */}
            {showLogPanel && (
              <div className="border-b border-border bg-gray-50 px-5 py-3 max-h-64 overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-body flex items-center gap-1.5">
                    <ScrollText size={12} className="text-primary" />
                    Log de análisis IA
                  </span>
                  <button onClick={() => loadAiLogs(selected.id)} className="text-muted hover:text-body" title="Actualizar">
                    <RefreshCw size={11} />
                  </button>
                </div>
                {loadingLogs ? (
                  <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                    <Loader2 size={12} className="animate-spin" /> Cargando logs...
                  </div>
                ) : aiLogs.length === 0 ? (
                  <p className="text-xs text-gray-400 py-1">Sin análisis registrados para esta conversación.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 border-b border-border">
                        <th className="text-left pb-1 font-medium pr-3">Fecha</th>
                        <th className="text-left pb-1 font-medium pr-3">Tipo</th>
                        <th className="text-left pb-1 font-medium pr-3">Estado</th>
                        <th className="text-left pb-1 font-medium pr-3">Modelo</th>
                        <th className="text-left pb-1 font-medium pr-3">Msgs</th>
                        <th className="text-left pb-1 font-medium">Duración</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiLogs.map(log => (
                        <tr key={log.id} className="border-b border-border/50 last:border-0">
                          <td className="py-1 pr-3 text-gray-500 whitespace-nowrap">
                            {new Date(log.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="py-1 pr-3">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${log.triggered_by === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {log.triggered_by === 'auto' ? 'Auto' : 'Manual'}
                            </span>
                          </td>
                          <td className="py-1 pr-3">
                            {log.status === 'success' ? (
                              <span className="flex items-center gap-1 text-green-600">
                                <CheckCircle size={11} /> OK
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-red-500" title={log.error_message ?? ''}>
                                <AlertCircle size={11} /> Error
                              </span>
                            )}
                          </td>
                          <td className="py-1 pr-3 text-gray-500 font-mono text-[10px] truncate max-w-[120px]">
                            {log.model_used ?? '—'}
                          </td>
                          <td className="py-1 pr-3 text-gray-500">{log.message_count ?? '—'}</td>
                          <td className="py-1 text-gray-500 flex items-center gap-0.5">
                            <Clock size={10} />
                            {log.duration_ms != null ? `${(log.duration_ms / 1000).toFixed(1)}s` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {aiLogs.some(l => l.status === 'error') && (
                  <div className="mt-2 space-y-1">
                    {aiLogs.filter(l => l.status === 'error' && l.error_message).map(log => (
                      <p key={log.id} className="text-[10px] text-red-500 bg-red-50 rounded px-2 py-1">
                        {new Date(log.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        {' — '}{log.error_message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Mensajes */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {loadingMessages ? (
                <div className="flex items-center justify-center gap-2 text-gray-400 text-sm mt-8">
                  <Loader2 size={16} className="animate-spin" />
                  Cargando mensajes...
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center text-gray-400 text-sm mt-8">No hay mensajes en esta conversación</div>
              ) : (
                messages.map(msg => (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    vendorName={selected.vendedor?.full_name}
                    clientName={selectedDisplayName}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
