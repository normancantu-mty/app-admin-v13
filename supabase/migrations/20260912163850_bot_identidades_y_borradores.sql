-- ============================================================================
-- ERP / AG-01 · Fase 1 — Las dos tablas del bot de Telegram
-- ============================================================================
-- Escrita 2026-09-12. NO toca ninguna tabla existente: dos tablas nuevas,
-- una funcion de trigger y su REVOKE. Cero UPDATE, cero INSERT de datos.
-- Cifras de control intactas: 85 activas / 484 / 64 / $400,625
-- (medidas hoy contra produccion; ver el commit que acompana esta migracion).
--
-- ─── POR QUE DOS TABLAS Y NO CERO ───────────────────────────────────────────
--
-- 1. `bot_identidades` — el mapeo `telegram_id -> entidad`. Sin el, un
--    `telegram_id` no se puede resolver a nada: `mi_entidad_id()` empata SOLO
--    por `entidades.auth_id` desde el 20260903043244, y un usuario de Telegram
--    no tiene `auth_id`. El alta es a mano y solo de Norman: 15 filas en total
--    (Q-14). Que sea manual es una VENTAJA de seguridad — nadie se auto-asigna
--    una entidad.
--
-- 2. `bot_borradores` — el payload sellado entre la propuesta y el "va".
--    Podria vivir en memoria del proceso, y ahi el sello lo vigilaria el mismo
--    codigo que le habla al LLM. Guardandolo del lado del servidor, el endpoint
--    de confirmacion recibe SOLO `{id, sello}` y el objeto lo busca el; el LLM
--    no tiene por donde tocarlo aunque quisiera. La propiedad de seguridad del
--    paso 5 (D-E30) deja de depender de la buena conducta del proceso de Python.
--
--    El modo de fallo que esto ataca esta documentado con ticket y fecha en otro
--    proyecto: `langchain-ai/langchain` issue #33787 — su middleware de
--    human-in-the-loop reintentaba la tool call ORIGINAL en vez de la editada.
--    No es un miedo teorico.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_bot_identidad_cuenta_valida ON public.bot_identidades;
--   DROP FUNCTION public.tg_bot_vetar_cuenta_fiscal();
--   DROP TABLE public.bot_borradores;
--   DROP TABLE public.bot_identidades;
-- ============================================================================


-- ─── 1. bot_identidades ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_identidades (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El chat privado de Telegram: chat_id == user_id. Unico: una persona, una fila.
  telegram_id        bigint NOT NULL UNIQUE,
  -- Lo que acaba en `usuario_creador = 'telegram:<etiqueta>'`. Acotada a un slug
  -- para que ese valor siga siendo parseable y no pueda inyectar espacios ni
  -- dos puntos que rompan la convencion.
  etiqueta           text NOT NULL UNIQUE
                     CHECK (etiqueta ~ '^[a-z0-9_-]{2,24}$'),
  -- A quien se resuelve. Planta (Kevin y dos mas) apunta a la Matriz: la
  -- captura es un puesto, no una persona (Q-14 segunda parte). NO se crea rol
  -- nuevo en el ERP — AG-02 lo prohibe.
  id_entidad         uuid NOT NULL REFERENCES public.entidades(id),
  -- La cuenta contra la que se asienta el gasto. **Derivada, no inferida**: el
  -- LLM nunca elige cuenta. Es la unica forma de que ese campo pueda dejar de
  -- mostrarse en la confirmacion sin quitarle revision al humano (D-E30).
  id_cuenta_destino  uuid NOT NULL REFERENCES public.cuentas_financieras(id),
  activo             boolean NOT NULL DEFAULT true,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  creado_por         text
);

COMMENT ON TABLE public.bot_identidades IS
  'Mapeo telegram_id -> entidad del ERP. Alta manual, solo service_role. AG-01.';


-- ─── 2. El veto de la cuenta fiscal, en la base y no en TypeScript ──────────
-- `cuentaVetadaComoDefault` (lib/avisos.ts) ya veta FULL_TAX y todo nombre con
-- "fresnillo" para el default de W13. Aqui hace falta otra vez y en Postgres,
-- porque el alta del bot no pasa por ese codigo: la escribe el propio bot con
-- service_role. Un CHECK no puede consultar otra tabla; un trigger si.
--
-- Lo que previene, concreto: si una identidad quedara ligada a `Cuenta
-- Fresnillo` (la unica FULL_TAX, 0 movimientos, comprobado 2026-09-12), CADA
-- gasto capturado por chat se asentaria en la cuenta fiscal. Es la version
-- automatizada del error que ya tiene nombre en este repo: inventar pasivo
-- fiscal donde no lo hay.
CREATE OR REPLACE FUNCTION public.tg_bot_vetar_cuenta_fiscal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_nombre text;
  v_fiscalidad text;
  v_entidad_cuenta uuid;
