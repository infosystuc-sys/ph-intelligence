-- ============================================================
-- Migración incremental: extender conversations con campos del match
-- Ejecutar en Supabase → SQL Editor (sobre el schema ya migrado de base_clientes)
-- ============================================================

-- Cliente, CUIT/DNI y observación del CSV se guardan en la conversación
-- para no depender del lookup en memoria y poder usar el nombre del CSV en
-- todas las vistas (card, header, histórico, análisis).
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS base_cliente     TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS base_cuit_dni    TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS base_observacion TEXT;
