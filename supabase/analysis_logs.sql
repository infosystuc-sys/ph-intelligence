-- ============================================================
-- Migración: Tabla de logs de análisis IA
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analysis_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  vendedor_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  triggered_by    TEXT NOT NULL CHECK (triggered_by IN ('auto', 'manual')),
  status          TEXT NOT NULL CHECK (status IN ('success', 'error')),
  analysis_id     UUID REFERENCES public.ai_analyses(id) ON DELETE SET NULL,
  model_used      TEXT,
  error_message   TEXT,
  duration_ms     INTEGER,
  message_count   INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para consultas por conversación (panel de log en el chat)
CREATE INDEX IF NOT EXISTS idx_analysis_logs_conversation
  ON public.analysis_logs (conversation_id, created_at DESC);

-- Índice para consultas por vendedor (sección Logs en Settings)
CREATE INDEX IF NOT EXISTS idx_analysis_logs_vendedor
  ON public.analysis_logs (vendedor_id, created_at DESC);
