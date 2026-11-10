-- ============================================================================
-- Suscripciones: categoria de egreso + catalogo + estado de cada mes
-- Escrito el 2026-11-09 por el Socio (ejecutor). ADITIVA: no toca ninguna
-- columna ni fila existente. Reversa: supabase/ROLLBACK_suscripciones_2026-11-09.sql
-- ============================================================================
-- Norman (2026-11-09, por voz): "crea una nueva categoria que se llame
-- Suscripciones y que me pregunte cada mes si ya se aprobaron, si ya se
-- hicieron, para tener ahi todas las suscripciones bien especificas de cuanto".
--
-- 1. La categoria vive donde viven todas: `categorias_movimiento` (EGRESO). Una
--    pareja categoria/subcategoria es obligatoria en esa tabla, asi que entran
--    cuatro subcategorias. El nombre especifico de cada suscripcion va en el
--    concepto del egreso y en el catalogo de abajo, no como subcategoria: asi la
--    lista que ve el clasificador del bot crece en 4 y no en una por servicio.
-- 2. `suscripciones`: el catalogo (nombre, monto, moneda, dia de cobro, cuenta,
--    activa). Hace falta tabla: monto/moneda/dia/cuenta no caben en ninguna
--    tabla existente, y una constante en el codigo no se ve ni se edita desde el
--    ERP.
-- 3. `suscripcion_meses`: UNA fila por suscripcion por mes. Su llave primaria
--    (id_suscripcion, mes) es lo que hace que la pregunta salga una vez aunque el
--    bot se reinicie: el bot RECLAMA el mes con un INSERT (gana uno) antes de
--    mandar el mensaje, y el estado del mes se lee de aqui, no de la RAM.
--    `estado` no es el `status` de los ledgers (ACTIVO/ANULADO): es el estado de
--    la pregunta. Los valores son otros a proposito.
-- ============================================================================

-- 1. La categoria ------------------------------------------------------------
INSERT INTO public.categorias_movimiento (tipo, categoria, subcategoria, orden, activa) VALUES
  ('EGRESO', 'Suscripciones', 'IA',                     65, true),
  ('EGRESO', 'Suscripciones', 'Software y nube',        66, true),
  ('EGRESO', 'Suscripciones', 'Marketing y mensajería', 67, true),
  ('EGRESO', 'Suscripciones', 'Otras',                  68, true)
ON CONFLICT (tipo, categoria, subcategoria) DO NOTHING;

-- 2. El catalogo -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suscripciones (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre         text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 60),
  monto          numeric(12,2) NOT NULL CHECK (monto > 0 AND monto <= 500000),
  moneda         text NOT NULL DEFAULT 'MXN' CHECK (moneda IN ('MXN', 'USD')),
  -- NULL = sin dia conocido: se pregunta el dia 1. 29-31 en un mes corto = el ultimo dia.
  dia_cobro      smallint CHECK (dia_cobro BETWEEN 1 AND 31),
  -- NULL = la cuenta del alta de Norman en el bot.
  id_cuenta      uuid REFERENCES public.cuentas_financieras(id),
  subcategoria   text NOT NULL DEFAULT 'Otras'
                 CHECK (subcategoria IN ('IA', 'Software y nube', 'Marketing y mensajería', 'Otras')),
  activa         boolean NOT NULL DEFAULT true,
  -- Etiqueta libre ("tarjeta de Spin"). NUNCA numeros de tarjeta.
  notas          text CHECK (notas IS NULL OR length(notas) <= 200),
  creada_en      timestamptz NOT NULL DEFAULT now(),
  actualizada_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nombre)
);

COMMENT ON TABLE public.suscripciones IS
  'Catalogo de suscripciones (nombre, monto, moneda, dia de cobro, cuenta). El bot pregunta cada mes si ya se pagaron. 2026-11-09.';

-- 3. El estado de cada mes ---------------------------------------------------
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
  -- message_id de Telegram de la pregunta que SI salio. NULL en una PREGUNTADA
  -- = el bot reclamo y no alcanzo a mandar (o no alcanzo a avisar): a las 6 h
  -- se reenvia UNA vez (`reenvios`).
  id_mensaje         bigint,
  reenvios           smallint NOT NULL DEFAULT 0 CHECK (reenvios >= 0),
  -- Por que esta POSPUESTA: Norman dijo "Todavia no", o Telegram no la entrego.
  -- El texto del reintento depende de esto.
  motivo_pospuesta   text CHECK (motivo_pospuesta IN ('TODAVIA_NO', 'ENVIO_FALLIDO')),
  PRIMARY KEY (id_suscripcion, mes)
);

-- Un egreso paga UN mes: "Es este: ligarlo" no puede ligar el mismo egreso a
-- dos meses (ni dos toques cruzados). El bot trata el 23505 como "ya lo tomo
-- otro".
CREATE UNIQUE INDEX IF NOT EXISTS suscripcion_meses_id_movimiento_unico
  ON public.suscripcion_meses (id_movimiento) WHERE id_movimiento IS NOT NULL;

COMMENT ON TABLE public.suscripcion_meses IS
  'Una fila por suscripcion por mes. La PK es el reclamo: la pregunta del bot sale una vez aunque se reinicie. PAGADA apunta al egreso en finanzas_ledger.';

-- 4. RLS: solo ADMIN lee y escribe (mismo mi_rol() que categorias_movimiento) --
ALTER TABLE public.suscripciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suscripcion_meses ENABLE ROW LEVEL SECURITY;

-- Supabase da ALL a anon y authenticated por ALTER DEFAULT PRIVILEGES: sin el
-- REVOKE de authenticated, el GRANT de abajo no restringiria nada. La
-- proteccion de filas es el RLS; esto solo deja los privilegios de tabla como
-- se leen (suscripcion_meses: authenticated solo lee; escribe el service role).
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

-- ============================================================================
-- Comprobar despues de aplicar (solo lectura):
--   select count(*) from categorias_movimiento where categoria = 'Suscripciones';  -- 4
--   select relrowsecurity from pg_class where relname in ('suscripciones','suscripcion_meses');  -- t, t
--   select count(*) from suscripciones;  -- 0. La lista inicial es
--     Socio/planes/DESDE_EJECUTOR_erp_suscripciones_2026-11-09_semilla.sql
--     (todas activa=false). Esa copia en Socio/planes la pone la orquestadora:
--     el ejecutor la dejo en su scratchpad porque el hook de dominio le nego
--     escribir ahi. Se aplica solo con la palabra de Norman.
-- ============================================================================
