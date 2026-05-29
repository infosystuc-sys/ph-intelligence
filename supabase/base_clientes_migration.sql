-- ============================================================
-- Migración: Base Clientes (reemplaza base_tn / Cancela y Renueva)
-- Ejecutar en Supabase → SQL Editor
-- ============================================================

-- 1) Limpiar el sistema anterior por completo
DROP FUNCTION IF EXISTS get_base_tn_batches();
DROP TABLE IF EXISTS public.base_tn CASCADE;

-- 2) Tabla nueva: una fila por (cliente + tarjeta)
CREATE TABLE IF NOT EXISTS public.base_clientes (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id     UUID        NOT NULL,                -- agrupa una importación
  batch_name   TEXT        NOT NULL,                -- nombre del lote (input del admin)
  localidad    TEXT,                                 -- de la columna LOCALIDAD del CSV
  cliente      TEXT,                                 -- de CLIENTE
  cuit_dni     TEXT,                                 -- de CUIT/DNI
  telefono_1   TEXT,                                 -- de TELEFONO 1 (puede ser múltiple separado por / -)
  telefono_2   TEXT,                                 -- de TELEFONO 2
  tarjeta      TEXT,                                 -- de TARJETA (VISA, MASTERCARD, NARANJA, etc.)
  observacion  TEXT,                                 -- de OBSERVACION
  imported_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para lookups por teléfono y DNI
CREATE INDEX IF NOT EXISTS idx_base_clientes_batch_id   ON public.base_clientes(batch_id);
CREATE INDEX IF NOT EXISTS idx_base_clientes_telefono_1 ON public.base_clientes(telefono_1);
CREATE INDEX IF NOT EXISTS idx_base_clientes_telefono_2 ON public.base_clientes(telefono_2);
CREATE INDEX IF NOT EXISTS idx_base_clientes_cuit_dni   ON public.base_clientes(cuit_dni);

-- RLS
ALTER TABLE public.base_clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_supervisors_select_base_clientes"
  ON public.base_clientes FOR SELECT
  USING (get_user_role() IN ('admin', 'supervisor'));

CREATE POLICY "admins_insert_base_clientes"
  ON public.base_clientes FOR INSERT
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "admins_delete_base_clientes"
  ON public.base_clientes FOR DELETE
  USING (get_user_role() = 'admin');

-- 3) RPC para listar los lotes (evita traer N filas al frontend)
CREATE OR REPLACE FUNCTION get_base_clientes_batches()
RETURNS TABLE (
  batch_id   UUID,
  batch_name TEXT,
  created_at TIMESTAMPTZ,
  count      BIGINT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    batch_id,
    MIN(batch_name) AS batch_name,
    MIN(created_at) AS created_at,
    COUNT(*)        AS count
  FROM public.base_clientes
  GROUP BY batch_id
  ORDER BY MIN(created_at) DESC;
$$;

-- 4) Adaptar la tabla conversations: nuevos campos para el badge
--    Eliminamos cod_cliente y base_source (no se usan más).
ALTER TABLE public.conversations DROP COLUMN IF EXISTS cod_cliente;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS base_source;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS base_localidad TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS base_tarjetas  TEXT[] DEFAULT '{}';
