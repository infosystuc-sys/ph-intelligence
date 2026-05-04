'use client'

import { useEffect, useState, useCallback } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { Conversation } from '@/types'
import ScoreBadge from '@/components/ui/ScoreBadge'
import VendorAvatar from '@/components/ui/VendorAvatar'
import { Archive, RefreshCw, RotateCcw, Trash2, Loader2, Search, CheckSquare, Check, Users, CreditCard } from 'lucide-react'
import { formatPhone, formatDistanceToNow } from '@/lib/utils'

export default function HistoricoPage() {
  const supabase = createBrowserSupabaseClient()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [userRole, setUserRole] = useState('')

  // Selección múltiple
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  // Acciones individuales
  const [working, setWorking] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const loadConversations = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/conversations?status=historico&limit=200')
    const data = await res.json()
    setConversations(data.data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    loadConversations()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('users').select('role').eq('id', user.id).single()
        .then(({ data }) => { if (data) setUserRole(data.role) })
    })
  }, [loadConversations, supabase])

  const canManage = ['admin', 'supervisor'].includes(userRole)

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

  const restoreOne = async (id: string) => {
    setWorking(id)
    await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], status: 'active' }),
    })
    setConversations(prev => prev.filter(c => c.id !== id))
    setWorking(null)
    setConfirmDelete(null)
  }

  const deleteOne = async (id: string) => {
    setWorking(id)
    await fetch('/api/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
    setConversations(prev => prev.filter(c => c.id !== id))
    setWorking(null)
    setConfirmDelete(null)
  }

  const handleBulkRestore = async () => {
    setBulkWorking(true)
    await fetch('/api/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds], status: 'active' }),
    })
    setConversations(prev => prev.filter(c => !selectedIds.has(c.id)))
    exitSelectionMode()
    setBulkWorking(false)
  }

  const handleBulkDelete = async () => {
    setBulkWorking(true)
    await fetch('/api/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds] }),
    })
    setConversations(prev => prev.filter(c => !selectedIds.has(c.id)))
    exitSelectionMode()
    setBulkWorking(false)
  }

  const isGroup = (c: Conversation) => c.remote_jid?.endsWith('@g.us') ?? false

  const filtered = conversations.filter(c => {
    if (!search) return true
    const q = search.toLowerCase()
    const name = c.display_name ?? c.client_name ?? ''
    return (
      name.toLowerCase().includes(q) ||
      c.client_phone.toLowerCase().includes(q) ||
      (c.vendedor?.full_name ?? '').toLowerCase().includes(q)
    )
  })

  const latestScore = (conv: Conversation): number | null => {
    const arr = Array.isArray(conv.ai_analysis)
      ? conv.ai_analysis
      : conv.ai_analysis ? [conv.ai_analysis] : []
    const sorted = (arr as Array<{ quality_score: number; analyzed_at: string }>)
      .sort((a, b) => new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime())
    return sorted[0]?.quality_score ?? null
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-body flex items-center gap-2">
            <Archive size={22} className="text-primary" /> Histórico
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Conversaciones archivadas. No se incluyen en análisis automáticos.
          </p>
        </div>
        <button
          onClick={loadConversations}
          disabled={loading}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-body border border-border rounded-md px-3 py-1.5 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {/* Toolbar de selección */}
      {canManage && selectionMode && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-primary">
              {selectedIds.size} seleccionada{selectedIds.size !== 1 ? 's' : ''}
            </span>
            <button onClick={exitSelectionMode} className="text-xs text-gray-400 hover:text-body">
              Cancelar selección
            </button>
          </div>
          {!confirmBulkDelete ? (
            <div className="flex gap-2">
              <button
                onClick={handleBulkRestore}
                disabled={!selectedIds.size || bulkWorking}
                className="flex items-center gap-1.5 text-sm bg-green-600 hover:bg-green-700 text-white font-medium px-3 py-1.5 rounded disabled:opacity-40 transition-colors"
              >
                {bulkWorking ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                Volver a Activas
              </button>
              <button
                onClick={() => setConfirmBulkDelete(true)}
                disabled={!selectedIds.size || bulkWorking}
                className="flex items-center gap-1.5 text-sm bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1.5 rounded disabled:opacity-40 transition-colors"
              >
                <Trash2 size={13} /> Eliminar
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-sm text-red-600 font-medium">
                ¿Eliminar {selectedIds.size} conversación{selectedIds.size !== 1 ? 'es' : ''} permanentemente?
              </p>
              <button
                onClick={handleBulkDelete}
                disabled={bulkWorking}
                className="text-sm bg-red-600 hover:bg-red-700 text-white font-semibold px-3 py-1 rounded disabled:opacity-50"
              >
                {bulkWorking ? <Loader2 size={13} className="animate-spin" /> : 'Sí, eliminar'}
              </button>
              <button onClick={() => setConfirmBulkDelete(false)} className="text-sm text-gray-500 hover:text-body">
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}

      {/* Barra de búsqueda + botón seleccionar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre, teléfono o vendedor..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        {canManage && !selectionMode && (
          <button
            onClick={() => setSelectionMode(true)}
            className="flex items-center gap-1.5 text-sm border border-border text-gray-500 hover:text-primary hover:border-primary/40 px-3 py-2 rounded-md transition-colors whitespace-nowrap"
          >
            <CheckSquare size={14} /> Seleccionar
          </button>
        )}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 text-gray-400 py-16">
          <Loader2 size={18} className="animate-spin" /> Cargando histórico...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-gray-400 py-16">
          <Archive size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{search ? 'Sin resultados para la búsqueda' : 'No hay conversaciones en el histórico'}</p>
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-border divide-y divide-border overflow-hidden">
          {filtered.map(conv => {
            const displayName = conv.display_name ?? conv.client_name ?? conv.client_phone
            const score = latestScore(conv)
            const isChecked = selectedIds.has(conv.id)
            const isWorking = working === conv.id
            const group = isGroup(conv)

            return (
              <div
                key={conv.id}
                onClick={selectionMode ? () => toggleSelection(conv.id) : undefined}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  selectionMode ? 'cursor-pointer hover:bg-bg' : ''
                } ${selectionMode && isChecked ? 'bg-primary/5' : ''}`}
              >
                {/* Checkbox */}
                {selectionMode && (
                  <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${
                    isChecked ? 'bg-primary border-primary' : 'border-gray-300 bg-white'
                  }`}>
                    {isChecked && <Check size={10} className="text-white" />}
                  </div>
                )}

                {/* Avatar */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                  group ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-600'
                }`}>
                  {group ? <Users size={16} /> : displayName.charAt(0).toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-body truncate">{displayName}</span>
                    {score !== null && <ScoreBadge score={score} size="sm" />}
                    {conv.base_source && (
                      <span className={`flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                        conv.base_source === 'cancela_renueva'
                          ? 'bg-teal-100 text-teal-700'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        <CreditCard size={9} />
                        {conv.base_source === 'cancela_renueva'
                          ? 'C&R'
                          : conv.cod_cliente ? `#${conv.cod_cliente}` : 'Naranja'}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    {formatPhone(conv.client_phone)}
                    {conv.vendedor && (
                      <span className="ml-2 flex items-center gap-1 inline-flex">
                        · <VendorAvatar vendor={conv.vendedor} size="sm" />
                        {conv.vendedor.full_name.split(' ')[0]}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {conv.message_count} mensajes
                    {conv.last_message_at && ` · último: ${formatDistanceToNow(new Date(conv.last_message_at))}`}
                  </p>
                </div>

                {/* Acciones (ocultas en modo selección) */}
                {!selectionMode && canManage && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => restoreOne(conv.id)}
                      disabled={isWorking}
                      title="Volver a activas"
                      className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 font-medium border border-green-200 hover:border-green-400 px-2 py-1 rounded transition-colors disabled:opacity-40"
                    >
                      {isWorking ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Restaurar
                    </button>

                    {confirmDelete === conv.id ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-red-500">¿Eliminar?</span>
                        <button
                          onClick={() => deleteOne(conv.id)}
                          disabled={isWorking}
                          className="text-xs text-red-600 font-semibold hover:text-red-700 disabled:opacity-50"
                        >
                          Sí
                        </button>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-gray-400 hover:text-body">
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(conv.id)}
                        title="Eliminar permanentemente"
                        className="text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-gray-400 text-center">
          {filtered.length} conversación{filtered.length !== 1 ? 'es' : ''} en el histórico
        </p>
      )}
    </div>
  )
}
