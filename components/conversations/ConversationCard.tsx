'use client'

import { useState } from 'react'
import { Conversation } from '@/types'
import ScoreBadge from '@/components/ui/ScoreBadge'
import VendorAvatar from '@/components/ui/VendorAvatar'
import { formatDistanceToNow, formatPhone, STAGE_LABELS } from '@/lib/utils'
import { Users, Pencil, Check, X, CreditCard, Clock, MessageSquare, HelpCircle } from 'lucide-react'

const AR_OFFSET_MS = 3 * 60 * 60 * 1000

const statusLabel: Record<string, string> = {
  active: 'Activa',
  closed: 'Cerrada',
  pending: 'Pendiente',
}

const statusColor: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  closed: 'bg-gray-100 text-gray-600',
  pending: 'bg-yellow-100 text-yellow-700',
}

// Color del borde-izquierdo según etapa del análisis IA.
// Es un indicador visual del funnel que se ve sin leer texto.
const STAGE_BORDER_LEFT: Record<string, string> = {
  new:         'border-l-blue-400',
  negotiation: 'border-l-yellow-400',
  proposal:    'border-l-orange-400',
  closed_won:  'border-l-green-500',
  closed_lost: 'border-l-red-400',
}

// Chip más compacto que el del listado de pipeline (usa fondo+texto, sin borde redondeado completo)
const STAGE_CHIP: Record<string, string> = {
  new:         'bg-blue-50 text-blue-700',
  negotiation: 'bg-yellow-50 text-yellow-700',
  proposal:    'bg-orange-50 text-orange-700',
  closed_won:  'bg-green-100 text-green-800',
  closed_lost: 'bg-red-50 text-red-700',
}

interface ConversationCardProps {
  conversation: Conversation
  onClick: () => void
  selected?: boolean
  // Fallbacks del lookup en memoria (base_clientes), usados cuando los campos
  // persistidos en la conversación están vacíos. Permite que la UI refleje la
  // base recién importada sin esperar a un re-match retroactivo.
  baseCliente?: string | null
  baseCuitDni?: string | null
  baseLocalidad?: string | null
  baseTarjetas?: string[] | null
  baseObservacion?: string | null
  onSaveName?: (conversationId: string, displayName: string | null) => Promise<void>
  checkable?: boolean
  checked?: boolean
  onCheck?: () => void
  userRole?: string
}

