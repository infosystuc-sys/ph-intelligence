'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import KpiCard from '@/components/ui/KpiCard'
import ScoreBadge, { getScoreRowClass } from '@/components/ui/ScoreBadge'
import VendorAvatar from '@/components/ui/VendorAvatar'
import { SkeletonCard, SkeletonTable } from '@/components/ui/LoadingSkeleton'
import { DashboardStats, User } from '@/types'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import {
  Star,
  AlertCircle,
  TrendingUp,
  Layers,
  BarChart2,
  ArrowUpDown,
  Wifi,
  WifiOff,
  ChevronUp,
  ChevronDown,
  CreditCard,
  MessageSquarePlus,
} from 'lucide-react'

interface VendorRow {
  id: string
  full_name: string
  avatar_url: string | null
  avg_quality_score: number
  conversations_total: number
  conversations_unresponded_24h: number
  pipeline_majority: string
  trend: number
  matches_total: number
  whatsapp_instance?: { id: string; status: string; phone_number?: string | null }
}

type SortKey = 'full_name' | 'avg_quality_score' | 'conversations_total' | 'conversations_unresponded_24h' | 'matches_total'
type SortDir = 'asc' | 'desc'

interface InitiatedRow {
  vendedor_id:   string
  vendedor_name: string
  initiated:     number
  responded:     number
}

// La métrica de iniciadas existe desde esta fecha (acordado 11/6/2026)
const INITIATED_MIN_DATE = '2026-06-01'

// Día actual en Argentina como YYYY-MM-DD — los buckets diarios usan ese huso
function todayAR(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
}

const stageLabel: Record<string, string> = {
  new: 'Nuevo',
  negotiation: 'Negociación',
  proposal: 'Propuesta',
  closed_won: 'Ganado',
  closed_lost: 'Perdido',
}

