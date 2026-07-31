-- Guarda instance_name/phone_number previos cuando se aplica una corrección de
-- reconciliación, para poder deshacerla desde la UI sin tocar la base a mano.
ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS previous_values JSONB;
