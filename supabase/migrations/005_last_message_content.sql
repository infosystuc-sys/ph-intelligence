-- Denormaliza el CONTENIDO del último mensaje en conversations.
--
-- Por qué: para filtrar "Sin Respuesta +24hs" excluyendo saludos/cierres (no solo
-- por from_me + tiempo) se necesita el texto del último mensaje. Sin esta columna,
-- calcularlo en vivo implica un JOIN/query por conversación contra `messages` —
-- carísimo para un KPI que se recalcula en cada carga del dashboard. Se mantiene
-- sincronizada por los mismos triggers que ya mantienen last_message_at/from_me
-- (ver trigger_sync_conversation_aggregates.sql, add_last_message_from_me.sql,
-- fix_trigger_recompute_from_messages.sql).
--
-- Efecto secundario útil: las cards de Conversaciones hoy muestran "—" como
-- preview hasta que llega un mensaje por Realtime después de cargar la página
-- (no hay JOIN a messages en /api/conversations). Con esta columna, `select('*')`
-- ya la trae y el preview aparece correcto desde la carga inicial.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_content text;

-- ── Trigger de INSERT: recomputa también el contenido junto con ts/from_me ─────
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_max_ts       timestamptz;
  v_max_from_me  boolean;
  v_max_content  text;
BEGIN
  SELECT msg_timestamp, from_me, content
    INTO v_max_ts, v_max_from_me, v_max_content
  FROM messages
  WHERE conversation_id = NEW.conversation_id
  ORDER BY msg_timestamp DESC
  LIMIT 1;

  UPDATE conversations
  SET
    message_count         = COALESCE(message_count, 0) + 1,
    last_message_at       = v_max_ts,
    last_message_from_me  = v_max_from_me,
    last_message_content  = v_max_content
  WHERE id = NEW.conversation_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── Trigger de DELETE: idem, recomputando sin la fila borrada ──────────────────
CREATE OR REPLACE FUNCTION trg_sync_conv_on_msg_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_new_max_ts       timestamptz;
  v_new_from_me      boolean;
  v_new_content      text;
BEGIN
  SELECT msg_timestamp, from_me, content
    INTO v_new_max_ts, v_new_from_me, v_new_content
  FROM messages
  WHERE conversation_id = OLD.conversation_id
    AND id <> OLD.id
  ORDER BY msg_timestamp DESC
  LIMIT 1;

  UPDATE conversations
  SET
    message_count         = GREATEST(COALESCE(message_count, 0) - 1, 0),
    last_message_at       = v_new_max_ts,
    last_message_from_me  = v_new_from_me,
    last_message_content  = v_new_content
  WHERE id = OLD.conversation_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── Backfill: poblar la columna nueva para conversaciones ya existentes ────────
WITH latest AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    content
  FROM messages
  ORDER BY conversation_id, msg_timestamp DESC
)
UPDATE conversations c
SET last_message_content = l.content
FROM latest l
WHERE c.id = l.conversation_id
  AND c.last_message_content IS DISTINCT FROM l.content;
