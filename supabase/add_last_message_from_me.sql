-- Denormaliza `from_me` del último mensaje en la tabla conversations.
--
-- Contexto:
-- La UI necesita saber rápido si el último mensaje fue del cliente o del vendedor
-- (para colorear la fecha por urgencia). Hacer el JOIN con messages en cada render
-- es caro, y el endpoint /api/conversations no lo trae en su SELECT *. El dato sí
-- vive en `messages.from_me` del mensaje con MAX(msg_timestamp).
--
-- Solución: agregar columna `last_message_from_me` y mantenerla sincronizada por
-- el trigger que ya tenemos sobre INSERT/DELETE en messages.

-- ── 1. Agregar la columna (nullable; null = sin mensajes aún)
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS last_message_from_me boolean;

-- ── 2. Reemplazar el trigger de INSERT para también setear last_message_from_me
--      cuando el nuevo mensaje es el más reciente.
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_insert()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET
    message_count   = COALESCE(message_count, 0) + 1,
    last_message_at = GREATEST(COALESCE(last_message_at, NEW.msg_timestamp), NEW.msg_timestamp),
    -- Solo actualizar from_me si el mensaje es el más reciente (no si llega tarde)
    last_message_from_me = CASE
      WHEN NEW.msg_timestamp >= COALESCE(last_message_at, NEW.msg_timestamp)
      THEN NEW.from_me
      ELSE last_message_from_me
    END
  WHERE id = NEW.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Reemplazar el trigger de DELETE para refrescar from_me al MAX restante
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_new_max_ts   timestamptz;
  v_new_from_me  boolean;
BEGIN
  SELECT msg_timestamp, from_me
    INTO v_new_max_ts, v_new_from_me
  FROM messages
  WHERE conversation_id = OLD.conversation_id
    AND id <> OLD.id
  ORDER BY msg_timestamp DESC
  LIMIT 1;

  UPDATE conversations
  SET
    message_count        = GREATEST(COALESCE(message_count, 0) - 1, 0),
    last_message_at      = v_new_max_ts,
    last_message_from_me = v_new_from_me
  WHERE id = OLD.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Backfill: poblar la columna nueva con el from_me del mensaje más reciente
--      de cada conversación.
WITH latest AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    from_me
  FROM messages
  ORDER BY conversation_id, msg_timestamp DESC
)
UPDATE conversations c
SET last_message_from_me = l.from_me
FROM latest l
WHERE c.id = l.conversation_id
  AND c.last_message_from_me IS DISTINCT FROM l.from_me;

-- ── 5. Verificación opcional: ¿queda algún desajuste?
-- SELECT c.id, c.last_message_from_me AS persisted, m.from_me AS real
-- FROM conversations c
-- JOIN LATERAL (
--   SELECT from_me FROM messages
--   WHERE conversation_id = c.id
--   ORDER BY msg_timestamp DESC LIMIT 1
-- ) m ON true
-- WHERE c.last_message_from_me IS DISTINCT FROM m.from_me
-- LIMIT 10;
