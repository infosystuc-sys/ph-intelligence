-- =====================================================================
-- Matching automático de teléfonos: conversations ↔ base_tn
-- Ejecutar en Supabase SQL Editor
-- =====================================================================

-- 1. Columnas en conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cod_cliente TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS base_source TEXT;

-- 2. Función de normalización de teléfono (compatible con Argentina)
--    Elimina +549, +54, 0 inicial, deja solo dígitos locales
CREATE OR REPLACE FUNCTION normalize_phone_arg(phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d TEXT;
BEGIN
  d := regexp_replace(phone, '[^0-9]', '', 'g');
  IF d LIKE '549%' THEN d := substring(d FROM 4);
  ELSIF d LIKE '54%' THEN d := substring(d FROM 3);
  END IF;
  IF d LIKE '0%' THEN d := substring(d FROM 2); END IF;
  RETURN d;
END;
$$;

-- 3. Función del trigger: busca coincidencia en base_tn al crear/actualizar conversación
--    Prioridad: naranja (tiene cod_cliente) > cancela_renueva; más reciente primero
CREATE OR REPLACE FUNCTION trg_fn_match_base_tn()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_norm TEXT;
  v_match RECORD;
BEGIN
  v_norm := normalize_phone_arg(NEW.client_phone);
  IF length(v_norm) < 8 THEN RETURN NEW; END IF;

  SELECT b.cod_cliente, b.source
  INTO v_match
  FROM base_tn b
  WHERE (
    normalize_phone_arg(b.telefono_1) = v_norm
    OR (b.telefono_2 IS NOT NULL AND normalize_phone_arg(b.telefono_2) = v_norm)
  )
  ORDER BY
    CASE WHEN b.source = 'naranja' THEN 0 ELSE 1 END,
    b.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    NEW.cod_cliente := v_match.cod_cliente;
    NEW.base_source := v_match.source;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Trigger: se ejecuta antes de INSERT o cuando cambia client_phone
DROP TRIGGER IF EXISTS trg_match_base_tn ON conversations;
CREATE TRIGGER trg_match_base_tn
  BEFORE INSERT OR UPDATE OF client_phone
  ON conversations
  FOR EACH ROW
  WHEN (NEW.client_phone IS NOT NULL)
  EXECUTE FUNCTION trg_fn_match_base_tn();

-- 5. Función RPC para matching retroactivo de todas las conversaciones existentes
--    Llamar una vez desde Settings o cuando se importe una nueva base
CREATE OR REPLACE FUNCTION match_all_conversations_to_base_tn()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_conv RECORD;
  v_norm TEXT;
  v_match RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_conv IN
    SELECT id, client_phone FROM conversations WHERE client_phone IS NOT NULL
  LOOP
    v_norm := normalize_phone_arg(v_conv.client_phone);
    IF length(v_norm) < 8 THEN CONTINUE; END IF;

    SELECT b.cod_cliente, b.source
    INTO v_match
    FROM base_tn b
    WHERE (
      normalize_phone_arg(b.telefono_1) = v_norm
      OR (b.telefono_2 IS NOT NULL AND normalize_phone_arg(b.telefono_2) = v_norm)
    )
    ORDER BY
      CASE WHEN b.source = 'naranja' THEN 0 ELSE 1 END,
      b.created_at DESC
    LIMIT 1;

    IF FOUND THEN
      UPDATE conversations
        SET cod_cliente = v_match.cod_cliente,
            base_source = v_match.source
      WHERE id = v_conv.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;
