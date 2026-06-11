-- Limpieza de conversaciones "vacías" sin metadata útil.
--
-- Contexto:
-- N8N upsertea una fila en `conversations` cada vez que llega un evento
-- `messages.upsert` desde Evolution, incluyendo eventos protocolares
-- (senderKeyDistributionMessage, messageContextInfo, reactionMessage,
-- secretEncryptedMessage, read receipts, etc.) que NO llevan contenido
-- visible. El nodo posterior que inserta en `messages` filtra el contenido
-- vacío → la conversación queda creada pero sin mensajes.
--
-- Criterio para borrar (estricto — solo lo que es 100% seguro borrar):
--   1. NO tiene ni un mensaje real en la tabla `messages`
--   2. NO tiene `display_name` (el usuario no la editó manualmente)
--   3. NO tiene ningún campo del match con base_clientes
--   4. NO tiene análisis IA asociado
--   5. status NO es 'historico' (esas tienen su propia página)
--
-- Conversaciones que CUMPLAN al menos UNA condición editable
-- (display_name, base_cliente, ai_analysis…) se preservan aunque tengan 0
-- mensajes — porque representan intención del usuario.

-- ── PASO 1: Contar primero. Correr esto, mirar el número, decidir si avanzar.
WITH borrables AS (
  SELECT c.id
  FROM conversations c
  WHERE c.status IN ('active', 'pending', 'closed')
    AND c.display_name     IS NULL
    AND c.base_cliente     IS NULL
    AND c.base_cuit_dni    IS NULL
    AND c.base_localidad   IS NULL
    AND (c.base_tarjetas IS NULL OR array_length(c.base_tarjetas, 1) IS NULL)
    AND c.base_observacion IS NULL
    AND NOT EXISTS (SELECT 1 FROM messages    m WHERE m.conversation_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.conversation_id = c.id)
)
SELECT
  COUNT(*) AS conversaciones_a_borrar,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations c2 WHERE c2.id = b.id AND c2.remote_jid LIKE '%@lid'))  AS de_lid,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations c2 WHERE c2.id = b.id AND c2.remote_jid LIKE '%@g.us')) AS de_grupos,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations c2 WHERE c2.id = b.id AND c2.remote_jid NOT LIKE '%@lid' AND c2.remote_jid NOT LIKE '%@g.us')) AS individuales
FROM borrables b;

-- ── PASO 2: Si el número de arriba es razonable, descomentar y correr el DELETE.
-- ────────────────────────────────────────────────────────────────────────────
-- WITH borrables AS (
--   SELECT c.id
--   FROM conversations c
--   WHERE c.status IN ('active', 'pending', 'closed')
--     AND c.display_name     IS NULL
--     AND c.base_cliente     IS NULL
--     AND c.base_cuit_dni    IS NULL
--     AND c.base_localidad   IS NULL
--     AND (c.base_tarjetas IS NULL OR array_length(c.base_tarjetas, 1) IS NULL)
--     AND c.base_observacion IS NULL
--     AND NOT EXISTS (SELECT 1 FROM messages    m WHERE m.conversation_id = c.id)
--     AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.conversation_id = c.id)
-- )
-- DELETE FROM conversations
-- WHERE id IN (SELECT id FROM borrables);
