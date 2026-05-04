-- ============================================================
-- Migración: Soporte para análisis IA automático en background
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

-- Columna que registra cuándo se disparó el último análisis automático.
-- Distinta de analyzed_at en ai_analyses (que es por cada análisis manual o auto).
-- Permite enforcer el cooldown de 2 horas por conversación sin joins costosos.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_auto_analysis_at TIMESTAMPTZ;

-- Índice para que la query de selección de candidatos sea rápida
CREATE INDEX IF NOT EXISTS idx_conversations_auto_analysis
  ON public.conversations (status, message_count, last_message_at DESC, last_auto_analysis_at);
