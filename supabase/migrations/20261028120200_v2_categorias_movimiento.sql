-- ============================================================================
-- v2: categorias y subcategorias CERRADAS de movimientos
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- Norman las capturo (14 categorias, 2026-10-28) en el artefacto de arranque. La
-- tabla nace vacia: la llena scripts/cargar_arranque.py desde la captura, porque
-- la lista es dato de Norman y no esquema.
--
-- El alta de gasto (POST /api/finanzas/nuevo) exige categoria + subcategoria que
-- existan aqui, activas y del tipo EGRESO. finanzas_ledger guarda las dos en sus
-- columnas `categoria` y `subcategoria`, que ya existian.
--
-- No sustituye a `bot_categorias`: esa tabla es el vocabulario del bot de
-- Telegram (nombres sin acentos, ^[A-Za-z][A-Za-z0-9_]+$) y sigue como esta.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.categorias_movimiento (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo         text NOT NULL CHECK (tipo IN ('EGRESO', 'INGRESO')),
  categoria    text NOT NULL CHECK (length(btrim(categoria)) > 0),
  subcategoria text NOT NULL CHECK (length(btrim(subcategoria)) > 0),
  orden        integer NOT NULL DEFAULT 0,
  activa       boolean NOT NULL DEFAULT true,
  creada_en    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tipo, categoria, subcategoria)
);

COMMENT ON TABLE public.categorias_movimiento IS
  'v2: lista cerrada de categoria/subcategoria. La llena scripts/cargar_arranque.py.';

ALTER TABLE public.categorias_movimiento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.categorias_movimiento FROM anon;
GRANT SELECT ON TABLE public.categorias_movimiento TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.categorias_movimiento TO service_role;

DROP POLICY IF EXISTS categorias_mov_sel ON public.categorias_movimiento;
CREATE POLICY categorias_mov_sel ON public.categorias_movimiento
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS categorias_mov_admin ON public.categorias_movimiento;
CREATE POLICY categorias_mov_admin ON public.categorias_movimiento
  FOR ALL TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
GRANT INSERT, UPDATE ON TABLE public.categorias_movimiento TO authenticated;
