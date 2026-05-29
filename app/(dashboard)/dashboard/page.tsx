'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import KpiCard from '@/components/ui/KpiCard'
import ScoreBadge, { getScoreRowClass } from '@/components/ui/ScoreBadge'
import VendorAvatar from '@/components/ui/VendorAvatar'
import { SkeletonCard, SkeletonTable } from '@/components/ui/LoadingSkeleton'
import { DashboardStats, User } from '@/types'
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
  Users,
  MapPin,
  CheckCircle2,
  AlertTriangle,
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
  whatsapp_instance?: { id: string; status: string }
}

interface BaseStats {
  totales: {
    filas_csv:            number
    clientes_unicos:      number
    localidades:          number
    vendedores_total:     number
    vendedores_con_base:  number
    cobertura_global_pct: number
    clientes_asignados:   number
    clientes_contactados: number
  }
  por_vendedor: Array<{
    vendedor_id:          string
    full_name:            string
    localidad:            string | null
    clientes_asignados:   number
    clientes_contactados: number
    clientes_pendientes:  number
    cobertura_pct:        number
    matched_localidad:    boolean
  }>
  localidades_sin_vendedor: Array<{ localidad: string; clientes_unicos: number }>
}

type SortKey = 'full_name' | 'avg_quality_score' | 'conversations_total' | 'conversations_unresponded_24h'
type SortDir = 'asc' | 'desc'

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
  const [baseStats, setBaseStats] = useState<BaseStats | null>(null)
  const [baseStatsError, setBaseStatsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('avg_quality_score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    loadDashboard()
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

      // Base-clientes stats — exponer error en pantalla si falla (no romper el dashboard)
      try {
        const baseData = await baseRes.json()
        if (!baseRes.ok || baseData?.error) {
          const msg = baseData?.error ?? `HTTP ${baseRes.status}`
          console.error('[base-clientes/stats] error:', msg, baseData)
          setBaseStatsError(msg)
        } else {
          setBaseStats(baseData)
          setBaseStatsError(null)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error parseando respuesta'
        console.error('[base-clientes/stats] excepción:', e)
        setBaseStatsError(msg)
      }

      // Construir rows de vendedores cruzando KPIs
      const kpisByVendor: Record<string, typeof kpisData.kpis_by_vendor[0]> = {}
      ;(kpisData.kpis_by_vendor ?? []).forEach((k: { vendedor_id: string; avg_quality_score: number; conversations_total: number; conversations_unresponded_24h: number }) => {
        kpisByVendor[k.vendedor_id] = k
      })

      const rows: VendorRow[] = (vendorsData.data ?? []).map((v: User & { whatsapp_instance?: { id: string; status: string }, daily_kpis?: { avg_quality_score: number; conversations_total: number; conversations_unresponded_24h: number; date: string }[] }) => {
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

  const sortedVendors = [...vendors].sort((a, b) => {
    const aVal = a[sortKey]
    const bVal = b[sortKey]
    const dir = sortDir === 'asc' ? 1 : -1
    if (typeof aVal === 'string') return aVal.localeCompare(bVal as string) * dir
    return ((aVal as number) - (bVal as number)) * dir
  })

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
            onClick={() => router.push('/conversations?status=active')}
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

      {/* Base de Clientes — cobertura por vendedor */}
      {baseStatsError && !baseStats && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
          <div className="font-semibold mb-1">No se pudo cargar estadísticas de Base de Clientes</div>
          <div className="font-mono text-xs">{baseStatsError}</div>
        </div>
      )}
      {baseStats && (
        <div className="bg-surface rounded-lg shadow-sm border border-border overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-body">Base de Clientes</h2>
              <p className="text-xs text-muted mt-0.5">
                Cobertura del CSV asignado a cada vendedor por localidad
              </p>
            </div>
            <button
              onClick={() => router.push('/base-clientes')}
              className="text-sm text-primary hover:text-primary-dark font-medium"
            >
              Ver base →
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
            <div className="bg-surface p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
                <Users size={12} /> Clientes únicos
              </div>
              <div className="text-2xl font-bold text-body">
                {baseStats.totales.clientes_unicos.toLocaleString('es-AR')}
              </div>
              <div className="text-xs text-muted mt-0.5">
                {baseStats.totales.filas_csv.toLocaleString('es-AR')} filas
              </div>
            </div>
            <div className="bg-surface p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
                <MapPin size={12} /> Localidades
              </div>
              <div className="text-2xl font-bold text-body">
                {baseStats.totales.localidades}
              </div>
              <div className="text-xs text-muted mt-0.5">
                {baseStats.totales.vendedores_con_base}/{baseStats.totales.vendedores_total} vendedores con base
              </div>
            </div>
            <div className="bg-surface p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
                <CheckCircle2 size={12} /> Contactados
              </div>
              <div className="text-2xl font-bold text-green-600">
                {baseStats.totales.clientes_contactados.toLocaleString('es-AR')}
              </div>
              <div className="text-xs text-muted mt-0.5">
                de {baseStats.totales.clientes_asignados.toLocaleString('es-AR')} asignados
              </div>
            </div>
            <div className="bg-surface p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
                <BarChart2 size={12} /> Cobertura global
              </div>
              <div className="text-2xl font-bold text-body">
                {baseStats.totales.cobertura_global_pct}%
              </div>
              <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1.5">
                <div
                  className="h-1.5 rounded-full bg-green-600"
                  style={{ width: `${baseStats.totales.cobertura_global_pct}%` }}
                />
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg border-y border-border text-xs font-semibold text-muted uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5">Vendedor</th>
                  <th className="text-left px-4 py-2.5">Localidad</th>
                  <th className="text-right px-4 py-2.5">Asignados</th>
                  <th className="text-right px-4 py-2.5">Contactados</th>
                  <th className="text-right px-4 py-2.5">Pendientes</th>
                  <th className="text-left px-4 py-2.5 w-48">Cobertura</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {baseStats.por_vendedor.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">Sin datos</td></tr>
                ) : baseStats.por_vendedor.map(v => (
                  <tr key={v.vendedor_id} className="hover:bg-bg">
                    <td className="px-4 py-2.5 font-medium text-body">{v.full_name}</td>
                    <td className="px-4 py-2.5">
                      {v.localidad ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                          <MapPin size={10} /> {v.localidad}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700">
                          <AlertTriangle size={10} /> Sin match
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700">
                      {v.clientes_asignados.toLocaleString('es-AR')}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-green-700">
                      {v.clientes_contactados.toLocaleString('es-AR')}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600">
                      {v.clientes_pendientes.toLocaleString('es-AR')}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${
                              v.cobertura_pct >= 50 ? 'bg-green-600'
                              : v.cobertura_pct >= 20 ? 'bg-yellow-500'
                              : 'bg-red-400'
                            }`}
                            style={{ width: `${v.cobertura_pct}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-gray-600 w-9 text-right">
                          {v.cobertura_pct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {baseStats.localidades_sin_vendedor.length > 0 && (
            <div className="px-5 py-3 border-t border-border bg-amber-50/40">
              <div className="flex items-start gap-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <span className="font-semibold">
                    {baseStats.localidades_sin_vendedor.length} localidad(es) sin vendedor asignado:
                  </span>{' '}
                  {baseStats.localidades_sin_vendedor
                    .slice(0, 6)
                    .map(l => `${l.localidad} (${l.clientes_unicos})`)
                    .join(' · ')}
                  {baseStats.localidades_sin_vendedor.length > 6 && ' …'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

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
                  <th className="text-left px-4 py-3">WhatsApp</th>
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
                        {refreshingStatus ? (
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <span className="w-2 h-2 rounded-full bg-gray-300 animate-pulse shrink-0" />
                            {vendor.whatsapp_instance?.status === 'connected' ? 'Online' : 'Offline'}
                          </span>
                        ) : (
                          <span className={`flex items-center gap-1 text-xs font-medium ${
                            vendor.whatsapp_instance?.status === 'connected'
                              ? 'text-green-600'
                              : vendor.whatsapp_instance
                                ? 'text-red-500'
                                : 'text-gray-400'
                          }`}>
                            {vendor.whatsapp_instance?.status === 'connected'
                              ? <><Wifi size={12} /> Online</>
                              : vendor.whatsapp_instance
                                ? <><WifiOff size={12} /> Offline</>
                                : '—'
                            }
                          </span>
                        )}
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
