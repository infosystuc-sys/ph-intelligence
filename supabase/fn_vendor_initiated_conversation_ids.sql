-- Devuelve los conversation_id detrás de los números "Iniciadas"/"Con respuesta"
-- de la tabla "Conversaciones iniciadas por vendedor" del dashboard, para que el
-- click en esos números muestre exactamente esas conversaciones en /conversations.
--
-- Reutiliza la MISMA definición de "iniciada"/"respondida" que
-- get_vendor_initiated_stats (ver supabase/fn_vendor_initiated_stats.sql,
-- redefinida el 23/6/2026: primer mensaje del día del vendedor, sin exigir
-- dormancy previa) — se duplican las CTEs en vez de compartirlas para mantener
-- cada función simple e independiente.
--
-- p_vendedor_id NULL → todas las del día (fila "Total" de la tabla).
-- p_responded_only TRUE → solo las que además recibieron respuesta del cliente
--   ese mismo día (columna "Con respuesta"); FALSE → todas las iniciadas.
--
-- Uso: SELECT * FROM get_vendor_initiated_conversation_ids('2026-06-20', NULL, false);

CREATE OR REPLACE FUNCTION get_vendor_initiated_conversation_ids(
  p_day date,
  p_vendedor_id uuid DEFAULT NULL,
  p_responded_only boolean DEFAULT false
)
RETURNS TABLE(conversation_id uuid, vendedor_id uuid)
LANGUAGE sql STABLE AS $$
WITH qualifying AS (
  SELECT
    c.vendedor_id,
    m.conversation_id,
    m.msg_timestamp,
    (m.msg_timestamp AT TIME ZONE 'UTC')::date AS day_ar
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.from_me = true
    AND c.vendedor_id IS NOT NULL
    AND (p_vendedor_id IS NULL OR c.vendedor_id = p_vendedor_id)
    AND c.remote_jid NOT LIKE '%@g.us'
    AND c.remote_jid NOT LIKE '%@lid'
    AND (m.msg_timestamp AT TIME ZONE 'UTC')::date = p_day
    AND NOT EXISTS (
      SELECT 1 FROM employee_phones ep WHERE ep.phone = c.client_phone
    )
),
first_per_day AS (
  SELECT DISTINCT ON (vendedor_id, conversation_id, day_ar)
    vendedor_id, conversation_id, day_ar, msg_timestamp
  FROM qualifying
  ORDER BY vendedor_id, conversation_id, day_ar, msg_timestamp ASC
)
SELECT f.conversation_id, f.vendedor_id
FROM first_per_day f
WHERE NOT p_responded_only OR EXISTS (
  SELECT 1 FROM messages r
  WHERE r.conversation_id = f.conversation_id
    AND r.from_me = false
    AND r.msg_timestamp > f.msg_timestamp
    AND (r.msg_timestamp AT TIME ZONE 'UTC')::date = f.day_ar
);
$$;
