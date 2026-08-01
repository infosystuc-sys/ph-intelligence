import { ScoreBadgeProps } from '@/types'

// Los colores del score son semánticos (verde=bueno, amarillo=medio, rojo=bajo)
// No usan la paleta de marca. Exportada para que ScoreRing use la misma
// clasificación — un mismo score debe verse del mismo color en toda la app,
// sea badge o anillo.
export function getScoreColor(score: number) {
  if (score >= 75) return { bg: 'bg-green-100', text: 'text-green-700', bar: 'bg-green-500' }
  if (score >= 50) return { bg: 'bg-yellow-100', text: 'text-yellow-700', bar: 'bg-yellow-500' }
  return { bg: 'bg-red-100', text: 'text-red-600', bar: 'bg-red-500' }
}

export default function ScoreBadge({ score, size = 'md', showLabel = false }: ScoreBadgeProps) {
  const colors = getScoreColor(score)

  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5',
    md: 'text-sm px-2 py-1',
    lg: 'text-base px-3 py-1.5',
  }

  if (!showLabel) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-semibold ${colors.bg} ${colors.text} ${sizeClasses[size]}`}>
        {score}
        {size !== 'sm' && <span className="opacity-60 font-normal">/100</span>}
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className={`font-bold text-lg ${colors.text}`}>{score}</span>
        <span className="text-xs text-gray-400">/100</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${colors.bar}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

export function getScoreRowClass(score: number): string {
  if (score >= 75) return 'bg-green-50'
  if (score < 50) return 'bg-red-50'
  return ''
}
