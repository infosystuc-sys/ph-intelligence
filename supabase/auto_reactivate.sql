-- =====================================================================
-- Reactivación automática: conversación en historico → active
-- cuando llega un mensaje nuevo (vía N8N o sync)
-- Ejecutar en Supabase SQL Editor
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_fn_reactivate_on_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations
  SET status = 'active'
  WHERE id = NEW.conversation_id
    AND status = 'historico';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reactivate_historico ON messages;
CREATE TRIGGER trg_reactivate_historico
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION trg_fn_reactivate_on_new_message();
