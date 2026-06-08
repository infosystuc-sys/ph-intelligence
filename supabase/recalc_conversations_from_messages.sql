-- Recalcular last_message_at y message_count en conversations usando messages como fuente de verdad
--
-- Contexto del bug:
-- N8N upsertea conversations con last_message_at = timestamp del mensaje que disparó el webhook.
-- Pero (1) no upsertea message_count, y (2) durante el procesamiento del backlog tras la caída
-- de la VM (27/5 - 8/6), mensajes viejos llegaron a procesarse después de los nuevos y pisaron
-- el last_message_at con un valor anterior al real. Resultado: las cards de la UI mostraban
-- "0 mensajes" y sin fecha, aunque los mensajes existían en la tabla messages.
--
-- Esta consulta toma el MAX(msg_timestamp) y COUNT(*) reales de la tabla messages
-- y los aplica a cada conversación. Solo actualiza si los valores difieren — no hace
-- trabajo innecesario.

WITH agg AS (
  SELECT
    conversation_id,
    MAX(msg_timestamp) AS max_ts,
    COUNT(*)::int      AS cnt
  FROM messages
  GROUP BY conversation_id
)
UPDATE conversations c
SET
  last_message_at = agg.max_ts,
  message_count   = agg.cnt
FROM agg
WHERE c.id = agg.conversation_id
  AND (
    c.last_message_at IS DISTINCT FROM agg.max_ts
    OR c.message_count IS DISTINCT FROM agg.cnt
  );

-- Para conversations que no tienen ningún mensaje en `messages`, limpiar los aggregates:
-- message_count = 0 y last_message_at = NULL. Cubre tanto los NULL como los valores
-- incorrectos heredados (ej. N8N upsertea una fila con message_count > 0 y/o
-- last_message_at seteado pero el INSERT del mensaje falla → "fantasma").
-- Quedan al fondo del listado por last_message_at IS NULL.
UPDATE conversations c
SET
  message_count   = 0,
  last_message_at = NULL
WHERE (c.message_count IS DISTINCT FROM 0 OR c.last_message_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id);

-- Verificación rápida (opcional, comentada):
-- SELECT
--   COUNT(*) FILTER (WHERE last_message_at IS NULL) AS sin_last_at,
--   COUNT(*) FILTER (WHERE message_count = 0)       AS sin_count,
--   COUNT(*)                                         AS total
-- FROM conversations;
