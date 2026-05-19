-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK: Drop entidad_precios + add aplica_redondeo_costo to entidades
-- Run this migration to roll back the Dual/Fixed-Pricing model and switch
-- to the lean global-percentage + cost-rounding commission model.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop the pricing matrix table (cascade removes any FK references / policies)
DROP TABLE IF EXISTS public.entidad_precios CASCADE;

-- 2. Ensure the percentage commission columns exist (they should already; this is
--    a safety net for any environment that may have had them removed).
ALTER TABLE public.entidades
  ADD COLUMN IF NOT EXISTS comision_base         numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comision_base_local   numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comision_hijo_local   numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comision_logistica    numeric(5,4) NOT NULL DEFAULT 0;

-- 3. Add the rounding toggle (default TRUE = always round distributor cost up,
--    eliminating fractional pesos from their pricing).
ALTER TABLE public.entidades
  ADD COLUMN IF NOT EXISTS aplica_redondeo_costo boolean NOT NULL DEFAULT true;

-- 4. Back-fill existing rows so the default is visible immediately.
UPDATE public.entidades
   SET aplica_redondeo_costo = true
 WHERE aplica_redondeo_costo IS NULL;
