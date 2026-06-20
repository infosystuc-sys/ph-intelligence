// ============================================
// TIPOS GLOBALES — PH-Intelligence
// ============================================

export type UserRole = 'admin' | 'supervisor' | 'vendedor'
export type ConversationStatus = 'active' | 'closed' | 'pending' | 'historico'
export type ConversationStage = 'new' | 'negotiation' | 'proposal' | 'closed_won' | 'closed_lost'
export type MessageType = 'text' | 'image' | 'audio' | 'document'
export type SentimentType = 'positive' | 'neutral' | 'negative'
export type InstanceStatus = 'connected' | 'disconnected'

// ── Usuarios ──────────────────────────────────────────────────────────────────
export interface User {
  id: string
  email: string
  full_name: string
  role: UserRole
  whatsapp_instance_id: string | null
  supervisor_id: string | null
  avatar_url: string | null
  created_at: string
}

// ── Instancias WhatsApp ───────────────────────────────────────────────────────
export interface WhatsappInstance {
  id: string
  instance_name: string
  vendedor_id: string
  api_url: string
  api_key: string
  // Key de Gemini propia de esta instancia (opcional). Si es null, el análisis
  // IA de sus conversaciones usa la GEMINI_API_KEY global como fallback.
  gemini_api_key: string | null
  status: InstanceStatus
  phone_number: string | null
  last_sync_at: string | null
  vendedor?: User
}

// ── Conversaciones ────────────────────────────────────────────────────────────
export interface Conversation {
  id: string
  instance_id: string
  remote_jid: string
  vendedor_id: string
  status: ConversationStatus
  last_message_at: string | null
  created_at: string
  message_count: number
  client_name: string | null
  display_name: string | null
  client_phone: string
  base_cliente:     string | null
  base_cuit_dni:    string | null
  base_localidad:   string | null
  base_tarjetas:    string[] | null
  base_observacion: string | null
  // Denormalizado: from_me del mensaje más reciente. Mantenido por trigger.
  // null cuando la conversación no tiene mensajes aún.
  last_message_from_me?: boolean | null
  vendedor?: User
  last_message?: Message
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ai_analysis?: any
}

// ── Mensajes ──────────────────────────────────────────────────────────────────
export interface Message {
  id: string
  conversation_id: string
  content: string
  type: MessageType
  from_me: boolean
  msg_timestamp: string
  media_url: string | null
}

// ── Análisis IA ───────────────────────────────────────────────────────────────
export interface AIAnalysis {
  id: string
  conversation_id: string
  vendedor_id: string
  quality_score: number
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
  conversation_stage: ConversationStage
  talk_ratio_vendor: number
  talk_ratio_client: number
  keywords_detected: string[]
  sentiment: SentimentType
  full_report: string
  executive_summary: string
  vendor_coaching_note: string
  analyzed_at: string
  model_used: string
}

// ── KPIs diarios ──────────────────────────────────────────────────────────────
export interface DailyKPI {
  id: string
  vendedor_id: string
  date: string
  conversations_total: number
  conversations_responded_24h: number
  conversations_unresponded_24h: number
  avg_quality_score: number
  estimated_conversions: number
  pipeline_stage_counts: Record<ConversationStage, number>
  vendedor?: User
}

// ── Respuestas API Evolution ──────────────────────────────────────────────────
export interface EvolutionChat {
  id: string
  remoteJid: string
  name: string | null
  lastMessage?: {
    message: { conversation?: string }
    messageTimestamp: number
  }
  updatedAt?: string
}

export interface EvolutionMessage {
  key: {
    remoteJid: string
    fromMe: boolean
    id: string
  }
  message: {
    conversation?: string
    imageMessage?: { url?: string; caption?: string }
    audioMessage?: { url?: string }
    documentMessage?: { url?: string; fileName?: string; caption?: string }
  }
  messageType: string
  messageTimestamp: number
  pushName?: string
}

// ── Respuesta Análisis IA ─────────────────────────────────────────────────────
export interface AIAnalysisResponse {
  quality_score: number
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
  conversation_stage: ConversationStage
  talk_ratio_vendor: number
  talk_ratio_client: number
  keywords_detected: string[]
  sentiment: SentimentType
  executive_summary: string
  vendor_coaching_note: string
}

// ── Dashboard Stats ───────────────────────────────────────────────────────────
export interface DashboardStats {
  avg_quality_score: number
  avg_quality_score_prev: number
  unresponded_24h: number
  estimated_conversions: number
  estimated_conversions_prev: number
  active_conversations: number
  pipeline_counts: Record<ConversationStage, number>
  vendors_improved: number
  vendors_declined: number
  connected_instances: number
  total_instances: number
}

// ── Props de componentes UI ───────────────────────────────────────────────────
export interface KpiCardProps {
  title: string
  value: string | number
  icon: React.ReactNode
  trend?: number
  trendLabel?: string
  alert?: boolean
  alertLabel?: string
  onClick?: () => void
}

export interface ScoreBadgeProps {
  score: number
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}

export interface ChatBubbleProps {
  message: Message
  vendorName?: string
  clientName?: string
}

export interface PipelineBoardProps {
  conversations: Conversation[]
  onMove: (conversationId: string, newStage: ConversationStage) => void
  vendorFilter?: string
}
