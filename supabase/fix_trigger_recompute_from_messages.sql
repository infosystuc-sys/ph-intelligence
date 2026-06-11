-- Fix: el trigger de INSERT calcula last_message_at y last_message_from_me
-- directamente desde la tabla messages, en lugar de depender del valor previo
-- de last_message_at en conversations.
--
-- Por qué: N8N upsertea conversations seteando last_message_at = msg_timestamp
-- del mensaje que está procesando. Si N8N procesa un mensaje rezagado (más viejo)
-- después de uno nuevo, su upsert pisa last_message_at hacia atrás. Después el
-- trigger de INSERT compara NEW.msg_timestamp con el ya-pisado last_message_at
-- y termina actualizando last_message_from_me con el from_me del mensaje viejo.
--
-- Solución: el trigger ignora el valor que esté en conversations.last_message_at
-- y recomputa desde messages (que es la fuente de verdad inviolable).
-- Como messages.external_id es UNIQUE y los inserts son idempotentes, esta
-- operación es 100% determinística.

-- ── 1. Asegurar índice para que el ORDER BY msg_timestamp DESC LIMIT 1 sea barato.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts_desc
ON messages (conversation_id, msg_timestamp DESC);

-- ── 2. Reemplazar el trigger de INSERT con la versión robusta.
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_max_ts       timestamptz;
  v_max_from_me  boolean;
BEGIN
  -- Recomputar el verdadero "mensaje más reciente" desde messages.
  -- NEW ya está adentro de la tabla (AFTER INSERT), así que la query lo incluye.
  SELECT msg_timestamp, from_me
    INTO v_max_ts, v_max_from_me
  FROM messages
  WHERE conversation_id = NEW.conversation_id
  ORDER BY msg_timestamp DESC
  LIMIT 1;

  UPDATE conversations
  SET
    message_count        = COALESCE(message_count, 0) + 1,
    last_message_at      = v_max_ts,
    last_message_from_me = v_max_from_me
  WHERE id = NEW.conversation_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Re-backfill para corregir las filas que ya quedaron desincronizadas.
--      Misma query que el migration original — solo toca filas con drift.
WITH latest AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    msg_timestamp,
    from_me
  FROM messages
  ORDER BY conversation_id, msg_timestamp DESC
)
UPDATE conversations c
SET
  last_message_at      = l.msg_timestamp,
  last_message_from_me = l.from_me
FROM latest l
WHERE c.id = l.conversation_id
  AND (
    c.last_message_at      IS DISTINCT FROM l.msg_timestamp
    OR c.last_message_from_me IS DISTINCT FROM l.from_me
  );

-- ── 4. Verificación: debería volver 0 filas
-- SELECT c.id, c.last_message_from_me AS persisted, m.from_me AS real
-- FROM conversations c
-- JOIN LATERAL (
--   SELECT from_me FROM messages
--   WHERE conversation_id = c.id
--   ORDER BY msg_timestamp DESC LIMIT 1
-- ) m ON true
-- WHERE c.last_message_from_me IS DISTINCT FROM m.from_me
-- LIMIT 10;