BEGIN
  SELECT c.nombre, c.tipo_fiscalidad, c.id_entidad
    INTO v_nombre, v_fiscalidad, v_entidad_cuenta
    FROM public.cuentas_financieras c
   WHERE c.id = NEW.id_cuenta_destino;

  IF v_fiscalidad = 'FULL_TAX' THEN
    RAISE EXCEPTION 'La cuenta % es FULL_TAX: un gasto ahi inventa pasivo fiscal.', v_nombre;
  END IF;

  -- Redundante con lo anterior hoy, y a proposito: la fiscalidad se decide en
  -- `pos.ts` por coincidencia textual del nombre, no por la columna. Mientras
  -- esa regla siga siendo textual, el veto tambien tiene que serlo.
  IF position('fresnillo' in lower(v_nombre)) > 0 THEN
    RAISE EXCEPTION 'La cuenta % lleva "fresnillo" en el nombre: vetada por la regla textual de fiscalidad.', v_nombre;
  END IF;

  -- La cuenta tiene que ser de la MISMA entidad a la que se resuelve la
  -- identidad. Sin esto, Kevin podria quedar mapeado a la Matriz pero
  -- asentando contra la cuenta de un distribuidor: efectivo de un DST
  -- entrando a los totales de la Matriz sin que nadie lo teclee
  -- (Account_Firewall, regla 1).
  IF v_entidad_cuenta IS DISTINCT FROM NEW.id_entidad THEN
    RAISE EXCEPTION 'La cuenta % no pertenece a la entidad de esta identidad.', v_nombre;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_bot_vetar_cuenta_fiscal() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.tg_bot_vetar_cuenta_fiscal() TO service_role;

DROP TRIGGER IF EXISTS trg_bot_identidad_cuenta_valida ON public.bot_identidades;
CREATE TRIGGER trg_bot_identidad_cuenta_valida
  BEFORE INSERT OR UPDATE ON public.bot_identidades
  FOR EACH ROW EXECUTE FUNCTION public.tg_bot_vetar_cuenta_fiscal();


-- ─── 3. bot_borradores — el payload sellado ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_borradores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  bigint NOT NULL,
  -- sha256 hex del payload canonico (JSON con llaves ordenadas). Se calcula UNA
  -- vez, sobre el objeto que se le ENSENA a la persona, y se vuelve a calcular
  -- al confirmar contra el objeto guardado aqui. Si no empatan, no se escribe.
  --
  -- El nombre honesto de esto: es una **idempotency key** aplicada a un
  -- borrador, como las de Stripe. En la literatura de agentes el sellado del
  -- payload NO tiene nombre propio; se dice asi para no inventar uno.
  sello        text NOT NULL CHECK (sello ~ '^[0-9a-f]{64}$'),
  payload      jsonb NOT NULL,
  estado       text NOT NULL DEFAULT 'PENDIENTE'
               CHECK (estado IN ('PENDIENTE', 'CONFIRMADO', 'CANCELADO')),
  -- La fila que quedo, cuando quedo. Es la mitad del rastro: que se propuso
  -- (payload) y que se escribio (id_registro).
  id_registro  uuid,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  resuelto_en  timestamptz
);

-- Un solo borrador PENDIENTE por persona. No es comodidad: con dos abiertos, un
-- "va" es ambiguo, y resolver la ambiguedad preguntando "cual de los dos"
-- convierte la interfaz en justo lo que Q-14 prohibe (identificadores que
-- recordar). Proponer otra cosa cancela el anterior.
CREATE UNIQUE INDEX IF NOT EXISTS bot_borradores_uno_pendiente
  ON public.bot_borradores (telegram_id)
  WHERE estado = 'PENDIENTE';

CREATE INDEX IF NOT EXISTS bot_borradores_creado_en
  ON public.bot_borradores (creado_en DESC);

CREATE INDEX IF NOT EXISTS bot_identidades_id_entidad
  ON public.bot_identidades (id_entidad);

CREATE INDEX IF NOT EXISTS bot_identidades_id_cuenta_destino
  ON public.bot_identidades (id_cuenta_destino);

COMMENT ON TABLE public.bot_borradores IS
  'Payload propuesto y sellado entre la propuesta y el "va". D-E30 paso 5.';


-- ─── 4. RLS DESDE EL MINUTO UNO (ERP-57) ────────────────────────────────────
-- Los default privileges de este proyecto siguen abriendo tablas nuevas a
-- `anon`. Sin estas lineas, `bot_identidades` seria un directorio publico de
-- quien puede escribirle al ERP por chat, y `bot_borradores` un feed publico de
-- todo lo que se esta capturando.
--
-- NINGUNA politica de escritura para `authenticated`, y es deliberado: las dos
-- tablas las escribe SOLO el bot, con `service_role`. El alta de identidades es
-- de Norman por el comando del bot (Q-14), no de la aplicacion web. Menos
-- caminos de escritura, menos que vigilar.

ALTER TABLE public.bot_identidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_borradores  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bot_identidades FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.bot_borradores  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.bot_identidades TO authenticated;
GRANT SELECT ON public.bot_borradores  TO authenticated;

GRANT ALL ON public.bot_identidades TO service_role;
GRANT ALL ON public.bot_borradores  TO service_role;

DROP POLICY IF EXISTS bot_identidades_sel_admin ON public.bot_identidades;
CREATE POLICY bot_identidades_sel_admin ON public.bot_identidades
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));

DROP POLICY IF EXISTS bot_borradores_sel_admin ON public.bot_borradores;
CREATE POLICY bot_borradores_sel_admin ON public.bot_borradores
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));
