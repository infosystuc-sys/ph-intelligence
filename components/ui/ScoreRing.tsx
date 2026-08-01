import { getScoreColor } from './ScoreBadge'

// Mismos umbrales/semántica que ScoreBadge (getScoreColor) pero como hex,
// porque el anillo se pinta con conic-gradient (necesita color real, no
// clase de Tailwind). Mantenidos en el mismo archivo que los consume para
// que un cambio de paleta de score no se desincronice entre badge y anillo.
function ringHex(score: number): { ring: string; text: string } {
  if (score >= 75) return { ring: '#22c55e', text: 'text-green-700' }
  if (score >= 50) return { ring: '#eab308', text: 'text-yellow-700' }
  return { ring: '#ef4444', text: 'text-red-600' }
}

interface ScoreRingProps {
  score: number
  size?: 'sm' | 'lg'
}

// Anillo de progreso circular para el score de IA — reemplaza al ScoreBadge
// (pill) en la lista y el header de Conversaciones: el relleno del anillo se
// lee de un vistazo al escanear la lista, y el número exacto sigue ahí para
// cuando hace falta precisión. Ver docs de la propuesta de rediseño.
export default function ScoreRing({ score, size = 'sm' }: ScoreRingProps) {
  const { ring, text } = ringHex(score)
  const dims = size === 'lg' ? 52 : 30
  const inset = size === 'lg' ? 5 : 3.5
  const fontSize = size === 'lg' ? 16 : 10

  return (
    <div
      className="relative shrink-0 rounded-full"
      style={{
        width: dims,
        height: dims,
        background: `conic-gradient(${ring} ${Math.max(0, Math.min(100, score))}%, #EDEAF3 0)`,
      }}
      title={`${score}/100`}
    >
      <div
        className={`absolute rounded-full bg-surface flex items-center justify-center font-bold ${text}`}
        style={{ inset, fontSize }}
      >
        {score}
      </div>
    </div>
  )
}
