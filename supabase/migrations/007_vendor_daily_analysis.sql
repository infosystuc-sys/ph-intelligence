-- ── Análisis global diario de vendedor ──────────────────────────────────────
-- Un registro por vendedor/día, generado manualmente (botón "Generar" en el
-- perfil del vendedor), que resume los ai_analyses de las últimas 72hs: los
-- números se calculan en la app, el resto lo escribe un LLM a partir de esos
-- análisis individuales. Mismo patrón de "una fila por día" que daily_kpis.
CREATE TABLE IF NOT EXISTS public.vendor_daily_analyses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_id                 UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date                        DATE NOT NULL,
  window_start                TIMESTAMPTZ NOT NULL,
  window_end                  TIMESTAMPTZ NOT NULL,
  conversations_analyzed      INTEGER NOT NULL DEFAULT 0,
  avg_quality_score           FLOAT,
  avg_quality_score_prev_window FLOAT,
  avg_talk_ratio_vendor       FLOAT,
  sentiment_counts            JSONB NOT NULL DEFAULT '{"positive":0,"neutral":0,"negative":0}',
  stage_counts                JSONB NOT NULL DEFAULT '{"new":0,"negotiation":0,"proposal":0,"closed_won":0,"closed_lost":0}',
  recurring_strengths         TEXT[] NOT NULL DEFAULT '{}',
  recurring_weaknesses        TEXT[] NOT NULL DEFAULT '{}',
  summary_text                TEXT NOT NULL DEFAULT '',
  coaching_plan                TEXT NOT NULL DEFAULT '',
  model_used                  TEXT,
  generated_by                UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(vendedor_id, date)
);

CREATE INDEX IF NOT EXISTS idx_vendor_daily_analyses_vendedor_date
  ON public.vendor_daily_analyses (vendedor_id, date DESC);
