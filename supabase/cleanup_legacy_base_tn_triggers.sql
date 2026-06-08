-- Cleanup de funciones/triggers huérfanos que apuntaban a la tabla base_tn
--
-- Historia del bug:
-- El 27/5/2026 se aplicó base_clientes_migration.sql que hace DROP TABLE base_tn CASCADE.
-- CASCADE drop-ea SOLO dependencias explícitas (FKs, vistas declaradas, etc.) —
-- pero NO drop-ea funciones plpgsql que tienen el nombre de la tabla embebido
-- como texto en su cuerpo, porque PostgreSQL no analiza el SQL embebido para detectar
-- dependencias.
--
-- Consecuencia: quedaron vivas estas funciones (y los triggers que las usan) que en cada
-- INSERT/UPDATE de `conversations` intentaban hacer SELECT contra base_tn y fallaban con
-- "42P01: relation \"base_tn\" does not exist". El error abortaba la transacción
-- → la conversación/mensaje no se persistía → N8N, sync manual, y cualquier upsert
-- fallaban con 404.
--
-- Fix: DROP FUNCTION ... CASCADE elimina la función y todos los triggers que la usan
-- automáticamente. Es seguro porque la lógica de match con base_clientes ahora se hace
-- desde la app (endpoint /api/base-clientes/match-retroactive), no con triggers.

DROP FUNCTION IF EXISTS trg_fn_match_base_tn()                CASCADE;
DROP FUNCTION IF EXISTS match_all_conversations_to_base_tn()  CASCADE;

-- Verificación post-fix: ambas queries deben devolver 0 filas.

-- 1. ¿Queda algún objeto referenciando base_tn?
-- SELECT routine_name FROM information_schema.routines WHERE routine_definition ILIKE '%base_tn%';

-- 2. ¿Quedan triggers huérfanos en conversations?
-- SELECT tgname FROM pg_trigger t
--   JOIN pg_class c ON t.tgrelid = c.oid
--   WHERE c.relname = 'conversations' AND NOT t.tgisinternal;
