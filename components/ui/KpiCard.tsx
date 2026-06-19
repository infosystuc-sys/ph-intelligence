import { memo } from 'react'
import { KpiCardProps } from '@/types'
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react'

function KpiCard({ title, value, icon, trend, trendLabel, alert, alertLabel, onClick }: KpiCardProps) {
  const trendPositive = trend !== undefined && trend > 0
  const trendNegative = trend !== undefined && trend < 0

  return (
    <div
      className={`bg-surface rounded-lg shadow-sm border border-border p-5 flex flex-col gap-3 ${
        onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''
      } ${alert ? 'border-red-200 bg-red-50' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-muted uppercase tracking-wide leading-tight">{title}</p>
        <div className={`p-2 rounded-md ${alert ? 'bg-red-100' : 'bg-primary/10'}`}>
          <span className={alert ? 'text-red-600' : 'text-primary'}>{icon}</span>
        </div>
      </div>

      <div className="flex items-end justify-between gap-2">
        <span className={`text-2xl font-bold ${alert ? 'text-red-600' : 'text-body'}`}>
          {value}
        </span>

        {trend !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-medium ${
            trendPositive ? 'text-green-600' : trendNegative ? 'text-red-500' : 'text-gray-400'
          }`}>
            {trendPositive && <TrendingUp size={14} />}
            {trendNegative && <TrendingDown size={14} />}
            <span>{trendLabel ?? `${Math.abs(trend)}%`}</span>
          </div>
        )}

        {alert && alertLabel && (
          <div className="flex items-center gap-1 text-xs text-red-600">
            <AlertCircle size={12} />
            <span>{alertLabel}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(KpiCard)
