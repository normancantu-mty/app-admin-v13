-- ============================================================================
-- Cazador de datos · Fase 0 · WP-2a — LA BITACORA (solo-agregar)
-- ============================================================================
-- Escrita 2026-10-17 por el ejecutor B del Socio
-- (plan: Fresnillo/ERP_Fresnillo/DESDE_SOCIO_plan_cazador_v3_2026-10-17.md §2).
--
-- ADITIVA PURA: una tabla nueva, una funcion de trigger, dos triggers, una
-- politica. No toca ninguna tabla existente. Cero UPDATE, cero INSERT de datos.
--
-- ─── QUE ES ─────────────────────────────────────────────────────────────────
-- Todo lo que entra y sale del bot de Telegram, ANTES de procesarse: cada
-- mensaje de grupo y de privado, cada transcripcion de voz y cada respuesta
-- del bot. "La bitacora es el documento; el ERP es una proyeccion": lo que el
-- bot no entiende hoy se re-procesa cuando lleguen los extractores nuevos.
--
-- ─── SOLO-AGREGAR, CON UNA EXCEPCION DOCUMENTADA ────────────────────────────
-- El trigger `tg_bitacora_solo_agregar` rechaza DELETE y TRUNCATE siempre, y
-- rechaza todo UPDATE que cambie cualquier columna salvo dos:
--   · `procesado` — el encargo lo pide: la cola de lo que espera (el tope de la
--     suscripcion encola con `procesado=false`) y el re-proceso de la Fase 1
--     tienen que poder marcar la fila. Cambia en las dos direcciones.
--   · `etiquetas` — SOLO si estaba vacia (`'{}'`). La fila se escribe ANTES de
--     que el modelo lea el mensaje, asi que las etiquetas de una NOTA (lote,
--     persona, cliente) llegan despues. Se ponen UNA vez; reetiquetar es
--     reescribir el documento y se rechaza. Decision del ejecutor B: la otra
--     opcion era una segunda fila con el mismo texto, y un dato en dos lugares
--     es justo lo que este repo prohibe.
-- Sin sesion (`postgres`, `service_role`) el trigger aplica IGUAL: el bot
-- escribe con service_role y es justo a quien hay que atar.
--
-- ─── `clave` ────────────────────────────────────────────────────────────────
-- Unica e idempotente: `tg:<chat>:<mensaje>:<origen>` para lo que viene de
-- Telegram. El bot reintenta lo que no pudo escribir (cola local `.jsonl`) con
-- `ON CONFLICT (clave) DO NOTHING`: un reintento nunca duplica una fila.
--
-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Lee solo ADMIN (no SOCIO: son conversaciones del equipo). Nadie escribe por
-- RLS; escribe service_role (la API del bot).
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP TABLE public.bitacora;                     -- se lleva sus triggers
--   DROP FUNCTION public.tg_bitacora_solo_agregar();
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bitacora (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave         text        NOT NULL UNIQUE CHECK (length(clave) BETWEEN 3 AND 200),
  chat_id       bigint,
  -- private | group | supergroup | channel (lo que dice Telegram)
  chat_tipo     text,
  telegram_id   bigint,
  -- Como se le dice a esa persona (etiqueta del alta o nombre de Telegram).
  persona       text,
  -- El message_id de Telegram (o del mensaje que mando el bot).
  mensaje_id    bigint,
  -- Cuando lo dijo (la fecha del mensaje de Telegram), no cuando se escribio.
  fecha         timestamptz NOT NULL DEFAULT now(),
  texto         text,
  transcripcion text,
  -- file_id de Telegram o ruta local del audio/adjunto.
  adjunto_ref   text,
  -- El message_id al que contesta (reply_to), si contesta a algo.
  respuesta_a   bigint,
  origen        text        NOT NULL
                CHECK (origen IN ('grupo', 'privado', 'voz', 'bot', 'reunion')),
  etiquetas     jsonb       NOT NULL DEFAULT '{}'::jsonb
                CHECK (jsonb_typeof(etiquetas) = 'object'),
  procesado     boolean     NOT NULL DEFAULT false,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bitacora IS
  'Cazador F0 (WP-2a): todo mensaje, transcripcion y respuesta del bot, escrito antes de procesarse. Solo-agregar: UPDATE solo de procesado y de etiquetas vacias; DELETE/TRUNCATE rechazados por trigger.';
COMMENT ON COLUMN public.bitacora.procesado IS
  'Unica columna que cambia libremente: false = espera proceso (p. ej. tope de la suscripcion), true = ya se atendio.';
COMMENT ON COLUMN public.bitacora.etiquetas IS
  'Etiquetas de una NOTA ({lote, persona, cliente}). Se ponen UNA vez, solo si estaba vacia.';

CREATE INDEX IF NOT EXISTS bitacora_chat_fecha_idx ON public.bitacora (chat_id, fecha DESC);
CREATE INDEX IF NOT EXISTS bitacora_pendientes_idx ON public.bitacora (fecha) WHERE procesado = false;

-- ─── EL CANDADO ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_bitacora_solo_agregar() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'bitacora es solo-agregar: % rechazado', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- UPDATE: nada cambia salvo procesado, y etiquetas solo si estaba vacia.
  IF (to_jsonb(NEW) - 'procesado' - 'etiquetas') IS DISTINCT FROM
     (to_jsonb(OLD) - 'procesado' - 'etiquetas') THEN
    RAISE EXCEPTION 'bitacora es solo-agregar: solo cambian procesado y etiquetas vacias'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.etiquetas IS DISTINCT FROM OLD.etiquetas AND OLD.etiquetas <> '{}'::jsonb THEN
    RAISE EXCEPTION 'bitacora: las etiquetas ya estaban puestas; no se reescriben'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_bitacora_solo_agregar() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bitacora_solo_agregar ON public.bitacora;
CREATE TRIGGER trg_bitacora_solo_agregar
  BEFORE UPDATE OR DELETE ON public.bitacora
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora_solo_agregar();

DROP TRIGGER IF EXISTS trg_bitacora_sin_truncate ON public.bitacora;
CREATE TRIGGER trg_bitacora_sin_truncate
  BEFORE TRUNCATE ON public.bitacora
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_bitacora_solo_agregar();

-- ─── RLS Y PRIVILEGIOS ──────────────────────────────────────────────────────
ALTER TABLE public.bitacora ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bitacora FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bitacora TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bitacora TO service_role;

DROP POLICY IF EXISTS bitacora_sel_admin ON public.bitacora;
CREATE POLICY bitacora_sel_admin ON public.bitacora
  FOR SELECT TO authenticated
  USING (public.mi_rol() = 'ADMIN');

-- ─── COMO SE COMPRUEBA DESPUES DE APLICARLA ─────────────────────────────────
--   insert into public.bitacora (clave, origen, texto) values ('prueba:1','bot','hola');
--   update public.bitacora set texto='x' where clave='prueba:1';      -- ERROR
--   update public.bitacora set procesado=true where clave='prueba:1'; -- ok
--   delete from public.bitacora where clave='prueba:1';               -- ERROR
-- (la fila de prueba se queda: es solo-agregar. Usar una clave 'prueba:*'.)
