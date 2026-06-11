'use client'

import React, { useEffect, useRef, useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { User, WhatsappInstance } from '@/types'
import VendorAvatar from '@/components/ui/VendorAvatar'
import { Wifi, WifiOff, RefreshCw, Plus, Edit2, Eye, EyeOff, Brain, CheckCircle, X, Save, Loader2, Signal, Trash2, ScrollText, AlertCircle, Clock, Archive, Filter } from 'lucide-react'
import type { AIProvider } from '@/lib/ai-providers'
import { formatDistanceToNow } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { useSyncContext } from '@/contexts/SyncContext'

export default function SettingsPage() {
  const router = useRouter()
  const supabase = createBrowserSupabaseClient()
  const syncCtx = useSyncContext()
  const [activeTab, setActiveTab] = useState<'users' | 'instances' | 'ia' | 'api' | 'logs' | 'maintenance'>('users')
  const [aiProvider, setAiProvider] = useState<AIProvider>('anthropic')
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerSaved, setProviderSaved] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)

  // Instancias
  const [showNewInstance, setShowNewInstance] = useState(false)
  const [newInstance, setNewInstance] = useState({
    instance_name: '', api_url: process.env.NEXT_PUBLIC_EVOLUTION_API_BASE_URL ?? 'https://puntohogar-evolution-api.cuhhss.easypanel.host',
    api_key: '', phone_number: '', vendedor_id: '',
  })
  const [savingInstance, setSavingInstance] = useState(false)
  const [instanceError, setInstanceError] = useState('')
  const [testResults, setTestResults] = useState<Record<string, { connected: boolean; state: string; error?: string; testedUrl?: string; loading?: boolean }>>({})
  const [showApiKeyFor, setShowApiKeyFor] = useState<string | null>(null)
  const [editingInstance, setEditingInstance] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [deletingInstance, setDeletingInstance] = useState<string | null>(null)
  const [confirmDeleteInstance, setConfirmDeleteInstance] = useState<string | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [instances, setInstances] = useState<(WhatsappInstance & { vendedor?: User })[]>([])
  const [loading, setLoading] = useState(true)
  const [syncResults, setSyncResults] = useState<Record<string, { synced: number; errors: number; skipped: number; chatsFound: number }>>({})
  const [syncErrors, setSyncErrors] = useState<Record<string, string[]>>({})
  const lastResultRef = useRef(syncCtx.lastResult)
  const [showSyncErrors, setShowSyncErrors] = useState<string | null>(null)

  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [savedMsg, setSavedMsg] = useState('')
  const [remoteInstances, setRemoteInstances] = useState<string[] | null>(null)
  const [loadingRemote, setLoadingRemote] = useState(false)

  // Nuevo usuario
  const [newUser, setNewUser] = useState({ email: '', full_name: '', role: 'vendedor', password: '', supervisor_id: '' })
  const [creatingUser, setCreatingUser] = useState(false)
  const [userError, setUserError] = useState('')

  // Reset datos de ficción
  const [resetting, setResetting] = useState(false)
  const [resetMsg, setResetMsg] = useState('')

  // Recalcular timestamps
  const [recalculating, setRecalculating] = useState(false)
  const [recalcMsg, setRecalcMsg] = useState('')

  // Backfill de conversaciones (recuperar desde Evolution con ventana configurable)
  const [backfillDays, setBackfillDays] = useState(13)
  const [backfillIncludeLid, setBackfillIncludeLid] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState<{
    instances: number
    daysBack: number
    synced: number
    errors: number
    skipped: number
    chatsFound: number
    errorLog: string[]
  } | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)

  // Backfill DB-driven: itera conversaciones existentes y refresca mensajes desde Evolution
  const [dbBackfillMsgs, setDbBackfillMsgs] = useState(200)
  const [dbBackfilling, setDbBackfilling] = useState(false)
  const [dbBackfillResult, setDbBackfillResult] = useState<{
    instances: number
    messagesPerChat: number
    conversationsTried: number
    conversationsUpdated: number
    messagesInserted: number
    errors: number
    errorLog: string[]
  } | null>(null)
  const [dbBackfillError, setDbBackfillError] = useState<string | null>(null)

  // Vincular base de clientes con conversaciones
  type MatchItem = {
    conversation_id: string
    phone:           string
    whatsapp_name:   string | null
    cliente:         string | null
    cuit_dni:        string | null
    localidad:       string | null
    tarjetas:        string[]
    observacion:     string | null
  }
  type MatchReport = { matched: number; items: MatchItem[] }
  const [matching, setMatching] = useState(false)
  const [matchReport, setMatchReport] = useState<MatchReport | null>(null)
  const [matchError, setMatchError] = useState('')

  // Logs IA
  type AnalysisLog = {
    id: string
    conversation_id: string
    vendedor_id: string | null
    triggered_by: 'auto' | 'manual'
    status: 'success' | 'error'
    model_used: string | null
    error_message: string | null
    duration_ms: number | null
    message_count: number | null
    created_at: string
    analysis_id: string | null
    conversation: { client_name: string | null; client_phone: string; display_name: string | null } | null
    vendedor: { full_name: string } | null
  }
  const [logsVendorFilter, setLogsVendorFilter] = useState('')
  const [settingsLogs, setSettingsLogs] = useState<AnalysisLog[]>([])
  const [loadingSettingsLogs, setLoadingSettingsLogs] = useState(false)
  const [confirmDeleteLogs, setConfirmDeleteLogs] = useState<'vendor' | 'all' | null>(null)
  const [deletingLogs, setDeletingLogs] = useState(false)

  useEffect(() => {
    checkAdminAccess()
    loadData()
  }, [])

  const checkAdminAccess = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      router.push('/dashboard')
    }
  }

  const loadData = async () => {
    setLoading(true)
    const [usersRes, instancesRes, configRes] = await Promise.all([
      fetch('/api/vendors'),
      fetch('/api/instances'),
      fetch('/api/config'),
    ])
    const usersData = await usersRes.json()
    const instancesData = await instancesRes.json()
    const configData = await configRes.json()
    if (configData.ai_provider) setAiProvider(configData.ai_provider)
    setUsers(usersData.data ?? [])
    setInstances(instancesData.data ?? [])
    setLoading(false)
  }

  const testInstance = async (instanceId: string) => {
    setTestResults(prev => ({ ...prev, [instanceId]: { connected: false, state: '', loading: true } }))
    const res = await fetch('/api/instances/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId }),
    })
    const data = await res.json()
    setTestResults(prev => ({ ...prev, [instanceId]: { ...data, loading: false } }))
    await loadData()
  }

  const testNewInstance = async () => {
    setTestResults(prev => ({ ...prev, '__new__': { connected: false, state: '', loading: true } }))
    const res = await fetch('/api/instances/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_url: newInstance.api_url,
        api_key: newInstance.api_key,
        instance_name: newInstance.instance_name,
      }),
    })
    const data = await res.json()
    setTestResults(prev => ({ ...prev, '__new__': { ...data, loading: false } }))
  }

  const saveNewInstance = async () => {
    setSavingInstance(true)
    setInstanceError('')
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newInstance),
    })
    const data = await res.json()
    if (data.error) {
      setInstanceError(data.error)
    } else {
      setNewInstance({ instance_name: '', api_url: 'https://puntohogar-evolution-api.cuhhss.easypanel.host', api_key: '', phone_number: '', vendedor_id: '' })
      setShowNewInstance(false)
      setTestResults(prev => { const n = { ...prev }; delete n['__new__']; return n })
      await loadData()
    }
    setSavingInstance(false)
  }

  const saveEditInstance = async (instId: string) => {
    const res = await fetch('/api/instances', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: instId, ...editValues }),
    })
    if (res.ok) {
      setEditingInstance(null)
      setEditValues({})
      await loadData()
    }
  }

  const deleteInstance = async (instId: string) => {
    setDeletingInstance(instId)
    const res = await fetch(`/api/instances?id=${instId}`, { method: 'DELETE' })
    setDeletingInstance(null)
    setConfirmDeleteInstance(null)
    if (res.ok) await loadData()
  }

  const saveProvider = async (provider: AIProvider) => {
    setSavingProvider(true)
    setProviderSaved(false)
    setProviderError(null)
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_provider: provider }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProviderError(data.error ?? `HTTP ${res.status}`)
        return
      }
      // Confirmar leyendo de la DB que efectivamente se guardó
      const verifyRes = await fetch('/api/config', { cache: 'no-store' })
      const verifyData = await verifyRes.json()
      if (verifyData.ai_provider !== provider) {
        setProviderError(`El servidor respondió OK pero la DB sigue con "${verifyData.ai_provider}". Posible problema de RLS o service role.`)
        return
      }
      setAiProvider(provider)
      setProviderSaved(true)
      setTimeout(() => setProviderSaved(false), 3000)
    } finally {
      setSavingProvider(false)
    }
  }

  const loadRemoteInstances = async () => {
    setLoadingRemote(true)
    const res = await fetch('/api/instances/list-remote')
    const data = await res.json()
    setRemoteInstances(data.instances ?? [data.error ?? 'Error al obtener instancias'])
    setLoadingRemote(false)
  }

  const syncInstance = (instanceId: string) => {
    syncCtx.startSync(instanceId)
  }

  useEffect(() => {
    const r = syncCtx.lastResult
    if (!r || r === lastResultRef.current) return
    lastResultRef.current = r
    setSyncResults(prev => ({ ...prev, [r.instanceId]: r }))
    if (r.errorLog.length) setSyncErrors(prev => ({ ...prev, [r.instanceId]: r.errorLog }))
    loadData()
  }, [syncCtx.lastResult])

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreatingUser(true)
    setUserError('')
    const res = await fetch('/api/vendors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    })
    const data = await res.json()
    if (data.error) {
      setUserError(data.error)
    } else {
      setNewUser({ email: '', full_name: '', role: 'vendedor', password: '', supervisor_id: '' })
      await loadData()
    }
    setCreatingUser(false)
  }

  const matchBases = async () => {
    setMatching(true)
    setMatchReport(null)
    setMatchError('')
    const res = await fetch('/api/base-clientes/match-retroactive', { method: 'POST' })
    const data = await res.json()
    if (data.error) {
      setMatchError(data.error)
    } else {
      setMatchReport(data)
    }
    setMatching(false)
  }

  const recalcTimestamps = async () => {
    setRecalculating(true)
    setRecalcMsg('')
    const res = await fetch('/api/admin/recalc-timestamps', { method: 'POST' })
    const data = await res.json()
    setRecalcMsg(data.error ?? `Recalculadas ${data.updated} de ${data.total} conversaciones.`)
    setRecalculating(false)
    await loadData()
  }

  const runBackfill = async () => {
    setBackfilling(true)
    setBackfillError(null)
    setBackfillResult(null)
    try {
      const res = await fetch('/api/sync/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack: backfillDays, includeLid: backfillIncludeLid }),
      })
      const data = await res.json()
      if (!res.ok) {
        setBackfillError(data.error ?? 'Error en el backfill')
      } else {
        setBackfillResult({
          instances:  data.instances  ?? 0,
          daysBack:   data.daysBack   ?? backfillDays,
          synced:     data.synced     ?? 0,
          errors:     data.errors     ?? 0,
          skipped:    data.skipped    ?? 0,
          chatsFound: data.chatsFound ?? 0,
          errorLog:   data.errorLog   ?? [],
        })
      }
    } catch (e) {
      setBackfillError(e instanceof Error ? e.message : 'Error de conexión')
    } finally {
      setBackfilling(false)
    }
  }

  const runDbBackfill = async () => {
    setDbBackfilling(true)
    setDbBackfillError(null)
    setDbBackfillResult(null)
    try {
      const res = await fetch('/api/sync/messages-existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messagesPerChat: dbBackfillMsgs }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDbBackfillError(data.error ?? 'Error en el backfill DB-driven')
      } else {
        setDbBackfillResult({
          instances:            data.instances            ?? 0,
          messagesPerChat:      data.messagesPerChat      ?? dbBackfillMsgs,
          conversationsTried:   data.conversationsTried   ?? 0,
          conversationsUpdated: data.conversationsUpdated ?? 0,
          messagesInserted:     data.messagesInserted     ?? 0,
          errors:               data.errors               ?? 0,
          errorLog:             data.errorLog             ?? [],
        })
      }
    } catch (e) {
      setDbBackfillError(e instanceof Error ? e.message : 'Error de conexión')
    } finally {
      setDbBackfilling(false)
    }
  }

  const deleteLogs = async (scope: 'vendor' | 'all') => {
    setDeletingLogs(true)
    const body = scope === 'all' ? { all: true } : { vendedorId: logsVendorFilter }
    await fetch('/api/analyze/logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setDeletingLogs(false)
    setConfirmDeleteLogs(null)
    setSettingsLogs([])
  }

  const loadSettingsLogs = async (vendedorId?: string) => {
    setLoadingSettingsLogs(true)
    const params = new URLSearchParams()
    if (vendedorId) {
      params.set('vendedorId', vendedorId)
    } else if (users.length > 0) {
      params.set('vendedorId', users[0].id)
    } else {
      setLoadingSettingsLogs(false)
      return
    }
    params.set('limit', '100')
    const res = await fetch(`/api/analyze/logs?${params}`)
    const data = await res.json()
    setSettingsLogs(data.data ?? [])
    setLoadingSettingsLogs(false)
  }

  const resetConversations = async () => {
    setResetting(true)
    setResetMsg('')
    const res = await fetch('/api/admin/reset-conversations', { method: 'DELETE' })
    const data = await res.json()
    setResetMsg(data.error ?? 'Datos eliminados correctamente. Sincronizá las instancias para traer conversaciones reales.')
    setResetting(false)
  }

  // ── Mantenimiento: archivo masivo ────────────────────────────────────────────
  const [archUnrespondedClient, setArchUnrespondedClient] = useState(false)
  const [archMaxMessages, setArchMaxMessages] = useState<string>('')
  const [archMinInactiveDays, setArchMinInactiveDays] = useState<string>('')
  const [archDateFrom, setArchDateFrom] = useState('')
  const [archDateTo, setArchDateTo] = useState('')
  type ArchPreviewRow = { id: string; name: string; client_phone: string; message_count: number; last_message_at: string | null }
  const [archPreview, setArchPreview] = useState<ArchPreviewRow[] | null>(null)
  const [archCount, setArchCount] = useState<number | null>(null)
  const [archWorking, setArchWorking] = useState(false)
  const [archConfirm, setArchConfirm] = useState(false)
  const [archResult, setArchResult] = useState<{ archived: number } | null>(null)
  const [archError, setArchError] = useState('')

  const buildArchiveBody = (dryRun: boolean) => ({
    dryRun,
    unrespondedByClient: archUnrespondedClient || undefined,
    maxMessages: archMaxMessages ? parseInt(archMaxMessages) : undefined,
    minInactiveDays: archMinInactiveDays ? parseInt(archMinInactiveDays) : undefined,
    dateFrom: archDateFrom || undefined,
    dateTo: archDateTo || undefined,
  })

  const previewArchive = async () => {
    setArchWorking(true)
    setArchError('')
    setArchPreview(null)
    setArchCount(null)
    setArchConfirm(false)
    setArchResult(null)
    const res = await fetch('/api/conversations/bulk-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildArchiveBody(true)),
    })
    const data = await res.json()
    setArchWorking(false)
    if (data.error) { setArchError(data.error); return }
    setArchCount(data.count)
    setArchPreview(data.preview ?? [])
  }

  const executeArchive = async () => {
    setArchWorking(true)
    setArchError('')
    const res = await fetch('/api/conversations/bulk-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildArchiveBody(false)),
    })
    const data = await res.json()
    setArchWorking(false)
    if (data.error) { setArchError(data.error); return }
    setArchResult({ archived: data.archived })
    setArchConfirm(false)
    setArchPreview(null)
    setArchCount(null)
  }

  // ── Archivar todo ────────────────────────────────────────────────────────────
  const [archAllConfirm, setArchAllConfirm] = useState(false)
  const [archAllWorking, setArchAllWorking] = useState(false)
  const [archAllResult, setArchAllResult] = useState<{ archived: number } | null>(null)
  const [archAllError, setArchAllError] = useState('')

  const executeArchiveAll = async () => {
    setArchAllWorking(true)
    setArchAllError('')
    const res = await fetch('/api/conversations/bulk-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveAll: true }),
    })
    const data = await res.json()
    setArchAllWorking(false)
    if (data.error) { setArchAllError(data.error); return }
    setArchAllResult({ archived: data.archived })
    setArchAllConfirm(false)
  }

  const supervisors = users.filter(u => u.role === 'supervisor')

  const tabs = [
    { id: 'users',       label: 'Usuarios' },
    { id: 'instances',   label: 'Instancias WhatsApp' },
    { id: 'ia',          label: 'Proveedor IA' },
    { id: 'api',         label: 'API Keys' },
    { id: 'logs',        label: 'Logs IA' },
    { id: 'maintenance', label: 'Mantenimiento' },
  ] as const

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-body">Configuración</h1>
        <p className="text-sm text-gray-500 mt-0.5">Solo visible para administradores</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border mb-6 gap-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-500 hover:text-body'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab: Usuarios */}
      {activeTab === 'users' && (
        <div className="space-y-6">
          {/* Crear usuario */}
          <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
            <h3 className="font-semibold text-body mb-4 flex items-center gap-2">
              <Plus size={16} className="text-primary" /> Crear Nuevo Usuario
            </h3>
            <form onSubmit={createUser} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombre completo</label>
                <input
                  type="text"
                  required
                  value={newUser.full_name}
                  onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Email <span className="text-gray-400 font-normal">(opcional)</span>
                </label>
                <input
                  type="text"
                  value={newUser.email}
                  onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
                  placeholder="vendedor@empresa.com"
                  className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña temporal</label>
                <input
                  type="password"
                  required
                  value={newUser.password}
                  onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Rol</label>
                <select
                  value={newUser.role}
                  onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="vendedor">Vendedor</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {newUser.role === 'vendedor' && supervisors.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Supervisor asignado</label>
                  <select
                    value={newUser.supervisor_id}
                    onChange={e => setNewUser(p => ({ ...p, supervisor_id: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Sin supervisor</option>
                    {supervisors.map(s => (
                      <option key={s.id} value={s.id}>{s.full_name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="sm:col-span-2">
                {userError && (
                  <p className="text-xs text-red-500 mb-2">{userError}</p>
                )}
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50"
                >
                  {creatingUser ? 'Creando...' : 'Crear usuario'}
                </button>
              </div>
            </form>
          </div>

          {/* Vincular bases con conversaciones */}
          <div className="bg-white rounded-lg shadow-sm border border-border p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-body mb-1">Vincular Base Naranja / C&R</h3>
              <p className="text-xs text-gray-500 mb-3">
                Busca coincidencias de teléfono entre todas las conversaciones existentes y las bases importadas (Naranja y Cancela &amp; Renueva). Las nuevas conversaciones se vinculan automáticamente.
              </p>
              {matchError && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">{matchError}</p>
              )}
              <button
                onClick={matchBases}
                disabled={matching}
                className="bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {matching && <Loader2 size={14} className="animate-spin" />}
                {matching ? 'Vinculando...' : 'Vincular ahora'}
              </button>
            </div>

            {matchReport && (
              <div className="space-y-3">
                <div className="flex items-center gap-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-green-700">{matchReport.matched}</p>
                    <p className="text-xs text-green-600">Conversaciones vinculadas</p>
                  </div>
                </div>

                {matchReport.matched > 0 && (
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
                        {matchReport.items.map((item, idx) => (
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
                            <td className="px-3 py-2 text-gray-600 truncate max-w-32">{item.tarjetas.join(', ') || '—'}</td>
                            <td className="px-3 py-2 text-gray-500 italic truncate max-w-44">{item.observacion ?? ''}</td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => router.push(`/conversations?id=${item.conversation_id}`)}
                                className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark font-medium whitespace-nowrap"
                                title="Ir a la conversación"
                              >
                                Ver chat
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Recalcular timestamps */}
          <div className="bg-white rounded-lg shadow-sm border border-border p-5">
            <h3 className="font-semibold text-body mb-1">Recalcular fechas de conversaciones</h3>
            <p className="text-xs text-gray-500 mb-3">
              Corrige el campo "último mensaje" de cada conversación usando la fecha real de los mensajes guardados. Usá esto si el orden de las conversaciones está incorrecto.
            </p>
            {recalcMsg && (
              <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 mb-3">{recalcMsg}</p>
            )}
            <button
              onClick={recalcTimestamps}
              disabled={recalculating}
              className="bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50"
            >
              {recalculating ? 'Recalculando...' : 'Recalcular fechas'}
            </button>
          </div>

          {/* Zona de peligro */}
          <div className="bg-white rounded-lg shadow-sm border border-red-200 p-5">
            <h3 className="font-semibold text-red-700 mb-1">Zona de peligro</h3>
            <p className="text-xs text-gray-500 mb-3">
              Elimina todas las conversaciones, mensajes y análisis de la base de datos. Usá esto para limpiar datos de prueba antes de conectar Evolution API.
            </p>
            {resetMsg && (
              <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 mb-3">{resetMsg}</p>
            )}
            <button
              onClick={resetConversations}
              disabled={resetting}
              className="bg-red-600 hover:bg-red-700 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50"
            >
              {resetting ? 'Eliminando...' : 'Eliminar todas las conversaciones'}
            </button>
          </div>

          {/* Lista de usuarios */}
          <div className="bg-surface rounded-lg shadow-sm border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="font-semibold text-body">Vendedores ({users.length})</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg border-b border-border text-xs text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-4 py-3">Nombre</th>
                  <th className="text-left px-4 py-3">Email</th>
                  <th className="text-left px-4 py-3">Rol</th>
                  <th className="text-left px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">Cargando...</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No hay usuarios</td></tr>
                ) : (
                  users.map(user => (
                    <tr key={user.id} className="hover:bg-bg transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <VendorAvatar vendor={user} size="sm" />
                          <span className="font-medium">{user.full_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{user.email}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          user.role === 'admin'
                            ? 'bg-purple-100 text-purple-700'
                            : user.role === 'supervisor'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => router.push(`/vendors/${user.id}`)}
                          className="text-xs text-primary hover:text-primary-dark flex items-center gap-1"
                        >
                          <Edit2 size={12} /> Ver perfil
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Instancias WhatsApp */}
      {activeTab === 'instances' && (
        <div className="space-y-4">
          {/* Botón agregar */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-500">{instances.length} instancias configuradas · URL base: <span className="font-mono text-xs">puntohogar-evolution-api.cuhhss.easypanel.host</span></p>
              <button
                onClick={loadRemoteInstances}
                disabled={loadingRemote}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 disabled:opacity-40"
              >
                <Signal size={12} className={loadingRemote ? 'animate-pulse' : ''} />
                {loadingRemote ? 'Cargando...' : 'Ver en Evolution'}
              </button>
            </div>
            <button
              onClick={() => setShowNewInstance(p => !p)}
              className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-3 py-2 rounded-md transition-colors"
            >
              {showNewInstance ? <X size={14} /> : <Plus size={14} />}
              {showNewInstance ? 'Cancelar' : 'Nueva instancia'}
            </button>
          </div>

          {/* Instancias registradas en Evolution API */}
          {remoteInstances !== null && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <Signal size={14} className="text-blue-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-semibold text-blue-700 mb-1">Instancias registradas en Evolution API:</p>
                <div className="flex flex-wrap gap-1.5">
                  {remoteInstances.map((name, i) => (
                    <span key={i} className="font-mono text-xs bg-surface border border-blue-200 text-blue-800 px-2 py-0.5 rounded">
                      {name}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-blue-500 mt-1.5">El campo "Nombre de instancia" en la app debe coincidir exactamente con uno de estos.</p>
              </div>
            </div>
          )}

          {/* Formulario nueva instancia */}
          {showNewInstance && (
            <div className="bg-surface rounded-lg border-2 border-primary/30 p-5 space-y-4">
              <h3 className="font-semibold text-body flex items-center gap-2">
                <Plus size={15} className="text-primary" /> Agregar Instancia Evolution API
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Nombre de instancia <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    placeholder="Ej: Tucuman1"
                    value={newInstance.instance_name}
                    onChange={e => setNewInstance(p => ({ ...p, instance_name: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-xs text-gray-400 mt-0.5">Exactamente como aparece en Evolution Manager</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">API Key <span className="text-red-500">*</span></label>
                  <div className="relative">
                    <input
                      type={showApiKeyFor === '__new__' ? 'text' : 'password'}
                      placeholder="Copiá desde Evolution Manager → ícono 👁"
                      value={newInstance.api_key}
                      onChange={e => setNewInstance(p => ({ ...p, api_key: e.target.value }))}
                      className="w-full border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary pr-8"
                    />
                    <button onClick={() => setShowApiKeyFor(p => p === '__new__' ? null : '__new__')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
                      {showApiKeyFor === '__new__' ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Número de teléfono</label>
                  <input
                    type="text"
                    placeholder="Ej: 5493816203791"
                    value={newInstance.phone_number}
                    onChange={e => setNewInstance(p => ({ ...p, phone_number: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Asignar a vendedor</label>
                  <select
                    value={newInstance.vendedor_id}
                    onChange={e => setNewInstance(p => ({ ...p, vendedor_id: e.target.value }))}
                    className="w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Sin asignar</option>
                    {users.map(v => (
                      <option key={v.id} value={v.id}>{v.full_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Test resultado */}
              {testResults['__new__'] && !testResults['__new__'].loading && (
                <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md ${
                  testResults['__new__'].connected
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {testResults['__new__'].connected
                    ? <><CheckCircle size={14} /> Conexión exitosa — estado: {testResults['__new__'].state}</>
                    : <><WifiOff size={14} /> Sin conexión — {testResults['__new__'].error ?? testResults['__new__'].state}</>
                  }
                </div>
              )}

              {instanceError && <p className="text-xs text-red-500">{instanceError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={testNewInstance}
                  disabled={!newInstance.instance_name || !newInstance.api_key || testResults['__new__']?.loading}
                  className="flex items-center gap-1.5 border border-primary text-primary hover:bg-red-50 text-sm font-medium px-3 py-2 rounded-md transition-colors disabled:opacity-40"
                >
                  {testResults['__new__']?.loading ? <Loader2 size={14} className="animate-spin" /> : <Signal size={14} />}
                  Probar conexión
                </button>
                <button
                  onClick={saveNewInstance}
                  disabled={savingInstance || !newInstance.instance_name || !newInstance.api_key}
                  className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-3 py-2 rounded-md transition-colors disabled:opacity-40"
                >
                  {savingInstance ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Guardar instancia
                </button>
              </div>
            </div>
          )}

          {/* Lista de instancias */}
          <div className="bg-surface rounded-lg shadow-sm border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg border-b border-border text-xs text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-4 py-3">Instancia</th>
                  <th className="text-left px-4 py-3">Vendedor</th>
                  <th className="text-left px-4 py-3">Número</th>
                  <th className="text-left px-4 py-3">API Key</th>
                  <th className="text-left px-4 py-3">Estado</th>
                  <th className="text-left px-4 py-3">Último sync</th>
                  <th className="text-left px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Cargando...</td></tr>
                ) : instances.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    No hay instancias. Hacé click en "Nueva instancia" para agregar la primera.
                  </td></tr>
                ) : (
                  instances.map(inst => {
                    const test = testResults[inst.id]
                    const isEditing = editingInstance === inst.id
                    return (
                      <React.Fragment key={inst.id}>
                      <tr className={`transition-colors ${isEditing ? 'bg-yellow-50' : 'hover:bg-bg'}`}>
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-body">{inst.instance_name}</td>
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <select
                              value={editValues.vendedor_id ?? inst.vendedor_id ?? ''}
                              onChange={e => setEditValues(p => ({ ...p, vendedor_id: e.target.value }))}
                              className="border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                            >
                              <option value="">Sin asignar</option>
                              {users.map(v => <option key={v.id} value={v.id}>{v.full_name}</option>)}
                            </select>
                          ) : inst.vendedor ? (
                            <div className="flex items-center gap-1.5">
                              <VendorAvatar vendor={inst.vendedor} size="sm" />
                              <span className="text-xs">{inst.vendedor.full_name}</span>
                            </div>
                          ) : <span className="text-gray-300 text-xs">Sin asignar</span>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editValues.phone_number ?? inst.phone_number ?? ''}
                              onChange={e => setEditValues(p => ({ ...p, phone_number: e.target.value }))}
                              className="border border-border rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          ) : inst.phone_number ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                type={showApiKeyFor === inst.id ? 'text' : 'password'}
                                value={editValues.api_key ?? inst.api_key}
                                onChange={e => setEditValues(p => ({ ...p, api_key: e.target.value }))}
                                className="border border-border rounded px-2 py-1 text-xs w-36 font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                              <button onClick={() => setShowApiKeyFor(p => p === inst.id ? null : inst.id)} className="text-gray-400">
                                {showApiKeyFor === inst.id ? <EyeOff size={12} /> : <Eye size={12} />}
                              </button>
                            </div>
                          ) : (
                            <span className="font-mono text-xs text-gray-400">••••••••••••</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {test?.loading ? (
                            <span className="flex items-center gap-1 text-xs text-gray-400"><Loader2 size={12} className="animate-spin" /> Probando...</span>
                          ) : test ? (
                            <div>
                              <span className={`flex items-center gap-1 text-xs font-medium ${test.connected ? 'text-green-600' : 'text-red-500'}`}>
                                {test.connected
                                  ? <><Wifi size={12} /> {test.state}</>
                                  : <><WifiOff size={12} /> {test.state}</>}
                              </span>
                              {!test.connected && (test.error || test.testedUrl) && (
                                <div className="mt-0.5 space-y-0.5">
                                  {test.error && (
                                    <div className="flex items-start gap-1">
                                      <p className="text-xs text-red-400 max-w-[200px] break-words">{test.error}</p>
                                      <button
                                        onClick={() => navigator.clipboard.writeText(`${test.error}\nURL: ${test.testedUrl ?? ''}`)}
                                        className="shrink-0 text-gray-400 hover:text-gray-600"
                                        title="Copiar error"
                                      >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                      </button>
                                    </div>
                                  )}
                                  {test.testedUrl && (
                                    <p className="text-[10px] text-gray-400 font-mono break-all max-w-[200px]" title={test.testedUrl}>
                                      → {test.testedUrl}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className={`flex items-center gap-1 text-xs font-medium ${inst.status === 'connected' ? 'text-green-600' : 'text-gray-400'}`}>
                              {inst.status === 'connected' ? <><Wifi size={12} /> Conectada</> : <><WifiOff size={12} /> {inst.status}</>}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {inst.last_sync_at ? formatDistanceToNow(new Date(inst.last_sync_at)) : 'Nunca'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isEditing ? (
                              <>
                                <button onClick={() => saveEditInstance(inst.id)} className="text-xs text-green-600 hover:text-green-700 font-medium flex items-center gap-0.5">
                                  <Save size={12} /> Guardar
                                </button>
                                <button onClick={() => { setEditingInstance(null); setEditValues({}) }} className="text-xs text-gray-400 hover:text-gray-600">
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => testInstance(inst.id)}
                                  disabled={test?.loading}
                                  className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-0.5 disabled:opacity-40"
                                >
                                  <Signal size={12} /> Probar
                                </button>
                                <div className="flex flex-col items-start gap-0.5">
                                  <button
                                    onClick={() => syncInstance(inst.id)}
                                    disabled={syncCtx.syncingInstanceId === inst.id}
                                    className="text-xs text-primary hover:text-primary-dark font-medium flex items-center gap-0.5 disabled:opacity-40"
                                  >
                                    <RefreshCw size={12} className={syncCtx.syncingInstanceId === inst.id ? 'animate-spin' : ''} />
                                    {syncCtx.syncingInstanceId === inst.id ? 'Sincronizando...' : 'Sync'}
                                  </button>
                                  {syncResults[inst.id] && (() => {
                                    const r = syncResults[inst.id]
                                    return (
                                      <div className="text-xs space-y-0.5">
                                        <span className={r.chatsFound === 0 ? 'text-orange-500' : r.errors > 0 ? 'text-yellow-600' : 'text-green-600'}>
                                          {r.chatsFound === 0
                                            ? 'Sin chats en Evolution'
                                            : `${r.synced} ok · ${r.skipped} omitidos`}
                                        </span>
                                        {r.errors > 0 && (
                                          <button
                                            onClick={() => setShowSyncErrors(showSyncErrors === inst.id ? null : inst.id)}
                                            className="block text-red-500 hover:text-red-700 underline"
                                          >
                                            {r.errors} errores — ver detalle
                                          </button>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>
                                <button
                                  onClick={() => { setEditingInstance(inst.id); setEditValues({ api_key: inst.api_key, phone_number: inst.phone_number ?? '', vendedor_id: inst.vendedor_id ?? '' }) }}
                                  className="text-xs text-gray-500 hover:text-body flex items-center gap-0.5"
                                >
                                  <Edit2 size={12} /> Editar
                                </button>
                                {confirmDeleteInstance === inst.id ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-red-500">¿Confirmar?</span>
                                    <button
                                      onClick={() => deleteInstance(inst.id)}
                                      disabled={deletingInstance === inst.id}
                                      className="text-xs text-red-600 hover:text-red-700 font-semibold disabled:opacity-50"
                                    >
                                      {deletingInstance === inst.id ? '...' : 'Sí'}
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteInstance(null)}
                                      className="text-xs text-gray-400 hover:text-gray-600"
                                    >
                                      No
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setConfirmDeleteInstance(inst.id)}
                                    className="text-xs text-red-500 hover:text-red-700 flex items-center gap-0.5"
                                  >
                                    <Trash2 size={12} /> Eliminar
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {/* Fila expandible de errores de sync */}
                      {showSyncErrors === inst.id && syncErrors[inst.id]?.length > 0 && (
                        <tr className="bg-red-50">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-semibold text-red-600">
                                Detalle de errores ({syncErrors[inst.id].length})
                              </span>
                              <button onClick={() => setShowSyncErrors(null)} className="text-gray-400 hover:text-gray-600">
                                <X size={14} />
                              </button>
                            </div>
                            <div className="max-h-48 overflow-y-auto space-y-0.5">
                              {syncErrors[inst.id].map((err, i) => (
                                <p key={i} className="text-xs font-mono text-red-700 bg-red-100 px-2 py-1 rounded">
                                  {err}
                                </p>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Proveedor IA */}
      {activeTab === 'ia' && (
        <div className="space-y-4">
          <div className="bg-surface rounded-lg shadow-sm border border-border p-6">
            <h3 className="font-semibold text-body flex items-center gap-2 mb-1">
              <Brain size={16} className="text-primary" /> Proveedor de Inteligencia Artificial
            </h3>
            <p className="text-sm text-gray-500 mb-6">
              Seleccioná qué modelo de IA se usa para analizar las conversaciones. El cambio aplica inmediatamente para todos los análisis nuevos.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Card Anthropic */}
              <button
                onClick={() => saveProvider('anthropic')}
                disabled={savingProvider}
                className={`relative text-left p-5 rounded-lg border-2 transition-all ${
                  aiProvider === 'anthropic'
                    ? 'border-primary bg-red-50'
                    : 'border-border bg-surface hover:border-gray-300'
                }`}
              >
                {aiProvider === 'anthropic' && (
                  <span className="absolute top-3 right-3 text-primary">
                    <CheckCircle size={18} />
                  </span>
                )}
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-[#CC785C] flex items-center justify-center text-white font-bold text-lg">
                    A
                  </div>
                  <div>
                    <p className="font-semibold text-body">Anthropic Claude</p>
                    <p className="text-xs text-gray-500 font-mono">claude-sonnet-4-20250514</p>
                  </div>
                </div>
                <ul className="text-xs text-gray-600 space-y-1">
                  <li>✓ Mejor razonamiento en español</li>
                  <li>✓ Análisis más detallado y contextual</li>
                  <li>✓ Respuestas JSON muy precisas</li>
                </ul>
                {aiProvider === 'anthropic' && (
                  <div className="mt-3 text-xs font-semibold text-primary">Activo actualmente</div>
                )}
              </button>

              {/* Card Gemini */}
              <button
                onClick={() => saveProvider('gemini')}
                disabled={savingProvider}
                className={`relative text-left p-5 rounded-lg border-2 transition-all ${
                  aiProvider === 'gemini'
                    ? 'border-primary bg-red-50'
                    : 'border-border bg-surface hover:border-gray-300'
                }`}
              >
                {aiProvider === 'gemini' && (
                  <span className="absolute top-3 right-3 text-primary">
                    <CheckCircle size={18} />
                  </span>
                )}
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-[#4285F4] flex items-center justify-center text-white font-bold text-lg">
                    G
                  </div>
                  <div>
                    <p className="font-semibold text-body">Google Gemini</p>
                    <p className="text-xs text-gray-500 font-mono">gemini-flash-latest</p>
                  </div>
                </div>
                <ul className="text-xs text-gray-600 space-y-1">
                  <li>✓ Muy rápido en respuestas</li>
                  <li>✓ Costo menor por análisis</li>
                  <li>✓ Buen rendimiento general</li>
                </ul>
                {aiProvider === 'gemini' && (
                  <div className="mt-3 text-xs font-semibold text-primary">Activo actualmente</div>
                )}
              </button>

              {/* Card Groq */}
              <button
                onClick={() => saveProvider('groq')}
                disabled={savingProvider}
                className={`relative text-left p-5 rounded-lg border-2 transition-all ${
                  aiProvider === 'groq'
                    ? 'border-primary bg-red-50'
                    : 'border-border bg-surface hover:border-gray-300'
                }`}
              >
                {aiProvider === 'groq' && (
                  <span className="absolute top-3 right-3 text-primary">
                    <CheckCircle size={18} />
                  </span>
                )}
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-[#F55036] flex items-center justify-center text-white font-bold text-lg">
                    Q
                  </div>
                  <div>
                    <p className="font-semibold text-body">Groq (Llama 3.3)</p>
                    <p className="text-xs text-gray-500 font-mono">llama-3.3-70b-versatile</p>
                  </div>
                </div>
                <ul className="text-xs text-gray-600 space-y-1">
                  <li>✓ Capa gratuita muy generosa</li>
                  <li>✓ Respuestas ultra rápidas</li>
                  <li>✓ Ideal para alto volumen</li>
                </ul>
                {aiProvider === 'groq' && (
                  <div className="mt-3 text-xs font-semibold text-primary">Activo actualmente</div>
                )}
              </button>
            </div>

            {providerSaved && (
              <div className="mt-4 flex items-center gap-2 text-sm text-green-600">
                <CheckCircle size={14} /> Proveedor guardado correctamente
              </div>
            )}
            {providerError && (
              <div className="mt-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{providerError}</span>
              </div>
            )}
            {savingProvider && (
              <p className="mt-4 text-sm text-gray-400">Guardando...</p>
            )}
          </div>

          {/* Análisis autónomo: pausado por el momento */}
          <div className="bg-amber-50 rounded-lg border border-amber-200 p-5">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold text-amber-900">Análisis automático — Pausado</h3>
                <p className="text-xs text-amber-800 mt-1">
                  La función de análisis autónomo en segundo plano está deshabilitada por el momento.
                  Los análisis manuales individuales y los análisis por lote siguen funcionando normalmente.
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 bg-blue-50 rounded-md border border-blue-200 text-xs text-blue-700">
            <p className="font-semibold mb-1">Variables de entorno requeridas según proveedor:</p>
            <ul className="list-disc list-inside space-y-1 font-mono">
              <li>ANTHROPIC_API_KEY — requerida si usás Claude</li>
              <li>GEMINI_API_KEY — requerida si usás Gemini</li>
              <li>GROQ_API_KEY — requerida si usás Groq</li>
              <li>AI_PROVIDER — opcional, fallback si app_config está vacío (anthropic, gemini o groq)</li>
            </ul>
          </div>
        </div>
      )}

      {/* Tab: API Keys */}
      {activeTab === 'api' && (
        <div className="bg-surface rounded-lg shadow-sm border border-border p-5 space-y-4">
          <h3 className="font-semibold text-body">Configuración de API</h3>
          <p className="text-sm text-gray-500">
            Las API keys se configuran como variables de entorno en el servidor (Vercel). No se almacenan en la base de datos.
          </p>

          <div className="space-y-3">
            <div className="p-4 bg-bg rounded-md border border-border">
              <p className="text-xs font-semibold text-gray-600 mb-1">ANTHROPIC_API_KEY</p>
              <p className="text-xs text-gray-400">Usada para el motor de análisis IA (Claude claude-sonnet-4-20250514)</p>
              <div className="flex items-center gap-2 mt-2">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="flex-1 border border-border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
                <button onClick={() => setShowApiKey(p => !p)} className="text-gray-400 hover:text-body">
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <div className="p-4 bg-blue-50 rounded-md border border-blue-200 text-xs text-blue-700">
              <p className="font-semibold mb-1">⚠️ Variables de entorno requeridas en Vercel:</p>
              <ul className="list-disc list-inside space-y-1 font-mono">
                <li>NEXT_PUBLIC_SUPABASE_URL</li>
                <li>NEXT_PUBLIC_SUPABASE_ANON_KEY</li>
                <li>SUPABASE_SERVICE_ROLE_KEY</li>
                <li>ANTHROPIC_API_KEY</li>
                <li>GEMINI_API_KEY</li>
                <li>GROQ_API_KEY</li>
                <li>NEXT_PUBLIC_APP_URL (URL pública del deploy)</li>
                <li>EVOLUTION_API_BASE_URL (opcional, URL base)</li>
              </ul>
            </div>

            {savedMsg && (
              <p className="text-xs text-green-600">{savedMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* Tab: Logs IA */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-body flex items-center gap-2">
                <ScrollText size={16} className="text-primary" /> Logs de análisis IA
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadSettingsLogs(logsVendorFilter || undefined)}
                  disabled={loadingSettingsLogs}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark disabled:opacity-50"
                >
                  <RefreshCw size={12} className={loadingSettingsLogs ? 'animate-spin' : ''} />
                  Actualizar
                </button>
                {logsVendorFilter && confirmDeleteLogs !== 'all' && (
                  confirmDeleteLogs === 'vendor' ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-red-600 font-medium">¿Borrar logs de este vendedor?</span>
                      <button
                        onClick={() => deleteLogs('vendor')}
                        disabled={deletingLogs}
                        className="text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-2 py-0.5 rounded disabled:opacity-50"
                      >
                        {deletingLogs ? <Loader2 size={10} className="animate-spin" /> : 'Sí'}
                      </button>
                      <button onClick={() => setConfirmDeleteLogs(null)} className="text-xs text-gray-400 hover:text-body px-1">No</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteLogs('vendor')}
                      className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-2 py-0.5 rounded transition-colors"
                    >
                      <Trash2 size={11} /> Borrar vendedor
                    </button>
                  )
                )}
                {confirmDeleteLogs === 'all' ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-red-600 font-medium">¿Borrar todos los logs?</span>
                    <button
                      onClick={() => deleteLogs('all')}
                      disabled={deletingLogs}
                      className="text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-2 py-0.5 rounded disabled:opacity-50"
                    >
                      {deletingLogs ? <Loader2 size={10} className="animate-spin" /> : 'Sí'}
                    </button>
                    <button onClick={() => setConfirmDeleteLogs(null)} className="text-xs text-gray-400 hover:text-body px-1">No</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteLogs('all')}
                    className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-2 py-0.5 rounded transition-colors"
                  >
                    <Trash2 size={11} /> Borrar todos
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 mb-4">
              <select
                value={logsVendorFilter}
                onChange={e => {
                  setLogsVendorFilter(e.target.value)
                  loadSettingsLogs(e.target.value || undefined)
                }}
                className="text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">Seleccioná un vendedor</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </select>
              {!logsVendorFilter && (
                <p className="text-xs text-gray-400">Elegí un vendedor para ver sus logs</p>
              )}
            </div>

            {logsVendorFilter && (
              loadingSettingsLogs ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                  <Loader2 size={14} className="animate-spin" /> Cargando logs...
                </div>
              ) : settingsLogs.length === 0 ? (
                <p className="text-sm text-gray-400 py-4">Sin análisis registrados para este vendedor.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 border-b border-border bg-gray-50">
                        <th className="text-left px-3 py-2 font-medium">Fecha</th>
                        <th className="text-left px-3 py-2 font-medium">Conversación</th>
                        <th className="text-left px-3 py-2 font-medium">Tipo</th>
                        <th className="text-left px-3 py-2 font-medium">Estado</th>
                        <th className="text-left px-3 py-2 font-medium">Modelo</th>
                        <th className="text-left px-3 py-2 font-medium">Msgs</th>
                        <th className="text-left px-3 py-2 font-medium">Duración</th>
                        <th className="text-left px-3 py-2 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settingsLogs.map(log => (
                        <tr key={log.id} className="border-b border-border/50 hover:bg-gray-50">
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                            {new Date(log.created_at).toLocaleString('es-AR', {
                              day: '2-digit', month: '2-digit', year: '2-digit',
                              hour: '2-digit', minute: '2-digit',
                            })}
                          </td>
                          <td className="px-3 py-2 text-gray-700 max-w-[160px] truncate">
                            {log.conversation?.display_name ?? log.conversation?.client_name ?? log.conversation?.client_phone ?? log.conversation_id.slice(0, 8)}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${log.triggered_by === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {log.triggered_by === 'auto' ? 'Auto' : 'Manual'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {log.status === 'success' ? (
                              <span className="flex items-center gap-1 text-green-600 font-medium">
                                <CheckCircle size={11} /> OK
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-red-500 font-medium">
                                <AlertCircle size={11} /> Error
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-500 font-mono text-[10px] truncate max-w-[120px]">
                            {log.model_used ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-gray-500">{log.message_count ?? '—'}</td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                            {log.duration_ms != null ? (
                              <span className="flex items-center gap-0.5">
                                <Clock size={10} />{(log.duration_ms / 1000).toFixed(1)}s
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2 text-red-400 text-[10px] max-w-[200px] truncate" title={log.error_message ?? ''}>
                            {log.error_message ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>

          <div className="p-4 bg-blue-50 rounded-md border border-blue-200 text-xs text-blue-700">
            <p className="font-semibold mb-1">Sobre los logs de análisis IA</p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>Auto:</strong> disparado en segundo plano cada 5 minutos</li>
              <li><strong>Manual:</strong> disparado por el botón &quot;Analizar con IA&quot; en la conversación</li>
              <li>Se registran tanto los análisis exitosos como los que fallan, con su causa</li>
              <li>Requiere que la migración <code>analysis_logs.sql</code> esté ejecutada en Supabase</li>
            </ul>
          </div>
        </div>
      )}

      {/* ── Tab: Mantenimiento ─────────────────────────────────────────────── */}
      {activeTab === 'maintenance' && (
        <div className="space-y-6">

          {/* Backfill desde Evolution API */}
          <div className="bg-surface rounded-lg border border-border p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-body flex items-center gap-2">
                <RefreshCw size={16} className="text-primary" /> Recuperar conversaciones desde Evolution
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Lee los chats y mensajes de cada instancia desde Evolution API y los upsertea en Supabase.
                Útil cuando N8N estuvo caído o se perdió procesamiento de webhooks.
                <br />
                <span className="text-gray-400">
                  Idempotente: dedupea mensajes por <code className="bg-gray-100 px-1 rounded text-[10px]">external_id</code> y no pisa
                  <code className="bg-gray-100 px-1 rounded text-[10px]">status</code> ni
                  <code className="bg-gray-100 px-1 rounded text-[10px]">client_name</code> de conversaciones existentes.
                </span>
              </p>
            </div>

            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Ventana (días hacia atrás)
                </label>
                <input
                  type="number"
                  min={1}
                  max={730}
                  value={backfillDays}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 1 && v <= 730) setBackfillDays(v)
                  }}
                  disabled={backfilling}
                  className="w-28 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-gray-50"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Hoy {new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ·
                  Trae chats con actividad desde el {new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
                  {' · '}
                  Para instancias nuevas, probá <strong>365</strong> (1 año) o <strong>730</strong> (2 años).
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs text-gray-700 select-none cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={backfillIncludeLid}
                  onChange={e => setBackfillIncludeLid(e.target.checked)}
                  disabled={backfilling}
                  className="rounded border-border"
                />
                <span>
                  Incluir <code className="bg-gray-100 px-1 rounded text-[10px]">@lid</code>
                  <span className="text-gray-400"> (número oculto)</span>
                </span>
              </label>

              <button
                onClick={runBackfill}
                disabled={backfilling}
                className="flex items-center gap-2 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
              >
                {backfilling
                  ? <><Loader2 size={14} className="animate-spin" /> Recuperando… (puede tardar varios min)</>
                  : <><RefreshCw size={14} /> Ejecutar backfill</>
                }
              </button>
            </div>

            {backfillError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{backfillError}</span>
              </div>
            )}

            {backfillResult && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                  <CheckCircle size={14} />
                  <span>
                    Backfill completado · ventana {backfillResult.daysBack} días ·
                    {' '}<strong>{backfillResult.instances}</strong> instancias ·
                    {' '}<strong>{backfillResult.synced}</strong> chats sincronizados ·
                    {' '}<strong>{backfillResult.skipped}</strong> fuera de ventana ·
                    {' '}<strong className={backfillResult.errors > 0 ? 'text-red-600' : ''}>{backfillResult.errors}</strong> errores
                  </span>
                </div>
                {backfillResult.errorLog.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-500 hover:text-body">
                      Ver {backfillResult.errorLog.length} error(es)
                    </summary>
                    <pre className="mt-2 bg-gray-50 border border-border rounded p-2 max-h-48 overflow-auto text-[10px] font-mono">
                      {backfillResult.errorLog.join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* Backfill DB-driven (cuando listChats trae metadata stale) */}
          <div className="bg-surface rounded-lg border border-border p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-body flex items-center gap-2">
                <RefreshCw size={16} className="text-primary" /> Refrescar mensajes de conversaciones existentes
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Alternativa cuando el backfill normal devuelve "0 chats sincronizados". Itera las
                conversaciones que ya tenés en Supabase y, para cada una, le pide a Evolution
                <code className="bg-gray-100 px-1 rounded text-[10px] mx-1">getMessages(jid)</code>
                directamente. Salta el filtro de <code className="bg-gray-100 px-1 rounded text-[10px]">listChats</code>
                de Evolution, que puede estar stale tras una caída.
                <br />
                <span className="text-gray-400">
                  No descubre conversaciones nuevas — las nuevas tienen que entrar por el flujo de N8N.
                </span>
              </p>
            </div>

            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Mensajes por chat
                </label>
                <input
                  type="number"
                  min={10}
                  max={500}
                  step={50}
                  value={dbBackfillMsgs}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 10 && v <= 500) setDbBackfillMsgs(v)
                  }}
                  disabled={dbBackfilling}
                  className="w-28 border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-gray-50"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Cuantos más, más profundo el backfill pero más lento.
                </p>
              </div>

              <button
                onClick={runDbBackfill}
                disabled={dbBackfilling}
                className="flex items-center gap-2 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
              >
                {dbBackfilling
                  ? <><Loader2 size={14} className="animate-spin" /> Refrescando… (puede tardar 5-15 min)</>
                  : <><RefreshCw size={14} /> Refrescar desde conversaciones existentes</>
                }
              </button>
            </div>

            {dbBackfillError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{dbBackfillError}</span>
              </div>
            )}

            {dbBackfillResult && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                  <CheckCircle size={14} />
                  <span>
                    Refresh completado · {dbBackfillResult.messagesPerChat} msgs/chat ·
                    {' '}<strong>{dbBackfillResult.conversationsTried}</strong> conversaciones revisadas ·
                    {' '}<strong>{dbBackfillResult.conversationsUpdated}</strong> con mensajes nuevos ·
                    {' '}<strong>{dbBackfillResult.messagesInserted}</strong> mensajes presentados a Supabase ·
                    {' '}<strong className={dbBackfillResult.errors > 0 ? 'text-red-600' : ''}>{dbBackfillResult.errors}</strong> errores
                  </span>
                </div>
                {dbBackfillResult.errorLog.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-500 hover:text-body">
                      Ver {dbBackfillResult.errorLog.length} error(es)
                    </summary>
                    <pre className="mt-2 bg-gray-50 border border-border rounded p-2 max-h-48 overflow-auto text-[10px] font-mono">
                      {dbBackfillResult.errorLog.join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* Archivar todo */}
          <div className="bg-surface rounded-lg border border-border p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-body flex items-center gap-2">
                <Archive size={16} className="text-amber-500" /> Archivar todas las conversaciones
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Mueve <strong>todas</strong> las conversaciones activas al Histórico de una vez.
              </p>
            </div>

            {archAllError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{archAllError}</p>
            )}

            {archAllResult && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <CheckCircle size={15} />
                Se archivaron <strong>{archAllResult.archived}</strong> conversación{archAllResult.archived !== 1 ? 'es' : ''} correctamente.
              </div>
            )}

            {!archAllConfirm && !archAllResult && (
              <button
                onClick={() => setArchAllConfirm(true)}
                className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors"
              >
                <Archive size={14} /> Archivar todo
              </button>
            )}

            {archAllConfirm && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
                <p className="text-sm font-semibold text-amber-800">
                  ¿Confirmás archivar todas las conversaciones activas?
                </p>
                <p className="text-xs text-amber-700">
                  Se moverán al Histórico. Podés restaurarlas desde la página de Histórico.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={executeArchiveAll}
                    disabled={archAllWorking}
                    className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
                  >
                    {archAllWorking ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
                    {archAllWorking ? 'Archivando...' : 'Sí, archivar todo'}
                  </button>
                  <button
                    onClick={() => setArchAllConfirm(false)}
                    className="text-sm text-gray-500 hover:text-body border border-border px-3 py-2 rounded-md transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Archivo masivo a Histórico */}
          <div className="bg-surface rounded-lg border border-border p-5 space-y-5">
            <div>
              <h3 className="font-semibold text-body flex items-center gap-2">
                <Archive size={16} className="text-primary" /> Archivar conversaciones en lote
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                Mueve conversaciones activas al Histórico según las condiciones que elijas. Usá Vista previa antes de archivar.
              </p>
            </div>

            {/* Condiciones */}
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted flex items-center gap-1.5">
                <Filter size={11} /> Condiciones (se combinan con AND)
              </p>

              {/* No respondida por el cliente */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={archUnrespondedClient}
                  onChange={e => setArchUnrespondedClient(e.target.checked)}
                  className="mt-0.5 accent-primary"
                />
                <div>
                  <span className="text-sm font-medium text-body group-hover:text-primary transition-colors">
                    Sin respuesta del cliente
                  </span>
                  <p className="text-xs text-gray-400">El último mensaje fue enviado por el vendedor (cliente no respondió)</p>
                </div>
              </label>

              {/* Menos de N mensajes */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={archMaxMessages !== ''}
                    onChange={e => setArchMaxMessages(e.target.checked ? '5' : '')}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium text-body">Con menos de</span>
                </div>
                <input
                  type="number"
                  min={1}
                  value={archMaxMessages}
                  onChange={e => setArchMaxMessages(e.target.value)}
                  disabled={archMaxMessages === ''}
                  placeholder="5"
                  className="w-16 border border-border rounded-md px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40"
                />
                <span className="text-sm text-body">mensajes</span>
              </div>

              {/* Sin actividad hace N días */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={archMinInactiveDays !== ''}
                    onChange={e => setArchMinInactiveDays(e.target.checked ? '30' : '')}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium text-body">Sin actividad hace más de</span>
                </div>
                <input
                  type="number"
                  min={1}
                  value={archMinInactiveDays}
                  onChange={e => setArchMinInactiveDays(e.target.value)}
                  disabled={archMinInactiveDays === ''}
                  placeholder="30"
                  className="w-16 border border-border rounded-md px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40"
                />
                <span className="text-sm text-body">días</span>
              </div>

              {/* Rango de fechas (last_message_at) */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-body">Rango de fecha de último mensaje</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-8">Desde</span>
                    <input
                      type="date"
                      value={archDateFrom}
                      onChange={e => setArchDateFrom(e.target.value)}
                      className="border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted w-8">Hasta</span>
                    <input
                      type="date"
                      value={archDateTo}
                      onChange={e => setArchDateTo(e.target.value)}
                      className="border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  {(archDateFrom || archDateTo) && (
                    <button
                      onClick={() => { setArchDateFrom(''); setArchDateTo('') }}
                      className="text-xs text-gray-400 hover:text-body"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Error */}
            {archError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {archError}
              </p>
            )}

            {/* Resultado de ejecución */}
            {archResult && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <CheckCircle size={15} />
                Se archivaron <strong>{archResult.archived}</strong> conversación{archResult.archived !== 1 ? 'es' : ''} correctamente.
              </div>
            )}

            {/* Botón Vista previa */}
            {!archConfirm && (
              <button
                onClick={previewArchive}
                disabled={archWorking}
                className="flex items-center gap-2 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50"
              >
                {archWorking ? <Loader2 size={14} className="animate-spin" /> : <Filter size={14} />}
                {archWorking ? 'Calculando...' : 'Vista previa'}
              </button>
            )}

            {/* Preview de resultados */}
            {archCount !== null && archPreview !== null && !archConfirm && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-body">
                    {archCount === 0
                      ? 'Ninguna conversación cumple las condiciones'
                      : <>Se archivarían <span className="text-primary">{archCount}</span> conversación{archCount !== 1 ? 'es' : ''}</>
                    }
                  </p>
                  {archCount > 0 && (
                    <button
                      onClick={() => setArchConfirm(true)}
                      className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-3 py-1.5 rounded-md transition-colors"
                    >
                      <Archive size={13} /> Archivar ahora
                    </button>
                  )}
                </div>

                {archPreview.length > 0 && (
                  <div className="border border-border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-bg border-b border-border sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted font-medium">Nombre / Teléfono</th>
                          <th className="text-left px-3 py-2 text-muted font-medium">Mensajes</th>
                          <th className="text-left px-3 py-2 text-muted font-medium">Último mensaje</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {archPreview.map(row => (
                          <tr key={row.id} className="hover:bg-bg">
                            <td className="px-3 py-2">
                              <p className="font-medium text-body truncate max-w-[200px]">{row.name}</p>
                              <p className="text-gray-400">{row.client_phone}</p>
                            </td>
                            <td className="px-3 py-2 text-gray-500">{row.message_count}</td>
                            <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                              {row.last_message_at
                                ? new Date(row.last_message_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' })
                                : '—'}
                            </td>
                          </tr>
                        ))}
                        {archCount > 50 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-2 text-center text-gray-400">
                              … y {archCount - 50} más
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Confirmación final */}
            {archConfirm && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 space-y-3">
                <p className="text-sm font-semibold text-amber-800">
                  ¿Confirmás archivar {archCount} conversación{archCount !== 1 ? 'es' : ''}?
                </p>
                <p className="text-xs text-amber-700">
                  Se moverán al Histórico. Podés restaurarlas desde la página de Histórico.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={executeArchive}
                    disabled={archWorking}
                    className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50 transition-colors"
                  >
                    {archWorking ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
                    {archWorking ? 'Archivando...' : 'Sí, archivar'}
                  </button>
                  <button
                    onClick={() => setArchConfirm(false)}
                    className="text-sm text-gray-500 hover:text-body border border-border px-3 py-2 rounded-md transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="p-4 bg-blue-50 rounded-md border border-blue-200 text-xs text-blue-700">
            <p className="font-semibold mb-1">Sobre el archivo en lote</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Solo afecta conversaciones en estado <strong>Activa</strong></li>
              <li>Las conversaciones archivadas se pueden restaurar desde <strong>Histórico</strong></li>
              <li>Las condiciones se combinan: se archivan conversaciones que cumplen <strong>todas</strong> las seleccionadas</li>
              <li>Usá <strong>Vista previa</strong> siempre antes de ejecutar</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
