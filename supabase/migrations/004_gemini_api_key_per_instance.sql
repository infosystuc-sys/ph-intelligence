-- Key de Gemini por instancia de WhatsApp. Nullable: sin valor, el análisis IA
-- de esa instancia sigue usando la GEMINI_API_KEY global (env var) como fallback.
-- Permite repartir el análisis entre varias keys de Gemini y evitar el límite
-- de cuota de una sola key compartida por todas las instancias.
ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS gemini_api_key text;
