-- =====================================================================
-- Corrección: agregar 'historico' como valor válido para status
-- en la tabla conversations.
--
-- El problema: PostgreSQL puede tener un CHECK constraint en la columna
-- status que no incluye 'historico', haciendo que el UPDATE falle
-- silenciosamente desde la aplicación.
--
-- Ejecutar en Supabase SQL Editor (dashboard.supabase.com → SQL Editor)
-- =====================================================================

-- 1. Ver qué constraint existe actualmente (diagnóstico)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'conversations'::regclass
  AND contype = 'c';

-- 2. Eliminar el CHECK constraint existente (si existe)
--    Reemplazar "conversations_status_check" con el nombre real
--    que arroje la consulta anterior.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;

-- 3. Agregar el nuevo CHECK constraint con 'historico' incluido
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('active', 'closed', 'pending', 'historico'));

-- 4. Verificar que conversaciones existentes no violen la restricción
--    (esta query no modifica nada, solo informa)
SELECT DISTINCT status, COUNT(*) AS cantidad
FROM conversations
GROUP BY status
ORDER BY status;
