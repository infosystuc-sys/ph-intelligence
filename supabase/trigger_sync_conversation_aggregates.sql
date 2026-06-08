-- Trigger: mantiene conversations.last_message_at y conversations.message_count
-- automáticamente sincronizados con la tabla messages.
--
-- Por qué este trigger:
-- - N8N upsertea conversations pero no setea message_count → siempre quedaba en 0/null.
-- - N8N puede procesar mensajes fuera de orden (especialmente al procesar un backlog
--   tras una caída), lo que hace que un mensaje viejo sobrescriba last_message_at con
--   un timestamp anterior al real.
-- - Cualquier inserción de mensajes (sync desde Evolution, N8N, backfill manual) corre
--   por la tabla messages — así que un trigger ahí cubre todos los caminos.
--
-- Por qué es seguro:
-- - Usa GREATEST para last_message_at → mensajes desordenados ya NO retroceden la fecha.
-- - El trigger es AFTER INSERT/DELETE → no bloquea la operación principal si falla.
-- - No depende de tablas externas (a diferencia del trigger trg_fn_match_base_tn que nos
--   rompió N8N el 27/5).

-- ── INSERT ────────────────────────────────────────────────────────────────────
-- Cuando se inserta un mensaje, actualizamos su conversación:
--   message_count += 1
--   last_message_at = max(last_message_at, NEW.msg_timestamp)
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_insert()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET
    message_count   = COALESCE(message_count, 0) + 1,
    last_message_at = GREATEST(COALESCE(last_message_at, NEW.msg_timestamp), NEW.msg_timestamp)
  WHERE id = NEW.conversation_id;
  RETURN NULL;  -- AFTER trigger, return value ignorado
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_conv_on_msg_insert ON messages;
CREATE TRIGGER sync_conv_on_msg_insert
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION trg_sync_conv_on_msg_insert();

-- ── DELETE ────────────────────────────────────────────────────────────────────
-- Cuando se borra un mensaje, recalculamos message_count y, si el borrado era el
-- más reciente, refrescamos last_message_at con el nuevo MAX (o null si no quedan).
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET
    message_count   = GREATEST(COALESCE(message_count, 0) - 1, 0),
    last_message_at = (
      SELECT MAX(msg_timestamp)
      FROM messages
      WHERE conversation_id = OLD.conversation_id
        AND id <> OLD.id
    )
  WHERE id = OLD.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_conv_on_msg_delete ON messages;
CREATE TRIGGER sync_conv_on_msg_delete
AFTER DELETE ON messages
FOR EACH ROW
EXECUTE FUNCTION trg_sync_conv_on_msg_delete();

-- Nota: no se agrega trigger AFTER UPDATE porque en este sistema los mensajes
-- son inmutables (upsert con ignoreDuplicates, no se editan en lugar). Si en el
-- futuro se permite editar msg_timestamp, hay que agregarlo.
