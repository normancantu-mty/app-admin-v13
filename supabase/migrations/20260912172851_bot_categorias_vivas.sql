-- ============================================================================
-- bot_categorias — la lista cerrada deja de ser una constante y pasa a ser
-- una TABLA, para que crezca con el uso.
--
-- Norman, 2026-09-12: *"los gastos de ahora no son representativos, va a tener
-- que salir con la marcha"*. Con 21 filas historicas y tres meses sin capturar,
-- cualquier catalogo escrito de antemano es sobreajuste a una muestra podrida.
-- La lista se descubre capturando.
--
-- LO QUE NO CAMBIA, Y ES LA RAZON DE QUE ESTO SEA UNA TABLA Y NO TEXTO LIBRE:
-- `v_pasivo_fiscal` arma su texto como
--   categoria || ' ' || categoria_gasto || ' ' || descripcion
-- o sea que **la columna `categoria` alimenta al clasificador fiscal**. Una
-- categoria con la subcadena equivocada inventa un pago de impuesto. Por eso
-- el nombre se valida aqui con un CHECK, ademas de en TypeScript, y por eso
-- una categoria nueva solo nace con el "va" de una persona.
--
-- Aplicada el 2026-09-12 con `apply_migration`; el archivo se nombra DESPUES,
-- con la version que estampo el servidor (regla 4 del encargo).
--
-- PARA DESHACER:
--   DROP TABLE public.bot_categorias;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bot_categorias (
  nombre          text PRIMARY KEY
                  CHECK (nombre ~ '^[A-Za-z][A-Za-z0-9_]{2,39}$'),
  ayuda           text NOT NULL DEFAULT '',
  -- La FORMA DE FILA. No se deduce del nombre (E-237): se declara.
  tipo_movimiento text NOT NULL DEFAULT 'GASTO_OPERATIVO'
                  CHECK (tipo_movimiento IN ('GASTO_OPERATIVO', 'COMPRA_INSUMOS')),
  columna         text NOT NULL DEFAULT 'destino'
                  CHECK (columna IN ('origen', 'destino')),
  activa          boolean NOT NULL DEFAULT true,
  creada_por      text NOT NULL DEFAULT 'semilla',
  creada_en       timestamptz NOT NULL DEFAULT now(),
  -- Las seis subcadenas literales que `v_pasivo_fiscal` lee. Un nombre que las
  -- contenga se rechaza en la base, no solo en la aplicacion: es la unica capa
  -- que no se puede saltar escribiendo por otro camino.
  CONSTRAINT bot_categorias_sin_disparador_fiscal CHECK (
    upper(nombre) NOT LIKE '%FUGA_FISCAL_IVA%'  AND
    upper(nombre) NOT LIKE '%FUGA_FISCAL_IEPS%' AND
    upper(nombre) NOT LIKE '%PAGO_IVA%'         AND
    upper(nombre) NOT LIKE '%PAGO_IEPS%'        AND
    upper(nombre) NOT LIKE '%PAGOIVA%'          AND
    upper(nombre) NOT LIKE '%PAGOIEPS%'
  )
);

COMMENT ON TABLE public.bot_categorias IS
  'Lista cerrada VIVA del bot. Crece solo con el "va" de una persona. AG-01.';

-- ─── La semilla: exactamente lo que hoy es constante en lib/bot-gastos.ts ────
INSERT INTO public.bot_categorias (nombre, ayuda, tipo_movimiento, columna) VALUES
  ('Marketing_y_Relaciones',  'publicidad, redes, disenio, muestras, atenciones',                      'GASTO_OPERATIVO', 'destino'),
  ('Servicios_Basicos',       'luz, agua, internet, telefono, renta, software',                        'GASTO_OPERATIVO', 'destino'),
  ('Logistica_Envios',        'gasolina, casetas, paqueteria, fletes, viaticos de ruta',               'GASTO_OPERATIVO', 'destino'),
  ('Nomina_y_Honorarios',     'sueldos, honorarios, pagos a terceros por trabajo',                     'GASTO_OPERATIVO', 'destino'),
  ('Gastos_Personales_Socio', 'retiros y gastos personales de un socio',                               'GASTO_OPERATIVO', 'destino'),
  ('Insumos',                 'materia prima: agave, botella, corcho, etiqueta, lo que entra al producto', 'COMPRA_INSUMOS',  'origen')
ON CONFLICT (nombre) DO NOTHING;

-- ─── RLS DESDE EL MINUTO UNO (ERP-57) ───────────────────────────────────────
ALTER TABLE public.bot_categorias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_categorias FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bot_categorias TO authenticated;
GRANT ALL    ON public.bot_categorias TO service_role;

DROP POLICY IF EXISTS bot_categorias_sel_admin ON public.bot_categorias;
CREATE POLICY bot_categorias_sel_admin ON public.bot_categorias
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));
