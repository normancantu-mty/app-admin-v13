-- ============================================================================
-- MIGRATION: entidad_precios  (Dual Pricing Model)
-- Purpose   : Replace the global-percentage commission model with per-product,
--             per-entity agreed prices split by sale fiscality:
--               precio_efectivo   — agreed factory price for LIBRE (cash) sales
--               precio_facturado  — agreed factory price for FULL_TAX (invoiced) sales
-- Usage     : Run via `supabase db push` or paste in the Supabase SQL editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.entidad_precios (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  id_entidad        uuid         NOT NULL
                      REFERENCES public.entidades(id) ON DELETE CASCADE,
  id_producto       uuid         NOT NULL
                      REFERENCES public.catalogo_productos(id) ON DELETE CASCADE,
  precio_efectivo   numeric(10,4) NOT NULL DEFAULT 0
                      CHECK (precio_efectivo  >= 0),
  precio_facturado  numeric(10,4) NOT NULL DEFAULT 0
                      CHECK (precio_facturado >= 0),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT entidad_precios_entidad_producto_unique
    UNIQUE (id_entidad, id_producto)
);

CREATE INDEX IF NOT EXISTS entidad_precios_id_entidad_idx
  ON public.entidad_precios (id_entidad);

CREATE INDEX IF NOT EXISTS entidad_precios_id_producto_idx
  ON public.entidad_precios (id_producto);

-- Auto-update updated_at on row changes.
-- CREATE OR REPLACE is safe to run multiple times.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entidad_precios_set_updated_at ON public.entidad_precios;
CREATE TRIGGER entidad_precios_set_updated_at
  BEFORE UPDATE ON public.entidad_precios
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row-Level Security ───────────────────────────────────────────────────────
ALTER TABLE public.entidad_precios ENABLE ROW LEVEL SECURITY;

-- ADMIN has full read/write access.
DROP POLICY IF EXISTS "entidad_precios_admin_all" ON public.entidad_precios;
CREATE POLICY "entidad_precios_admin_all"
  ON public.entidad_precios FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.entidades
      WHERE auth_id = auth.uid() AND rol = 'ADMIN'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.entidades
      WHERE auth_id = auth.uid() AND rol = 'ADMIN'
    )
  );

-- DST / LOC can read their own agreed prices (for self-service dashboards).
DROP POLICY IF EXISTS "entidad_precios_self_read" ON public.entidad_precios;
CREATE POLICY "entidad_precios_self_read"
  ON public.entidad_precios FOR SELECT TO authenticated
  USING (
    id_entidad IN (
      SELECT id FROM public.entidades WHERE auth_id = auth.uid()
    )
  );
