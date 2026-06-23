-- Función: estadística de conversaciones INICIADAS por el vendedor por día,
-- y cuántas recibieron respuesta del cliente EN EL MISMO DÍA.
--
-- Definiciones (acordadas el 11/6/2026, redefinidas el 23/6/2026):
-- - "Iniciada": el vendedor (from_me = true) mandó el PRIMER mensaje del día
--   argentino en esa conversación, sin importar la antigüedad/actividad previa
--   de la conversación. (Antes exigía 10 días sin actividad previa; se quitó esa
--   restricción porque generaba un número más bajo de lo esperado: conversaciones
--   activas el día anterior y reabiertas por el vendedor hoy también cuentan.)
-- - "Respondida": esa conversación iniciada recibió al menos un mensaje del
--   cliente (from_me = false) posterior al mensaje inicial Y dentro del mismo
--   día argentino.
-- - Día = fecha en America/Argentina/Buenos_Aires. msg_timestamp se guarda como
--   timestamptz pero el valor crudo YA es la hora de pared AR (mal etiquetada
--   como UTC+00:00 por el proceso de ingesta) — por eso la fecha se extrae con
--   `AT TIME ZONE 'UTC'` (sin corrimiento real) y NO con
--   `AT TIME ZONE 'America/Argentina/Buenos_Aires'` (que restaría 3hs de más).
-- - Una conversación cuenta una sola vez por (vendedor, día) aunque el vendedor
--   haya mandado varios mensajes ese día.
-- - Exclusiones: grupos (@g.us), linked-ids (@lid), teléfonos de empleados,
--   conversaciones sin vendedor asignado.
--
-- Uso: SELECT * FROM get_vendor_initiated_stats('2026-06-01', '2026-06-11');

CREATE OR REPLACE FUNCTION get_vendor_initiated_stats(p_start date, p_end date)
RETURNS TABLE(vendedor_id uuid, day date, initiated int, responded int)
LANGUAGE sql STABLE AS $$
WITH qualifying AS (
  -- Mensajes del vendedor que califican como "inicio de conversación"
  SELECT
    c.vendedor_id,
    m.conversation_id,
    m.msg_timestamp,
    (m.msg_timestamp AT TIME ZONE 'UTC')::date AS day_ar
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.from_me = true
    AND c.vendedor_id IS NOT NULL
    AND c.remote_jid NOT LIKE '%@g.us'
    AND c.remote_jid NOT LIKE '%@lid'
    AND (m.msg_timestamp AT TIME ZONE 'UTC')::date BETWEEN p_start AND p_end
    AND NOT EXISTS (
      SELECT 1 FROM employee_phones ep WHERE ep.phone = c.client_phone
    )
),
-- Colapsar a una fila por (vendedor, conversación, día): el primer mensaje del día
first_per_day AS (
  SELECT DISTINCT ON (vendedor_id, conversation_id, day_ar)
    vendedor_id, conversation_id, day_ar, msg_timestamp
  FROM qualifying
  ORDER BY vendedor_id, conversation_id, day_ar, msg_timestamp ASC
),
-- Marcar si el cliente respondió DESPUÉS del inicio y DENTRO del mismo día AR
flagged AS (
  SELECT
    f.vendedor_id,
    f.day_ar,
    EXISTS (
      SELECT 1 FROM messages r
      WHERE r.conversation_id = f.conversation_id
        AND r.from_me = false
        AND r.msg_timestamp > f.msg_timestamp
        AND (r.msg_timestamp AT TIME ZONE 'UTC')::date = f.day_ar
    ) AS responded
  FROM first_per_day f
)
SELECT
  vendedor_id,
  day_ar AS day,
  COUNT(*)::int                            AS initiated,
  COUNT(*) FILTER (WHERE responded)::int   AS responded
FROM flagged
GROUP BY vendedor_id, day_ar
ORDER BY day_ar DESC, initiated DESC;
$$;

-- Índice de soporte (idempotente — probablemente ya existe de migraciones previas)
CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts_desc
ON messages (conversation_id, msg_timestamp DESC);

-- Verificación rápida:
-- SELECT * FROM get_vendor_initiated_stats(CURRENT_DATE - 7, CURRENT_DATE);
