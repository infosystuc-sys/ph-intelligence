-- ============================================================
-- Función para obtener el historial de lotes de base_tn
-- agrupado en la BD, sin traer todas las filas al servidor.
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

CREATE OR REPLACE FUNCTION get_base_tn_batches()
RETURNS TABLE (
  batch_id   UUID,
  periodo    TEXT,
  sucursal   TEXT,
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
    MIN(created_at) AS created_at,
    COUNT(*)        AS count
  FROM public.base_tn
  GROUP BY batch_id, periodo, sucursal
  ORDER BY MIN(created_at) DESC;
$$;