export default function DashboardPage() {
  const router = useRouter()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [vendors, setVendors] = useState<VendorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('avg_quality_score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Conversaciones iniciadas por vendedor (día seleccionado, en vivo)
  const [initDay, setInitDay] = useState(todayAR())
  const [initRows, setInitRows] = useState<InitiatedRow[]>([])
  const [initLoading, setInitLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)
  const initDayRef = useRef(initDay)
  initDayRef.current = initDay

  useEffect(() => {
    loadDashboard()
  }, [])

  const loadInitiatedStats = async (day: string, silent = false) => {
    if (!silent) setInitLoading(true)
    try {
      const res = await fetch(`/api/dashboard/vendor-initiated?from=${day}&to=${day}`)
      const data = await res.json()
      if (!res.ok || data?.error) {
        setInitError(data?.error ?? `HTTP ${res.status}`)
        setInitRows([])
      } else {
        setInitError(null)
        setInitRows((data.rows ?? []) as InitiatedRow[])
      }
    } catch (e) {
      setInitError(e instanceof Error ? e.message : 'Error de conexión')
    } finally {
      if (!silent) setInitLoading(false)
    }
  }

  // Carga inicial + recarga al cambiar el día seleccionado
  useEffect(() => {
    loadInitiatedStats(initDay)
  }, [initDay])

  // Tiempo real: cada INSERT en messages refresca los números (debounce 3s para
  // no spamear con ráfagas). Fallback: refresco cada 60s por si Realtime se cae.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient()
    let debounce: ReturnType<typeof setTimeout> | null = null

    const channel = supabase
      .channel('dashboard-initiated-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
        // Solo refrescar si estamos mirando el día de hoy — los días pasados no cambian
        if (initDayRef.current !== todayAR()) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => loadInitiatedStats(initDayRef.current, true), 3000)
      })
      .subscribe()

    const interval = setInterval(() => {
      if (initDayRef.current === todayAR()) loadInitiatedStats(initDayRef.current, true)
    }, 60_000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(interval)
      if (debounce) clearTimeout(debounce)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadDashboard = async () => {
    setLoading(true)
    try {
      const [kpisRes, vendorsRes, baseRes] = await Promise.all([
        fetch('/api/kpis'),
        fetch('/api/vendors'),
        fetch('/api/base-clientes/stats'),
      ])
      const kpisData    = await kpisRes.json()
      const vendorsData = await vendorsRes.json()

      setStats(kpisData)

      // Matches por vendedor desde el endpoint de base-clientes (sin filtrar por localidad).
      // Si falla, sigue todo OK con matches_total en 0.
      const matchesByVendor: Record<string, number> = {}
      try {
        const baseData = await baseRes.json()
        if (baseRes.ok && Array.isArray(baseData?.por_vendedor)) {
          for (const v of baseData.por_vendedor as Array<{ vendedor_id: string; matches_total?: number }>) {
            matchesByVendor[v.vendedor_id] = v.matches_total ?? 0
          }
        }
      } catch (e) {
        console.error('[base-clientes/stats] error cargando matches por vendedor:', e)
      }

      // Construir rows de vendedores cruzando KPIs
      const kpisByVendor: Record<string, typeof kpisData.kpis_by_vendor[0]> = {}
      ;(kpisData.kpis_by_vendor ?? []).forEach((k: { vendedor_id: string; avg_quality_score: number; conversations_total: number; conversations_unresponded_24h: number }) => {
        kpisByVendor[k.vendedor_id] = k
      })

      const rows: VendorRow[] = (vendorsData.data ?? []).map((v: User & { whatsapp_instance?: { id: string; status: string; phone_number?: string | null }, daily_kpis?: { avg_quality_score: number; conversations_total: number; conversations_unresponded_24h: number; date: string }[] }) => {
        const kpi = kpisByVendor[v.id]
        const recentKpis = (v.daily_kpis ?? []).sort((a, b) => b.date.localeCompare(a.date))
        const prevKpi = recentKpis[1]
        const trend = kpi && prevKpi
          ? Math.round(kpi.avg_quality_score - prevKpi.avg_quality_score)
          : 0

        return {
          id: v.id,
          full_name: v.full_name,
          avatar_url: v.avatar_url,
          avg_quality_score: kpi?.avg_quality_score ?? 0,
          conversations_total: kpi?.conversations_total ?? 0,
          conversations_unresponded_24h: kpi?.conversations_unresponded_24h ?? 0,
          pipeline_majority: 'new',
          trend,
          matches_total: matchesByVendor[v.id] ?? 0,
          whatsapp_instance: v.whatsapp_instance ?? undefined,
        }
      })

      setVendors(rows)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      // Verificar estado real de instancias contra Evolution API en segundo plano
      refreshInstanceStatuses()
    }
  }

  // Consulta el estado live de cada instancia y actualiza la UI sin bloquear la carga
  const refreshInstanceStatuses = async () => {
    setRefreshingStatus(true)
    try {
      const res = await fetch('/api/instances/refresh-status', { method: 'POST' })
      if (!res.ok) return
      const { results } = await res.json() as {
        results: { instanceId: string; connected: boolean; state: string }[]
      }

      if (!results?.length) return

      const statusMap = Object.fromEntries(results.map(r => [r.instanceId, r.connected]))

      // Actualizar status en los vendor rows
      setVendors(prev => prev.map(v => {
        if (!v.whatsapp_instance?.id) return v
        const connected = statusMap[v.whatsapp_instance.id]
        if (connected === undefined) return v
        return {
          ...v,
          whatsapp_instance: {
            ...v.whatsapp_instance,
            status: connected ? 'connected' : 'disconnected',
          },
        }
      }))

      // Actualizar contador de instancias conectadas en stats
      const connectedCount = results.filter(r => r.connected).length
      setStats(prev => prev ? { ...prev, connected_instances: connectedCount } : prev)
    } catch {
      // silencioso — el usuario ya ve los datos de DB
    } finally {
      setRefreshingStatus(false)
    }
  }

  const sortedVendors = useMemo(() => [...vendors].sort((a, b) => {
    const aVal = a[sortKey]
    const bVal = b[sortKey]
    const dir = sortDir === 'asc' ? 1 : -1
    if (typeof aVal === 'string') return aVal.localeCompare(bVal as string) * dir
    return ((aVal as number) - (bVal as number)) * dir
  }), [vendors, sortKey, sortDir])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const scoreDiff = stats
    ? Math.round((stats.avg_quality_score - stats.avg_quality_score_prev) * 10) / 10
    : 0

  // Merge: mostrar TODOS los vendedores del equipo, con 0 si no iniciaron nada
  const mergedInitiated = useMemo(() => {
    const statsById = new Map(initRows.map(r => [r.vendedor_id, r]))
    const merged = vendors.map(v => {
      const s = statsById.get(v.id)
      return {
        vendedor_id:   v.id,
        vendedor_name: v.full_name,
        avatar_url:    v.avatar_url,
        phone_number:  v.whatsapp_instance?.phone_number ?? null,
        initiated:     s?.initiated ?? 0,
        responded:     s?.responded ?? 0,
      }
    })
    // Sumar vendedores que aparecen en stats pero no están en la lista (borde raro)
    for (const r of initRows) {
      if (!merged.some(m => m.vendedor_id === r.vendedor_id)) {
        merged.push({ ...r, avatar_url: null, phone_number: null })
      }
    }
    merged.sort((a, b) => b.initiated - a.initiated)
    return merged
  }, [vendors, initRows])

  const totInitiated = useMemo(() => mergedInitiated.reduce((s, r) => s + r.initiated, 0), [mergedInitiated])
  const totResponded = useMemo(() => mergedInitiated.reduce((s, r) => s + r.responded, 0), [mergedInitiated])
  const pct = (i: number, r: number) => i > 0 ? Math.round((r / i) * 100) : 0

  // Navega a Conversaciones mostrando exactamente las conversaciones detrás de
  // un número de la tabla de iniciadas (vendedorId null = fila "Total" → todos).
  const goToInitiated = (vendedorId: string | null, vendedorName: string, responded: boolean) => {
    const params = new URLSearchParams({ initiatedDay: initDay, initiatedVendorName: vendedorName })
    if (vendedorId) params.set('initiatedVendor', vendedorId)
    if (responded) params.set('initiatedResponded', 'true')
    router.push(`/conversations?${params.toString()}`)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-body">Dashboard</h1>
          <p className="text-sm text-muted mt-0.5">
            Visión general del equipo · {new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {stats ? (
            <span className={`flex items-center gap-1.5 ${
              refreshingStatus ? 'text-gray-400' : stats.connected_instances > 0 ? 'text-green-600' : 'text-red-500'
            }`}>
              {refreshingStatus
                ? <span className="w-3 h-3 rounded-full border-2 border-gray-300 border-t-gray-500 animate-spin shrink-0" />
                : stats.connected_instances > 0 ? <Wifi size={14} /> : <WifiOff size={14} />
              }
              {stats.connected_instances}/{stats.total_instances} online
            </span>
          ) : null}
        </div>
      </div>

      {/* KPI Cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          <KpiCard
            title="Score de Calidad Promedio"
            value={`${stats?.avg_quality_score ?? 0}/100`}
            icon={<Star size={18} />}
            trend={scoreDiff}
            trendLabel={`${scoreDiff > 0 ? '+' : ''}${scoreDiff} vs semana ant.`}
          />
          <KpiCard
            title="Sin Respuesta +24hs"
            value={stats?.unresponded_24h ?? 0}
            icon={<AlertCircle size={18} />}
            alert={(stats?.unresponded_24h ?? 0) > 0}
            alertLabel="Requiere atención"
            onClick={() => router.push('/conversations?unresponded=true')}
          />
          <KpiCard
            title="Conversiones Estimadas"
            value={stats?.estimated_conversions ?? 0}
            icon={<TrendingUp size={18} />}
          />
          <KpiCard
            title="Pipeline Activo"
            value={stats?.active_conversations ?? 0}
            icon={<Layers size={18} />}
          />
          <KpiCard
            title="Índice de Mejora"
            value={`${stats?.vendors_improved ?? 0} ↑ / ${stats?.vendors_declined ?? 0} ↓`}
            icon={<BarChart2 size={18} />}
          />
        </div>
      )}

      {/* Conversaciones iniciadas por vendedor (día seleccionado, en vivo) */}
      <div className="bg-surface rounded-lg shadow-sm border border-border overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-semibold text-body flex items-center gap-2">
              <MessageSquarePlus size={16} className="text-primary" />
              Conversaciones iniciadas por vendedor
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Conversaciones nuevas (o dormidas +10 días) que el vendedor inició en el día,
              y cuántas recibieron respuesta del cliente ese mismo día.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {initDay === todayAR() && (
              <span className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                En vivo
              </span>
            )}
            <input
              type="date"
              value={initDay}
              min={INITIATED_MIN_DATE}
              max={todayAR()}
              onChange={e => { if (e.target.value) setInitDay(e.target.value) }}
              className="text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {initError ? (
          <div className="px-5 py-4 text-sm text-red-600 bg-red-50">
            {initError}
          </div>
        ) : initLoading ? (
          <SkeletonTable rows={4} />
        ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg border-b border-border text-xs font-semibold text-muted uppercase tracking-wide">
                    <th className="text-left px-4 py-2.5">Vendedor</th>
                    <th className="text-left px-4 py-2.5">Teléfono</th>
                    <th className="text-right px-4 py-2.5">Iniciadas</th>
                    <th className="text-right px-4 py-2.5">Con respuesta</th>
                    <th className="text-left px-4 py-2.5 w-44">% Respuesta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mergedInitiated.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">Sin datos para este día</td></tr>
                  ) : mergedInitiated.map(r => (
                    <tr key={r.vendedor_id} className="hover:bg-bg">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <VendorAvatar vendor={{ full_name: r.vendedor_name, avatar_url: r.avatar_url }} size="sm" />
                          <span className="font-medium text-body">{r.vendedor_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-muted">{r.phone_number ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-body">
                        {r.initiated > 0 ? (
                          <button onClick={() => goToInitiated(r.vendedor_id, r.vendedor_name, false)} className="hover:underline hover:text-primary">
                            {r.initiated}
                          </button>
                        ) : r.initiated}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-green-700">
                        {r.responded > 0 ? (
                          <button onClick={() => goToInitiated(r.vendedor_id, r.vendedor_name, true)} className="hover:underline">
                            {r.responded}
                          </button>
                        ) : r.responded}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${
                                pct(r.initiated, r.responded) >= 50 ? 'bg-green-600'
                                : pct(r.initiated, r.responded) >= 25 ? 'bg-yellow-500'
                                : 'bg-red-400'
                              }`}
                              style={{ width: `${pct(r.initiated, r.responded)}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium text-gray-600 w-9 text-right">
                            {r.initiated > 0 ? `${pct(r.initiated, r.responded)}%` : '—'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {mergedInitiated.length > 0 && (
                  <tfoot>
                    <tr className="bg-bg border-t border-border font-semibold">
                      <td className="px-4 py-2.5 text-body">Total</td>
                      <td className="px-4 py-2.5" />
                      <td className="px-4 py-2.5 text-right text-body">
                        {totInitiated > 0 ? (
                          <button onClick={() => goToInitiated(null, 'Todos los vendedores', false)} className="hover:underline hover:text-primary">
                            {totInitiated}
                          </button>
                        ) : totInitiated}
                      </td>
                      <td className="px-4 py-2.5 text-right text-green-700">
                        {totResponded > 0 ? (
                          <button onClick={() => goToInitiated(null, 'Todos los vendedores', true)} className="hover:underline">
                            {totResponded}
                          </button>
                        ) : totResponded}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-600">
                        {totInitiated > 0 ? `${pct(totInitiated, totResponded)}%` : '—'}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
      </div>

      {/* Tabla de vendedores */}
      <div className="bg-surface rounded-lg shadow-sm border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-body">Equipo de Vendedores</h2>
          <button
            onClick={() => router.push('/vendors')}
            className="text-sm text-primary hover:text-primary-dark font-medium"
          >
            Ver todos →
          </button>
        </div>

        {loading ? (
          <SkeletonTable rows={6} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg border-b border-border text-xs font-semibold text-muted uppercase tracking-wide">
                  <th className="text-left px-4 py-3">
                    <button onClick={() => handleSort('full_name')} className="flex items-center gap-1 hover:text-primary">
                      Vendedor <ArrowUpDown size={12} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3">
                    <button onClick={() => handleSort('avg_quality_score')} className="flex items-center gap-1 hover:text-primary">
                      Score IA <ArrowUpDown size={12} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3">
                    <button onClick={() => handleSort('conversations_total')} className="flex items-center gap-1 hover:text-primary">
                      Conv. activas <ArrowUpDown size={12} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3">
                    <button onClick={() => handleSort('conversations_unresponded_24h')} className="flex items-center gap-1 hover:text-primary">
                      Sin resp. <ArrowUpDown size={12} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3">
                    <button onClick={() => handleSort('matches_total')} className="flex items-center gap-1 hover:text-primary">
                      Matches <ArrowUpDown size={12} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3">Tendencia</th>
                  <th className="text-left px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedVendors.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted">
                      No hay vendedores configurados aún
                    </td>
                  </tr>
                ) : (
                  sortedVendors.map(vendor => (
                    <tr
                      key={vendor.id}
                      className={`hover:bg-bg transition-colors cursor-pointer ${getScoreRowClass(vendor.avg_quality_score)}`}
                      onClick={() => router.push(`/vendors/${vendor.id}`)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <VendorAvatar vendor={{ full_name: vendor.full_name, avatar_url: vendor.avatar_url }} size="sm" />
                          <span className="font-medium text-body">{vendor.full_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <ScoreBadge score={Math.round(vendor.avg_quality_score)} size="sm" />
                          <div className="w-16 bg-gray-100 rounded-full h-1.5">
                            <div
                              className="h-1.5 rounded-full bg-primary"
                              style={{ width: `${vendor.avg_quality_score}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{vendor.conversations_total}</td>
                      <td className="px-4 py-3">
                        <span className={vendor.conversations_unresponded_24h > 0 ? 'text-primary font-semibold' : 'text-muted'}>
                          {vendor.conversations_unresponded_24h}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
                          <CreditCard size={12} />
                          {vendor.matches_total.toLocaleString('es-AR')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {vendor.trend > 0 ? (
                          <span className="flex items-center gap-1 text-green-600 text-xs font-medium">
                            <ChevronUp size={14} /> +{vendor.trend}
                          </span>
                        ) : vendor.trend < 0 ? (
                          <span className="flex items-center gap-1 text-red-500 text-xs font-medium">
                            <ChevronDown size={14} /> {vendor.trend}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={e => { e.stopPropagation(); router.push(`/vendors/${vendor.id}`) }}
                          className="text-xs text-primary hover:text-primary-dark font-medium border border-primary hover:border-primary-dark px-2 py-1 rounded transition-colors"
                        >
                          Ver detalle
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
