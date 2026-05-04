-- ============================================================
-- Migración: Base Cancela y Renueva
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

-- 1. Columna que identifica el origen del lote
ALTER TABLE public.base_tn
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'naranja';

-- 2. Dirección (exclusivo de Cancela y Renueva)
ALTER TABLE public.base_tn
  ADD COLUMN IF NOT EXISTS domicilio TEXT;

-- 3. Cuotas a vencer (exclusivo de Cancela y Renueva)
ALTER TABLE public.base_tn
  ADD COLUMN IF NOT EXISTS cuotas_a_vencer TEXT;

-- 4. Índice para filtrar por origen
CREATE INDEX IF NOT EXISTS idx_base_tn_source
  ON public.base_tn (source, created_at DESC);

-- 5. Actualizar la función RPC para incluir el campo source
CREATE OR REPLACE FUNCTION get_base_tn_batches()
RETURNS TABLE (
  batch_id   UUID,
  periodo    TEXT,
  sucursal   TEXT,
  source     TEXT,
  created_at TIMESTAMPTZ,
  count      BIGINT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    batch_id,
    periodo,
    sucursal,
    MIN(source)     AS source,
    MIN(created_at) AS created_at,
    COUNT(*)        AS count
  FROM public.base_tn
  GROUP BY batch_id, periodo, sucursal
  ORDER BY MIN(created_at) DESC;
$$;
