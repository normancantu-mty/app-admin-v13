-- Suscripciones: categoria de egreso + catalogo + estado de cada mes (2026-11-09). ADITIVA.
-- Fuente: app-admin supabase/migrations/20261109120000_suscripciones.sql. Reversa: supabase/ROLLBACK_suscripciones_2026-11-09.sql
INSERT INTO public.categorias_movimiento (tipo, categoria, subcategoria, orden, activa) VALUES
  ('EGRESO', 'Suscripciones', 'IA',                     65, true),
  ('EGRESO', 'Suscripciones', 'Software y nube',        66, true),
  ('EGRESO', 'Suscripciones', 'Marketing y mensajería', 67, true),
  ('EGRESO', 'Suscripciones', 'Otras',                  68, true)
ON CONFLICT (tipo, categoria, subcategoria) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.suscripciones (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre         text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 60),
  monto          numeric(12,2) NOT NULL CHECK (monto > 0 AND monto <= 500000),
  moneda         text NOT NULL DEFAULT 'MXN' CHECK (moneda IN ('MXN', 'USD')),
  dia_cobro      smallint CHECK (dia_cobro BETWEEN 1 AND 31),
  id_cuenta      uuid REFERENCES public.cuentas_financieras(id),
  subcategoria   text NOT NULL DEFAULT 'Otras'
                 CHECK (subcategoria IN ('IA', 'Software y nube', 'Marketing y mensajería', 'Otras')),
  activa         boolean NOT NULL DEFAULT true,
  notas          text CHECK (notas IS NULL OR length(notas) <= 200),
  creada_en      timestamptz NOT NULL DEFAULT now(),
  actualizada_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nombre)
);

COMMENT ON TABLE public.suscripciones IS
  'Catalogo de suscripciones (nombre, monto, moneda, dia de cobro, cuenta). El bot pregunta cada mes si ya se pagaron. 2026-11-09.';

CREATE TABLE IF NOT EXISTS public.suscripcion_meses (
  id_suscripcion     bigint NOT NULL REFERENCES public.suscripciones(id) ON DELETE CASCADE,
  mes                text NOT NULL CHECK (mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  estado             text NOT NULL DEFAULT 'PREGUNTADA'
                     CHECK (estado IN ('PREGUNTADA', 'POSPUESTA', 'PAGADA', 'BAJA')),
  preguntada_en      timestamptz NOT NULL DEFAULT now(),
  volver_a_preguntar timestamptz,
  id_movimiento      uuid REFERENCES public.finanzas_ledger(id),
  monto_pagado       numeric(12,2),
  resuelta_por       text,
  resuelta_en        timestamptz,
  id_mensaje         bigint,
  reenvios           smallint NOT NULL DEFAULT 0 CHECK (reenvios >= 0),
  motivo_pospuesta   text CHECK (motivo_pospuesta IN ('TODAVIA_NO', 'ENVIO_FALLIDO')),
  PRIMARY KEY (id_suscripcion, mes)
);

CREATE UNIQUE INDEX IF NOT EXISTS suscripcion_meses_id_movimiento_unico
  ON public.suscripcion_meses (id_movimiento) WHERE id_movimiento IS NOT NULL;

COMMENT ON TABLE public.suscripcion_meses IS
  'Una fila por suscripcion por mes. La PK es el reclamo: la pregunta del bot sale una vez aunque se reinicie. PAGADA apunta al egreso en finanzas_ledger.';

ALTER TABLE public.suscripciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suscripcion_meses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.suscripciones     FROM anon, authenticated;
REVOKE ALL ON TABLE public.suscripcion_meses FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.suscripciones     TO authenticated;
GRANT SELECT                 ON TABLE public.suscripcion_meses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.suscripciones     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.suscripcion_meses TO service_role;

DROP POLICY IF EXISTS suscripciones_sel_admin ON public.suscripciones;
CREATE POLICY suscripciones_sel_admin ON public.suscripciones
  FOR SELECT TO authenticated USING (public.mi_rol() = 'ADMIN');

DROP POLICY IF EXISTS suscripciones_esc_admin ON public.suscripciones;
CREATE POLICY suscripciones_esc_admin ON public.suscripciones
  FOR ALL TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');

DROP POLICY IF EXISTS suscripcion_meses_sel_admin ON public.suscripcion_meses;
CREATE POLICY suscripcion_meses_sel_admin ON public.suscripcion_meses
  FOR SELECT TO authenticated USING (public.mi_rol() = 'ADMIN');