export default function ConversationCard({
  conversation,
  onClick,
  selected,
  baseCliente,
  baseCuitDni,
  baseLocalidad,
  baseTarjetas,
  baseObservacion,
  onSaveName,
  checkable,
  checked,
  onCheck,
  userRole,
}: ConversationCardProps) {
  const isGroup = conversation.remote_jid?.endsWith('@g.us') ?? false

  const analyses = (Array.isArray(conversation.ai_analysis)
    ? conversation.ai_analysis
    : conversation.ai_analysis ? [conversation.ai_analysis] : []) as Array<{ id: string; quality_score: number; analyzed_at: string; conversation_stage?: string }>
  const analysis = analyses.sort((a, b) =>
    new Date(b.analyzed_at).getTime() - new Date(a.analyzed_at).getTime()
  )[0] ?? null
  const stage = analysis?.conversation_stage

  const lastMsg = conversation.last_message?.content ?? '—'
  const preview = lastMsg.length > 60 ? lastMsg.slice(0, 60) + '...' : lastMsg
  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at))
    : '—'

  // Prioridad de nombre:
  //   1. base_cliente persistido en la conversación (de match-retroactive)
  //   2. baseCliente del lookup en memoria (cubre el caso de base re-importada
  //      sin re-correr el match — el dato fresco aparece igual)
  //   3. display_name editable
  //   4. client_name de WhatsApp
  //   5. teléfono
  const resolvedClienteFromBase = conversation.base_cliente ?? baseCliente ?? null
  const displayName = resolvedClienteFromBase
    ?? conversation.display_name
    ?? conversation.client_name
    ?? conversation.client_phone
  const formattedPhone = formatPhone(conversation.client_phone)
  const hasCustomName = !!(resolvedClienteFromBase || conversation.display_name || conversation.client_name)

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(conversation.display_name ?? conversation.client_name ?? '')
    setEditing(true)
  }

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditing(false)
  }

  const saveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onSaveName) return
    setSaving(true)
    await onSaveName(conversation.id, editValue.trim() || null)
    setSaving(false)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.stopPropagation()
      if (onSaveName && !saving) {
        setSaving(true)
        onSaveName(conversation.id, editValue.trim() || null).then(() => {
          setSaving(false)
          setEditing(false)
        })
      }
    }
    if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  // El match con la base puede venir persistido en la conversación, o llegar como
  // prop (lookup en vivo, base recién importada sin match-retroactive). Resolución
  // campo por campo: persisted gana, prop completa los huecos.
  const resolvedCliente     = resolvedClienteFromBase
  const resolvedCuitDni     = conversation.base_cuit_dni     ?? baseCuitDni     ?? null
  const resolvedObservacion = conversation.base_observacion  ?? baseObservacion ?? null
  const resolvedLocalidad   = conversation.base_localidad    ?? baseLocalidad   ?? null
  const persistedTarjetas   = conversation.base_tarjetas && conversation.base_tarjetas.length > 0
    ? conversation.base_tarjetas : null
  const resolvedTarjetas    = (persistedTarjetas ?? baseTarjetas ?? null) as string[] | null
  const tarjetasArr         = Array.isArray(resolvedTarjetas) ? resolvedTarjetas : []
  const primaryTarjeta      = tarjetasArr[0] ?? null
  const extraTarjetas       = Math.max(0, tarjetasArr.length - 1)
  // Hay match con la base si tenemos al menos cliente, localidad o tarjeta.
  const hasBaseMatch = !!(resolvedCliente || resolvedLocalidad || primaryTarjeta)

  // Tooltip rico con TODOS los campos del match
  const matchTooltip = hasBaseMatch
    ? [
        resolvedCliente     && `Cliente: ${resolvedCliente}`,
        resolvedCuitDni     && `CUIT/DNI: ${resolvedCuitDni}`,
        resolvedLocalidad   && `Localidad: ${resolvedLocalidad}`,
        tarjetasArr.length  && `Tarjetas: ${tarjetasArr.join(', ')}`,
        resolvedObservacion && `Obs: ${resolvedObservacion}`,
      ].filter(Boolean).join('\n')
    : undefined

  // Detectar sin respuesta en +24h: último mensaje del cliente y ya pasó 1 día
  const needsAttention = (() => {
    if (conversation.status !== 'active') return false
    if (!conversation.last_message_at) return false
    if (conversation.last_message?.from_me !== false) return false
    const diffMs = Date.now() - new Date(conversation.last_message_at).getTime() - AR_OFFSET_MS
    return diffMs > 24 * 60 * 60 * 1000
  })()

  const handleClick = () => {
    if (checkable) { onCheck?.(); return }
    if (!editing) onClick()
  }

  // Prioridad del borde-izquierdo: selección > needsAttention > stage del análisis
  const borderLeftClass = (() => {
    if (checkable && checked)         return 'border-l-2 border-l-primary'
    if (!checkable && selected)       return 'border-l-2 border-l-primary'
    if (needsAttention)               return 'border-l-2 border-l-amber-400'
    if (stage && STAGE_BORDER_LEFT[stage]) return `border-l-2 ${STAGE_BORDER_LEFT[stage]}`
    return ''
  })()

  // Mostrar vendedor solo cuando el rol del usuario lo justifica (admin/supervisor).
  // Un vendedor solo ve sus propias conversaciones → es redundante mostrarse a sí mismo.
  const showVendor = userRole !== 'vendedor' && !!conversation.vendedor

  // Mostrar teléfono solo cuando NO hay nombre de cliente (display_name o client_name).
  // Si hay nombre, el tel queda accesible por tooltip en el bloque del nombre.
  const showPhoneInline = !hasCustomName && !isGroup

  return (
    <div
      onClick={handleClick}
      title={hasCustomName && !isGroup ? formattedPhone : undefined}
      className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-border last:border-b-0 ${
        checkable && checked ? 'bg-primary/10' :
        !checkable && selected ? 'bg-primary/5' :
        needsAttention ? 'hover:bg-amber-50/60' : 'hover:bg-bg'
      } ${editing && !checkable ? 'cursor-default' : ''} ${borderLeftClass}`}
    >
      {/* Checkbox en modo selección */}
      {checkable && (
        <div className={`w-4 h-4 mt-1 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${
          checked ? 'bg-primary border-primary' : 'border-gray-300 bg-white'
        }`}>
          {checked && <Check size={10} className="text-white" />}
        </div>
      )}

      {/* Avatar con indicador de atención */}
      <div className="relative shrink-0">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${
          isGroup ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-600'
        }`}>
          {isGroup ? <Users size={18} /> : displayName.charAt(0).toUpperCase()}
        </div>
        {needsAttention && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-400 border-2 border-white rounded-full animate-pulse" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {/* Fila 1: nombre + (tiempo, score) a la derecha */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <input
                  autoFocus
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="flex-1 min-w-0 text-xs border border-primary rounded px-1.5 py-0.5 focus:outline-none"
                  placeholder="Nombre del cliente"
                />
                <button onClick={saveEdit} disabled={saving} className="text-green-600 hover:text-green-700 shrink-0">
                  <Check size={13} />
                </button>
                <button onClick={cancelEdit} className="text-gray-400 hover:text-gray-600 shrink-0">
                  <X size={13} />
                </button>
              </div>
            ) : (
              <div className="group/name flex items-center gap-1 min-w-0">
                <span className="font-medium text-body text-sm truncate min-w-0">
                  {displayName}
                </span>
                {conversation.display_name && conversation.client_name && conversation.display_name !== conversation.client_name && (
                  <span className="text-[10px] text-gray-400 shrink-0">
                    (orig: {conversation.client_name})
                  </span>
                )}
                {onSaveName && (
                  <button
                    onClick={startEdit}
                    className="shrink-0 opacity-0 group-hover/name:opacity-100 text-gray-300 hover:text-primary transition-opacity"
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </div>
            )}
            {/* Teléfono inline solo si no hay nombre — sino queda en el tooltip del card */}
            {showPhoneInline && (
              <span className="text-[10px] text-gray-400 block leading-tight">
                {formattedPhone}
              </span>
            )}
          </div>

          {/* Esquina derecha: tiempo + score (o "sin análisis") */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {(() => {
              // Color graduado de la fecha según urgencia, solo cuando el cliente
              // está esperando respuesta (último mensaje del cliente):
              //   azul     ≤ 5 min   → recién llegado, sin presión
              //   amarillo 5-10 min  → conviene responder
              //   rojo     > 10 min  → urgente, el cliente está esperando
              //   gris     último del vendedor o sin datos
              // Lee preferentemente la columna denormalizada (mantenida por trigger).
              // Cae al last_message del realtime si la columna no estuviera disponible.
              const lastFromClient =
                conversation.last_message_from_me === false
                || (conversation.last_message_from_me === undefined
                    && conversation.last_message?.from_me === false)
              const elapsedMin = conversation.last_message_at
                ? (Date.now() - new Date(conversation.last_message_at).getTime()) / 60_000
                : null

              let cls = 'text-muted'
              if (lastFromClient && elapsedMin !== null) {
                if      (elapsedMin > 10) cls = 'text-red-600 font-semibold'
                else if (elapsedMin > 5)  cls = 'text-yellow-600 font-semibold'
                else                       cls = 'text-blue-600 font-semibold'
              }

              return (
                <span className={`text-sm leading-tight ${cls}`}>
                  {timeAgo}
                </span>
              )
            })()}
            {analysis ? (
              <ScoreBadge score={(analysis as { quality_score: number }).quality_score} size="md" />
            ) : !isGroup && (
              <span
                className="flex items-center gap-0.5 text-[10px] font-medium text-gray-400 bg-gray-100 border border-dashed border-gray-300 rounded-full px-1.5 py-0.5"
                title="Esta conversación aún no fue analizada por IA"
              >
                <HelpCircle size={9} /> Sin análisis
              </span>
            )}
          </div>
        </div>

        {/* Fila 2: preview + estado */}
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-muted truncate flex-1 min-w-0">{preview}</p>
          <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${statusColor[conversation.status]}`}>
            {statusLabel[conversation.status]}
          </span>
        </div>

        {/* Fila 3: etiquetas */}
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {/* Etapa del funnel (del análisis IA) — más prominente */}
          {stage && STAGE_CHIP[stage] && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap ${STAGE_CHIP[stage]}`}>
              {STAGE_LABELS[stage] ?? stage}
            </span>
          )}
          {/* Cantidad de mensajes */}
          {typeof conversation.message_count === 'number' && conversation.message_count > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px] font-medium text-gray-600 bg-gray-100 rounded-full px-1.5 py-0.5 shrink-0 whitespace-nowrap"
              title={`${conversation.message_count} mensajes en total`}
            >
              <MessageSquare size={9} /> {conversation.message_count} msg
            </span>
          )}
          {needsAttention && (
            <span className="flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0 whitespace-nowrap">
              <Clock size={9} /> Sin resp.
            </span>
          )}
          {isGroup && (
            <span className="flex items-center gap-0.5 text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full font-medium shrink-0 whitespace-nowrap">
              <Users size={9} /> Grupo
            </span>
          )}
          {hasBaseMatch && (
            <span
              className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap bg-green-100 text-green-700 border border-green-200"
              title={matchTooltip}
            >
              <CreditCard size={9} />
              {resolvedLocalidad ?? 'Cliente'}
              {primaryTarjeta && <span className="font-normal opacity-80"> · {primaryTarjeta}</span>}
              {extraTarjetas > 0 && <span className="font-normal opacity-80"> +{extraTarjetas}</span>}
            </span>
          )}
          {hasBaseMatch && resolvedCuitDni && (
            <span
              className="text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap"
              title={matchTooltip}
            >
              DNI {resolvedCuitDni}
            </span>
          )}
          {hasBaseMatch && resolvedObservacion && (
            <span
              className="text-[10px] italic text-gray-600 truncate max-w-50 shrink"
              title={resolvedObservacion}
            >
              &ldquo;{resolvedObservacion}&rdquo;
            </span>
          )}
          {showVendor && conversation.vendedor && (
            <div className="flex items-center gap-1 min-w-0 shrink">
              <VendorAvatar vendor={conversation.vendedor} size="sm" />
              <span className="text-xs text-muted truncate max-w-[70px]">
                {conversation.vendedor.full_name.split(' ')[0]}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
