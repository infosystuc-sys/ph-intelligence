// N8N almacena hora argentina directamente en Supabase (sin offset UTC).
// Para mostrar los valores correctamente, usamos timeZone:'UTC' que devuelve
// el valor exactamente como está guardado en la DB.
// Para cálculos de tiempo relativo compensamos los 3 horas de diferencia.
const AR_OFFSET_MS = 3 * 60 * 60 * 1000 // UTC-3 en milisegundos

// ── Formatear tiempo relativo ─────────────────────────────────────────────────
export function formatDistanceToNow(date: Date): string {
  const now = new Date()
  // date está guardada como hora argentina pero etiquetada como UTC → compensar
  const diffMs = now.getTime() - date.getTime() - AR_OFFSET_MS
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr  = Math.floor(diffMin / 60)
  const diffDay  = Math.floor(diffHr / 24)

  if (diffMin < 1) return 'ahora'
  if (diffMin < 60) return `hace ${diffMin}m`
  if (diffHr  < 24) return `hace ${diffHr}h`
  if (diffDay < 7)  return `hace ${diffDay}d`
  return date.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })
}

// ── Formatear fecha larga ─────────────────────────────────────────────────────
export function formatDateLong(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('es-AR', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ── Formatear fecha+hora de mensaje ───────────────────────────────────────────
export function formatMessageDateTime(raw: string): string {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw

  const thisYear = new Date().getUTCFullYear()
  const isThisYear = d.getUTCFullYear() === thisYear

  const time = d.toLocaleTimeString('es-AR', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
  const date = isThisYear
    ? d.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })
    : d.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: '2-digit' })

  return `${date} ${time}`
}

// ── Color del score (semántico: verde/amarillo/rojo) ──────────────────────────
export function getScoreColor(score: number): string {
  if (score >= 75) return '#22c55e'
  if (score >= 50) return '#eab308'
  return '#dc2626'
}

// ── Etiqueta de etapa de pipeline ─────────────────────────────────────────────
export const STAGE_LABELS: Record<string, string> = {
  new:         'Nuevo Contacto',
  negotiation: 'En Negociación',
  proposal:    'Propuesta Enviada',
  closed_won:  'Ganado ✅',
  closed_lost: 'Perdido ❌',
}

export const STAGE_COLORS: Record<string, string> = {
  new:         'bg-blue-50 text-blue-700 border-blue-200',
  negotiation: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  proposal:    'bg-orange-50 text-orange-700 border-orange-200',
  closed_won:  'bg-green-500 text-white border-green-600',
  closed_lost: 'bg-red-100 text-red-700 border-red-300',
}

// ── Truncar texto ─────────────────────────────────────────────────────────────
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

// ── Detección de saludo/cierre ────────────────────────────────────────────────
// Frases típicas de saludo/cierre en WhatsApp argentino. Usado para no contar
// como "sin respuesta" un mensaje que en realidad no necesita respuesta del
// vendedor (ver criterio "Sin Respuesta +24hs" en /api/kpis y Conversaciones).
const GREETING_WORDS = [
  'hola', 'buenas', 'buen dia', 'buen día', 'buenas tardes', 'buenas noches',
  'gracias', 'muchas gracias', 'dale', 'ok', 'okay', 'perfecto', 'genial',
  'listo', 'joya', 'buenísimo', 'buenisimo', 'de nada', 'chau', 'nos vemos',
  'saludos', 'que tengas buen dia', 'que tengas buen día', '👍', '🙏', '😊',
]

// Deliberadamente conservador: solo marca como saludo mensajes cortos, sin
// pregunta, que matchean alguna frase típica. Prioriza no descartar consultas
// reales por error antes que atrapar todos los saludos posibles.
export function looksLikeGreeting(content: string | null | undefined): boolean {
  if (!content) return false
  const text = content.trim().toLowerCase()
  if (!text) return false
  if (text.includes('?')) return false
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > 6) return false
  return GREETING_WORDS.some(g => text.includes(g))
}

// ── Detección de reacciones y stickers ────────────────────────────────────────
// N8N guarda eventos protocolares de WhatsApp (reacciones a un mensaje anterior)
// como placeholders de texto en vez de descartarlos, ej: "[mensaje: reactionMessage]"
// o "[mensaje: messageContextInfo, reactionMessage]" (verificado contra datos reales
// el 20/6/2026). Los stickers se guardan como type='image' con content="[sticker]".
// Ninguno de los dos es una consulta real esperando respuesta del vendedor.
export function looksLikeReactionOrSticker(content: string | null | undefined): boolean {
  if (!content) return false
  const text = content.trim().toLowerCase()
  if (!text) return false
  if (text.includes('reactionmessage')) return true
  if (text === '[sticker]') return true
  return false
}

// ── "Sin Respuesta +24hs": solo lo que cruzó el umbral HOY ────────────────────
// Antes el criterio era simplemente "> 24hs sin respuesta", que iba acumulando
// para siempre cualquier conversación vieja sin resolver (un mensaje de hace
// 10 días sigue contando todos los días). Acordado 20/6/2026: mostrar solo las
// conversaciones cuyo momento de "cumplir 24hs sin respuesta" cayó HOY — el
// backlog de conversaciones más viejas no vuelve a aparecer día tras día.
function toDateKeyAR(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
}

export function crossed24hThresholdToday(lastMessageAt: string, now: number = Date.now()): boolean {
  const H24 = 24 * 60 * 60 * 1000
  const crossesAt = new Date(lastMessageAt).getTime() + H24
  if (crossesAt > now) return false // todavía no llegó a las 24hs
  return toDateKeyAR(crossesAt) === toDateKeyAR(now)
}

// ── Ventana horaria del análisis automático: 21:00 a 09:00 (hora AR) ─────────
// Acordado 22/6/2026: el análisis automático no debe correr durante el horario
// laboral, solo de noche. hourCycle:'h23' evita el bug conocido de Intl que
// devuelve "24" en vez de "00" a la medianoche con hour12:false.
export function isWithinAutoAnalysisWindow(now: Date = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now))
  return hour >= 21 || hour < 9
}

// ── Normalizar teléfono argentino a 10 dígitos locales ────────────────────────
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('549')) digits = digits.slice(3)
  else if (digits.startsWith('54')) digits = digits.slice(2)
  if (digits.startsWith('0')) digits = digits.slice(1)
  return digits
}

// ── Formatear teléfono argentino para mostrar ─────────────────────────────────
export function formatPhone(phone: string): string {
  const local = normalizePhone(phone)
  if (local.length === 10) {
    return `${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6)}`
  }
  return phone
}
