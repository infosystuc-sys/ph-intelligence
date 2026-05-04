'use client'

import { AIAnalysis, User } from '@/types'
import { STAGE_LABELS, STAGE_COLORS, getScoreColor } from '@/lib/utils'
import {
  CheckCircle,
  XCircle,
  Lightbulb,
  Lock,
  MessageSquare,
  Tag,
  Smile,
  Meh,
  Frown,
  TrendingUp,
} from 'lucide-react'

interface ScorePoint { id: string; quality_score: number; analyzed_at: string }

interface AnalysisReportProps {
  analysis: AIAnalysis
  conversation: {
    client_name: string | null
    client_phone: string
    created_at: string
    message_count: number
  }
  vendor: User
  userRole: string
  userId: string
  allAnalyses?: ScorePoint[]
}

const sentimentIcon = {
  positive: <Smile size={18} className="text-green-500" />,
  neutral:  <Meh  size={18} className="text-yellow-500" />,
  negative: <Frown size={18} className="text-red-500" />,
}

const sentimentLabel = { positive: 'Positivo', neutral: 'Neutral', negative: 'Negativo' }

// ── Mini gráfico SVG de evolución de score ────────────────────────────────────
function ScoreHistory({ data }: { data: ScorePoint[] }) {
  if (data.length < 2) return null
  const W = 480, H = 120, PL = 28, PR = 10, PT = 8, PB = 22
  const iW = W - PL - PR, iH = H - PT - PB
  const xOf = (i: number) => PL + (i / (data.length - 1)) * iW
  const yOf = (v: number) => PT + iH - (v / 100) * iH
  const points = data.map((d, i) => `${xOf(i)},${yOf(d.quality_score)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }}>
      {[0, 25, 50, 75, 100].map(v => (
        <g key={v}>
          <line x1={PL} x2={W - PR} y1={yOf(v)} y2={yOf(v)} stroke="#f0f0f0" strokeWidth={1} />
          <text x={PL - 4} y={yOf(v)} textAnchor="end" fontSize={8} fill="#bbb" dominantBaseline="middle">{v}</text>
        </g>
      ))}
      {data.map((d, i) => (
        <text key={i} x={xOf(i)} y={H - 4} textAnchor="middle" fontSize={8} fill="#bbb">
          {new Date(d.analyzed_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
        </text>
      ))}
      <polyline points={points} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinejoin="round" />
      {data.map((d, i) => (
        <g key={i}>
          <circle cx={xOf(i)} cy={yOf(d.quality_score)} r={4} fill="var(--color-primary)" />
          <text x={xOf(i)} y={yOf(d.quality_score) - 7} textAnchor="middle" fontSize={9} fill="var(--color-primary)" fontWeight="600">
            {d.quality_score}
          </text>
        </g>
      ))}
    </svg>
  )
}

export default function AnalysisReport({ analysis, conversation, vendor, userRole, userId, allAnalyses = [] }: AnalysisReportProps) {
  const scoreColor = getScoreColor(analysis.quality_score)

  // Admin y supervisor ven la nota de coaching; el vendedor ve la suya propia
  const canSeeCoaching =
    ['admin', 'supervisor'].includes(userRole) || userId === vendor.id

  const scoreLabel =
    analysis.quality_score >= 75 ? 'Excelente' :
    analysis.quality_score >= 50 ? 'Regular' : 'Necesita Mejorar'

  // Para el historial sólo necesitamos datos ordenados cronológicamente
  const history = [...allAnalyses].sort(
    (a, b) => new Date(a.analyzed_at).getTime() - new Date(b.analyzed_at).getTime()
  )

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-lg shadow-sm border border-border p-6">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          {/* Score */}
          <div className="flex flex-col items-center gap-2 shrink-0">
            <div
              className="w-28 h-28 rounded-full flex items-center justify-center border-8"
              style={{ borderColor: scoreColor }}
            >
              <div className="text-center">
                <p className="text-3xl font-bold" style={{ color: scoreColor }}>
                  {analysis.quality_score}
                </p>
                <p className="text-xs text-gray-400">/100</p>
              </div>
            </div>
            <span className="text-xs font-semibold px-2 py-1 rounded-full text-white" style={{ backgroundColor: scoreColor }}>
              {scoreLabel}
            </span>
          </div>

          {/* Info */}
          <div className="flex-1">
            <h2 className="text-xl font-bold text-body">
              {conversation.client_name ?? conversation.client_phone}
            </h2>
            <p className="text-gray-500 text-sm mb-3">
              Vendedor: <strong>{vendor.full_name}</strong> · {conversation.message_count} mensajes · {new Date(conversation.created_at).toLocaleDateString('es-AR')}
            </p>
            <div className="flex flex-wrap gap-2">
              <span className={`text-xs px-2 py-1 rounded-full border ${STAGE_COLORS[analysis.conversation_stage]}`}>
                {STAGE_LABELS[analysis.conversation_stage]}
              </span>
              <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                {sentimentIcon[analysis.sentiment]}
                {sentimentLabel[analysis.sentiment]}
              </span>
              <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                Analizado {new Date(analysis.analyzed_at).toLocaleDateString('es-AR')}
              </span>
              {allAnalyses.length > 1 && (
                <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
                  {allAnalyses.length} análisis totales
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Historial de scores ──────────────────────────────────────────────── */}
      {history.length > 1 && (
        <div className="bg-surface rounded-lg shadow-sm border border-border p-5">
          <h3 className="font-semibold text-body flex items-center gap-2 mb-4">
            <TrendingUp size={16} className="text-primary" /> Evolución del Score
          </h3>
          <ScoreHistory data={history} />
          <p className="text-xs text-muted mt-2 text-center">
            Δ desde el primer análisis:{' '}
            <span className={`font-semibold ${history[history.length - 1].quality_score >= history[0].quality_score ? 'text-green-600' : 'text-red-500'}`}>
              {history[history.length - 1].quality_score >= history[0].quality_score ? '+' : ''}
              {history[history.length - 1].quality_score - history[0].quality_score} pts
            </span>
          </p>
        </div>
      )}

      {/* ── Fortalezas / Debilidades / Sugerencias ──────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-green-200 p-5">
          <h3 className="font-semibold text-green-700 flex items-center gap-2 mb-3">
            <CheckCircle size={16} /> Fortalezas
          </h3>
          <ul className="space-y-2">
            {analysis.strengths.length === 0 ? (
              <li className="text-sm text-gray-400">Sin fortalezas detectadas</li>
            ) : analysis.strengths.map((s, i) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <CheckCircle size={12} className="text-green-500 mt-0.5 shrink-0" /> {s}
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-5">
          <h3 className="font-semibold text-red-700 flex items-center gap-2 mb-3">
            <XCircle size={16} /> Debilidades
          </h3>
          <ul className="space-y-2">
            {analysis.weaknesses.length === 0 ? (
              <li className="text-sm text-gray-400">Sin debilidades detectadas</li>
            ) : analysis.weaknesses.map((w, i) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <XCircle size={12} className="text-red-500 mt-0.5 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-blue-200 p-5">
          <h3 className="font-semibold text-blue-700 flex items-center gap-2 mb-3">
            <Lightbulb size={16} /> Sugerencias
          </h3>
          <ul className="space-y-2">
            {analysis.suggestions.length === 0 ? (
              <li className="text-sm text-gray-400">Sin sugerencias</li>
            ) : analysis.suggestions.map((s, i) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <Lightbulb size={12} className="text-blue-500 mt-0.5 shrink-0" /> {s}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── Talk ratio + Keywords ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-border p-5">
          <h3 className="font-semibold text-body flex items-center gap-2 mb-4">
            <MessageSquare size={16} className="text-primary" /> Ratio de Conversación
          </h3>
          <div className="flex items-center gap-4">
            <div className="w-28 h-28 shrink-0">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle cx="50" cy="50" r="38" fill="none" stroke="#E0E0E0" strokeWidth="16" />
                <circle
                  cx="50" cy="50" r="38" fill="none"
                  stroke="var(--color-primary)" strokeWidth="16"
                  strokeDasharray={`${(analysis.talk_ratio_vendor / 100) * 2 * Math.PI * 38} ${2 * Math.PI * 38}`}
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="space-y-3 flex-1">
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-primary inline-block" /> Vendedor</span>
                  <span className="font-semibold">{analysis.talk_ratio_vendor.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-primary" style={{ width: `${analysis.talk_ratio_vendor}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300 inline-block" /> Cliente</span>
                  <span className="font-semibold">{analysis.talk_ratio_client.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-gray-400" style={{ width: `${analysis.talk_ratio_client}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-border p-5">
          <h3 className="font-semibold text-body flex items-center gap-2 mb-4">
            <Tag size={16} className="text-primary" /> Keywords Detectadas
          </h3>
          <div className="flex flex-wrap gap-2">
            {analysis.keywords_detected.length === 0 ? (
              <p className="text-sm text-gray-400">Sin keywords detectadas</p>
            ) : analysis.keywords_detected.map((kw, i) => (
              <span key={i} className="text-xs px-2 py-1 bg-primary/10 text-primary rounded-full border border-primary/20 font-medium">
                {kw}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Resumen ejecutivo ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm border border-border p-5">
        <h3 className="font-semibold text-body mb-3">📊 Resumen Ejecutivo</h3>
        <p className="text-sm text-gray-700 leading-relaxed">{analysis.executive_summary}</p>
      </div>

      {/* ── Nota de coaching (privada) ───────────────────────────────────────── */}
      {canSeeCoaching && analysis.vendor_coaching_note && (
        <div className="bg-yellow-50 rounded-lg shadow-sm border border-yellow-200 p-5">
          <h3 className="font-semibold text-yellow-800 flex items-center gap-2 mb-3">
            <Lock size={16} /> Nota de Coaching (Privada)
          </h3>
          <p className="text-sm text-yellow-900 leading-relaxed">{analysis.vendor_coaching_note}</p>
        </div>
      )}
    </div>
  )
}
