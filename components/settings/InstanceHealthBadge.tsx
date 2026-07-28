'use client'

import { useState } from 'react'
import { Wifi, WifiOff, Webhook, MessageCircle, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { InstanceHealthResult } from '@/types'
import { formatDistanceToNow, formatDistanceToNowUTC } from '@/lib/utils'

const HEALTH_STYLES: Record<InstanceHealthResult['health'], { bg: string; text: string; label: string }> = {
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Operativa' },
  yellow: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'No verificado' },
  red:    { bg: 'bg-red-100',    text: 'text-red-600',    label: 'Sin recibir mensajes' },
}

export default function InstanceHealthBadge({
  health,
  checking,
}: {
  health: InstanceHealthResult | undefined
  checking: boolean
}) {
  const [open, setOpen] = useState(false)

  if (checking) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-500 text-xs font-medium px-2 py-0.5">
        Verificando…
      </span>
    )
  }

  if (!health) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-400 text-xs font-medium px-2 py-0.5">
        Sin verificar
      </span>
    )
  }

  const style = HEALTH_STYLES[health.health]

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(p => !p)}
        className={`inline-flex items-center gap-1 rounded-full font-medium text-xs px-2 py-0.5 ${style.bg} ${style.text}`}
      >
        {style.label}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-72 bg-surface border border-border rounded-lg shadow-lg p-3 space-y-2.5 text-xs">
          <div className="flex items-start gap-2">
            {health.connected
              ? <Wifi size={14} className="text-green-600 mt-0.5 shrink-0" />
              : <WifiOff size={14} className="text-red-500 mt-0.5 shrink-0" />}
            <div>
              <p className="font-medium text-body">
                Conexión WhatsApp: {!health.connectionVerified ? 'no se pudo verificar' : health.connected ? 'abierta' : 'cerrada'}
              </p>
              {health.disconnectReason && (
                <p className="text-gray-500 mt-0.5">{health.disconnectReason}</p>
              )}
              {health.disconnectedAt && (
                <p className="text-gray-400 mt-0.5">Desde {formatDistanceToNowUTC(new Date(health.disconnectedAt))}</p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            {!health.webhookVerified
              ? <HelpCircle size={14} className="text-yellow-500 mt-0.5 shrink-0" />
              : <Webhook size={14} className={health.webhookOk ? 'text-green-600 mt-0.5 shrink-0' : 'text-red-500 mt-0.5 shrink-0'} />}
            <div>
              <p className="font-medium text-body">
                Webhook: {!health.webhookVerified ? 'no se pudo verificar' : health.webhookOk ? 'configurado correctamente' : 'ausente o mal configurado'}
              </p>
              {health.webhookVerified && !health.webhookOk && (
                <p className="text-gray-500 mt-0.5 break-all">
                  {health.webhookUrl ? `Apunta a: ${health.webhookUrl}` : 'No hay webhook registrado'}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <MessageCircle size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-body">Último mensaje recibido</p>
              <p className="text-gray-500 mt-0.5">
                {health.lastInboundMessageAt
                  ? formatDistanceToNow(new Date(health.lastInboundMessageAt))
                  : 'sin mensajes registrados'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
