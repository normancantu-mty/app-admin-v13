-- ============================================================================
-- ERP-59 · La cola de avisos de captura
-- ============================================================================
-- POR QUE EXISTE. Hoy el sistema tiene una sola respuesta cuando un dato llega
-- incompleto: rechazar. Y el resultado medido no es "datos limpios", es datos
-- que no existen — $0.00 de gasto capturado desde el 1 de julio de 2026
-- (comprobado 2026-09-05: `SELECT count(*) FROM finanzas_ledger WHERE
-- tipo_movimiento='GASTO_OPERATIVO' AND fecha_movimiento >= '2026-07-01'` = 0),
-- 72 botellas facturadas fuera del ERP y 602 en consignacion sin descargar.
-- Cuando capturar bien es imposible, la gente no captura mal: NO CAPTURA.
--
-- EL PRINCIPIO, Y NO SE NEGOCIA. Un aviso NUNCA detiene una escritura. La fila
-- entra y queda marcada. Lo que no se vale es perder el dato porque faltaba un
-- campo.
--
-- LA FRONTERA, QUE SI SE NEGOCIA Y QUEDO DECIDIDA (prompt 18-bis §3).
--   * Movimiento que por diseno NO genera dinero (consignacion, traspaso,
--     merma, produccion): el ledger fisico PUEDE ir solo. Aviso y adelante.
--   * Movimiento que SI genera dinero (venta de contado, liquidacion, compra,
--     devolucion con abono): LOS DOS LEDGERS O NINGUNO. Ahi un aviso no basta,
--     porque escribir solo el fisico no es una captura incompleta: es un
--     asiento falso. Esos casos siguen rechazando y NO tienen aviso.
--
-- NO CAMBIA NINGUNA CIFRA. Una tabla nueva vacia, dos funciones, dos triggers
-- y UNA fila de datos (la entidad centinela de abajo, que no participa en
-- ningun ledger). Linea base del dia, comprobada antes de escribir esto:
-- 85 finanzas ACTIVO / 474 inventario / 62 tickets ACTIVO / $395,033.00.
--
-- ─── LA ENTIDAD CENTINELA, Y POR QUE NO ES UN NULL ──────────────────────────
-- W4 (venta en concesion sin comprador identificado) deja de rechazar. La
-- botella salio del almacen: ese es el hecho. Quien la debe es el campo que
-- falta. Pero la fila NO entra con `id_comprador = NULL`: entra apuntando a una
-- entidad de verdad, "PENDIENTE DE ASIGNAR", con UUID fijo.
--
-- El motivo es el mismo que el de `SIN_CATEGORIZAR` en el gasto: **un valor que
-- grita se revisa; un NULL se pierde entre los legitimos.** Ademas, con entidad
-- real el par de inventario se escribe completo y el aviso se puede colgar de
-- una fila que existe.
--
-- El UUID esta duplicado a proposito aqui y en `lib/avisos.ts`
-- (`ENTIDAD_PENDIENTE_DE_ASIGNAR`), por la misma razon que la ventana de 12 h:
-- Postgres no lee una constante de TypeScript ni al reves.
-- `tests/avisos.spec.ts` falla si divergen.
--
-- Rol `LOC` y no `DST`: el comprador de una venta es un local, y el candado de
-- la cuenta fiscal (`validarCompradorContraCuentaFiscal`, regla 2) rechaza
-- facturar a un DST desde `Cuenta Fresnillo`. Con rol LOC el centinela se
-- comporta como cualquier otro comprador y no abre ninguna puerta nueva.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_autor_avisos  ON public.avisos_captura;
--   DROP TRIGGER trg_cerrar_avisos ON public.avisos_captura;
--   DROP FUNCTION public.tg_avisos_vigilar_cierre();
--   DROP FUNCTION public.entidad_pendiente_de_asignar();
--   DROP TABLE public.avisos_captura;          -- se pierde la cola registrada
--   DELETE FROM public.entidades WHERE id = '11111111-1111-1111-1111-111111111111'
--     AND NOT EXISTS (SELECT 1 FROM transacciones_tickets
--                      WHERE id_comprador = '11111111-1111-1111-1111-111111111111');
-- ============================================================================


-- ─── 1. LA ENTIDAD CENTINELA ────────────────────────────────────────────────
-- `zona` es NOT NULL con CHECK ('Zacatecas','Foraneo'). 'Zacatecas' es la zona
-- de calle y la que ya usa la cobranza (ZONA_PRECIO_CALLE en auditoria.ts).
-- Sin correo y sin `auth_id`: no inicia sesion, no es un usuario.

INSERT INTO public.entidades (id, nombre, rol, zona, comision_base, comision_base_local)
VALUES ('11111111-1111-1111-1111-111111111111', 'PENDIENTE DE ASIGNAR', 'LOC', 'Zacatecas', 0, 0)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.entidades IS
  'Nodos de la red. OJO: la fila 11111111-1111-1111-1111-111111111111 '
  '("PENDIENTE DE ASIGNAR") NO es un cliente: es el centinela de ERP-59 para '
  'ventas en concesion capturadas sin comprador. Toda venta que la apunte tiene '
  'un aviso W4 abierto en avisos_captura y no se puede cerrar sin reasignarla.';

-- El UUID en una sola funcion, para que ningun trigger ni consulta lo teclee.
CREATE OR REPLACE FUNCTION public.entidad_pendiente_de_asignar() RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT '11111111-1111-1111-1111-111111111111'::uuid
$fn$;

REVOKE EXECUTE ON FUNCTION public.entidad_pendiente_de_asignar() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.entidad_pendiente_de_asignar() TO authenticated, service_role;


-- ─── 2. LA COLA ─────────────────────────────────────────────────────────────
-- `id_entidad` es NOT NULL y es DE QUIEN ES el aviso, no a que fila apunta. Es
-- lo que hace simple y hermetico el RLS: un DST ve los suyos y los de sus
-- locales, punto. `tabla`/`id_registro` apuntan a la fila cuando la hay — el
-- aviso de "corte en cero" (W1b) no tiene fila que apuntar, y por eso el
-- puntero es opcional y el dueno no.

CREATE TABLE IF NOT EXISTS public.avisos_captura (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cual de los avisos catalogados es. El catalogo vive en `lib/avisos.ts`;
  -- aqui no se enumera a proposito, para no tener que migrar la base cada vez
  -- que se clasifique una validacion mas.
  tipo           text NOT NULL CHECK (BTRIM(tipo) <> ''),
  severidad      text NOT NULL CHECK (severidad IN ('INFO', 'REVISAR')),
  mensaje        text NOT NULL CHECK (BTRIM(mensaje) <> ''),

  -- De quien es el aviso. Manda el RLS.
  id_entidad     uuid NOT NULL REFERENCES public.entidades(id),

  -- A que fila apunta, cuando apunta a una.
  tabla          text,
  id_registro    uuid,

  -- Lo que el capturista SI escribio y no cupo en la fila: la fecha ilegible,
  -- el metodo de pago tecleado, el conteo del sobregiro. Sin esto el aviso dice
  -- "falta algo" y pierde justamente el dato que hace falta para arreglarlo.
  datos_capturados jsonb,

  estado         text NOT NULL DEFAULT 'ABIERTO'
                 CHECK (estado IN ('ABIERTO', 'RESUELTO', 'IGNORADO')),
  motivo_cierre  text,

  usuario_creador text NOT NULL DEFAULT 'sistema',
  creado_en      timestamptz NOT NULL DEFAULT now(),
  cerrado_por    text,
  cerrado_en     timestamptz,

  -- El puntero va completo o no va: `tabla` sin `id_registro` no sirve de nada.
  CONSTRAINT avisos_puntero_completo
    CHECK ((tabla IS NULL) = (id_registro IS NULL)),

  -- Abierto = sin firma de cierre. Cerrado = con firma. No hay estado a medias.
  CONSTRAINT avisos_cierre_coherente CHECK (
    (estado =  'ABIERTO' AND cerrado_por IS NULL     AND cerrado_en IS NULL)
    OR
    (estado <> 'ABIERTO' AND cerrado_por IS NOT NULL AND cerrado_en IS NOT NULL)
  ),

  -- Ignorar pide motivo, en una linea. Es la unica salida sin arreglar el dato:
  -- si no cuesta nada escribir por que, la cola entera se ignora en dos clics.
  CONSTRAINT avisos_ignorado_con_motivo
    CHECK (estado <> 'IGNORADO' OR COALESCE(BTRIM(motivo_cierre), '') <> '')
);

COMMENT ON TABLE public.avisos_captura IS
  'ERP-59. Cola de capturas incompletas. La escriben las validaciones que antes '
  'rechazaban (app/actions/*, app/api/finanzas/nuevo). Un aviso NUNCA detiene '
  'una escritura: la fila entra y queda marcada. Los avisos no se borran; se '
  'resuelven o se ignoran con motivo.';

COMMENT ON COLUMN public.avisos_captura.id_entidad IS
  'DE QUIEN es el aviso (no a que fila apunta). Es la columna sobre la que '
  'decide el RLS: un DST ve los suyos y los de sus locales.';

-- La cola se lee siempre igual: abiertos, lo urgente primero, lo viejo primero.
CREATE INDEX IF NOT EXISTS idx_avisos_captura_cola
  ON public.avisos_captura (estado, severidad, creado_en);

CREATE INDEX IF NOT EXISTS idx_avisos_captura_entidad
  ON public.avisos_captura (id_entidad);

CREATE INDEX IF NOT EXISTS idx_avisos_captura_registro
  ON public.avisos_captura (tabla, id_registro);


-- ─── 3. RLS ─────────────────────────────────────────────────────────────────
-- Mismo modelo que las 9 tablas del 2026-09-02: ADMIN y SOCIO ven todo, DST ve
-- lo suyo mas sus locales, LOC solo lo suyo. Y como en `auditoria_logs`, hay
-- que REVOCAR a mano: Supabase concede todo a `anon` y `authenticated` sobre
-- cada tabla nueva de `public`, y el RLS no impide un DELETE si el privilegio
-- esta concedido y hay politica.

ALTER TABLE public.avisos_captura ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.avisos_captura FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT, UPDATE ON public.avisos_captura TO authenticated;
GRANT  ALL ON public.avisos_captura TO service_role;

-- Sin politica de DELETE: con RLS activo queda negado para todo `authenticated`,
-- ADMIN incluido. Un aviso no se borra — se resuelve o se ignora con motivo.
-- Borrarlos seria poder tapar exactamente lo que la cola viene a destapar.

DROP POLICY IF EXISTS avisos_sel_admin_socio ON public.avisos_captura;
CREATE POLICY avisos_sel_admin_socio ON public.avisos_captura
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));

DROP POLICY IF EXISTS avisos_sel_mios ON public.avisos_captura;
CREATE POLICY avisos_sel_mios ON public.avisos_captura
  FOR SELECT TO authenticated
  USING (id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id)));

DROP POLICY IF EXISTS avisos_ins_admin ON public.avisos_captura;
CREATE POLICY avisos_ins_admin ON public.avisos_captura
  FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = 'ADMIN');

-- Igual que `finanzas_ins_dst`: acotado a mis_entidades() y no a mi_entidad_id(),
-- porque un DST captura tambien por sus locales hijos (Gilberto Franco tiene
-- filas a nombre de "Nuevo Ideal"). Si el aviso no pudiera nacer, la escritura
-- que lo genera si entraria y el sistema quedaria peor que hoy: incompleto Y
-- callado.
DROP POLICY IF EXISTS avisos_ins_dst ON public.avisos_captura;
CREATE POLICY avisos_ins_dst ON public.avisos_captura
  FOR INSERT TO authenticated
  WITH CHECK (
    public.mi_rol() = 'DST'
    AND id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

DROP POLICY IF EXISTS avisos_upd_admin ON public.avisos_captura;
CREATE POLICY avisos_upd_admin ON public.avisos_captura
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN')
  WITH CHECK (public.mi_rol() = 'ADMIN');

DROP POLICY IF EXISTS avisos_upd_dst ON public.avisos_captura;
CREATE POLICY avisos_upd_dst ON public.avisos_captura
  FOR UPDATE TO authenticated
  USING (
    public.mi_rol() = 'DST'
    AND id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  )
  WITH CHECK (
    public.mi_rol() = 'DST'
    AND id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );


-- ─── 4. EL AUTOR LO PONE EL SERVIDOR ────────────────────────────────────────
-- Se reutiliza `tg_forzar_autor()` del 2026-09-02 tal cual: la columna se llama
-- igual y la regla es la misma. Lo que mande el cliente se ignora.

DROP TRIGGER IF EXISTS trg_autor_avisos ON public.avisos_captura;
CREATE TRIGGER trg_autor_avisos
  BEFORE INSERT ON public.avisos_captura
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();


-- ─── 5. EL CIERRE: QUE SE PUEDE MOVER, Y EL CANDADO DE W4 ───────────────────
-- Tres trabajos en un solo trigger, porque los tres se preguntan en el mismo
-- UPDATE:
--
--   1. Un aviso no se edita: de un UPDATE solo pueden salir `estado` y
--      `motivo_cierre`. El texto, la severidad y el puntero son el registro de
--      lo que paso; reescribirlos seria reescribir la historia.
--   2. La firma del cierre la pone el servidor (`usuario_de_sesion()`), no el
--      cliente. Mismo criterio que `usuario_creador`.
--   3. **EL CANDADO DE W4 (prompt 18-bis §1): un aviso de venta en concesion
--      sin comprador NO SE PUEDE CERRAR mientras el ticket siga apuntando al
--      centinela.** Ni resolver ni ignorar. Resolver = asignar. No hay boton
--      que lo de por bueno dejando la venta sin dueno.
--
-- Vive en un trigger y no en la aplicacion por la misma razon que los candados
-- del 2026-09-02: la app no es el unico camino a la base. Con un token valido,
-- PostgREST atiende un `curl`, y un UPDATE directo cerraria el aviso sin
-- asignar a nadie.

CREATE OR REPLACE FUNCTION public.tg_avisos_vigilar_cierre() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_antes   jsonb;
  v_despues jsonb;
  v_col     text;
BEGIN
  -- REGLA 1 — solo `estado`, `motivo_cierre` y la firma que pone este trigger.
  v_antes   := to_jsonb(OLD);
  v_despues := to_jsonb(NEW);

  FOREACH v_col IN ARRAY ARRAY['estado', 'motivo_cierre', 'cerrado_por', 'cerrado_en'] LOOP
    v_antes   := v_antes   - v_col;
    v_despues := v_despues - v_col;
  END LOOP;

  IF v_antes IS DISTINCT FROM v_despues THEN
    RAISE EXCEPTION
      'Regla violada: UN AVISO NO SE EDITA. De avisos_captura solo pueden cambiar '
      'estado y motivo_cierre; el aviso % es el registro de lo que paso.', OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- REGLA 2 — solo se cierra lo que estaba abierto, y no se reabre.
  IF OLD.estado <> 'ABIERTO' THEN
    RAISE EXCEPTION
      'Regla violada: AVISO YA CERRADO. El aviso % quedo en % el %; un aviso '
      'cerrado no se reabre ni se recierra.', OLD.id, OLD.estado, OLD.cerrado_en
      USING ERRCODE = '42501';
  END IF;

  IF NEW.estado = 'ABIERTO' THEN
    RETURN NEW;   -- solo cambio el motivo estando abierto: nada que firmar.
  END IF;

  -- REGLA 3 — EL CANDADO DE W4. Se pregunta por el estado real del ticket, no
  -- por lo que diga quien cierra.
  IF NEW.tipo = 'W4' AND NEW.tabla = 'transacciones_tickets' THEN
    IF EXISTS (
      SELECT 1 FROM public.transacciones_tickets t
       WHERE t.id = NEW.id_registro
         AND t.id_comprador IS NOT DISTINCT FROM public.entidad_pendiente_de_asignar()
    ) THEN
      RAISE EXCEPTION
        'Regla violada: CONCESION SIN DUENO. El ticket % sigue apuntando a '
        '"PENDIENTE DE ASIGNAR": este aviso no se puede cerrar (ni resolver ni '
        'ignorar) hasta asignarle un comprador real. Resolver = asignar.',
        NEW.id_registro
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- La firma la pone el servidor, pase lo que pase mande el cliente.
  NEW.cerrado_por := public.usuario_de_sesion();
  NEW.cerrado_en  := now();

  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.tg_avisos_vigilar_cierre() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_cerrar_avisos ON public.avisos_captura;
CREATE TRIGGER trg_cerrar_avisos
  BEFORE UPDATE ON public.avisos_captura
  FOR EACH ROW EXECUTE FUNCTION public.tg_avisos_vigilar_cierre();


-- ============================================================================
-- COMO APLICARLA, Y QUE COMPROBAR DESPUES
-- ============================================================================
-- NO se aplico con `supabase db push` (ERP-73: 10 migraciones ya vivas figuran
-- como pendientes y el push intentaria recorrerlas). Tampoco por MCP: el
-- clasificador bloquea DDL contra produccion por `apply_migration` Y por
-- `execute_sql`.
--
-- APLICAR: pegar este archivo COMPLETO en el editor SQL de Supabase, de una
-- sola corrida. Es idempotente (IF NOT EXISTS / ON CONFLICT / CREATE OR
-- REPLACE / DROP POLICY IF EXISTS): volver a correrlo no rompe nada.
--
-- LINEA BASE ANTES DE APLICAR (comprobada 2026-09-05):
--   85 finanzas ACTIVO · 474 inventario · 62 tickets ACTIVO · $395,033.00 · 15 entidades
--   OJO: NO son las 84/468/61/$386,201 de CLAUDE.md. La diferencia es UNA venta
--   real del 2026-09-03 (CEO Admin -> Aeropuerto, $8,832 CONTADO), no un dano.
--
-- ─── COMPROBACION 1 · las cifras no se movieron, y nacio el centinela ───────
--   SELECT 'finanzas_ACTIVO' AS cifra, count(*)::text FROM finanzas_ledger WHERE status='ACTIVO'
--   UNION ALL SELECT 'inventario', count(*)::text FROM inventario_ledger
--   UNION ALL SELECT 'tickets_ACTIVO', count(*)::text FROM transacciones_tickets WHERE status='ACTIVO'
--   UNION ALL SELECT 'cobrado', to_char(COALESCE(sum(total_cobrado_real),0),'FM999999999.00')
--                       FROM transacciones_tickets WHERE status='ACTIVO'
--   UNION ALL SELECT 'entidades', count(*)::text FROM entidades;
--   ESPERADO: 85 · 474 · 62 · 395033.00 · **16** (una mas: el centinela).
--
-- ─── COMPROBACION 2 · la tabla, sus candados y sus 6 politicas ─────────────
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.avisos_captura'::regclass;
--   -- ESPERADO: t
--   SELECT policyname, cmd FROM pg_policies
--    WHERE tablename='avisos_captura' ORDER BY cmd, policyname;
--   -- ESPERADO: 6 filas y NINGUNA con cmd = 'DELETE'.
--   SELECT has_table_privilege('authenticated','public.avisos_captura','DELETE');
--   -- ESPERADO: f
--
-- ─── COMPROBACION 3 · el candado de W4 rechaza el cierre ──────────────────
-- Con un ticket de concesion sin comprador ya capturado (o creando uno de
-- prueba y anulandolo despues). El UPDATE tiene que REVENTAR con 42501:
--   UPDATE avisos_captura SET estado='RESUELTO'
--    WHERE tipo='W4' AND estado='ABIERTO';
--   -- ESPERADO: ERROR ... CONCESION SIN DUENO ... Resolver = asignar.
--   UPDATE avisos_captura SET estado='IGNORADO', motivo_cierre='no aplica'
--    WHERE tipo='W4' AND estado='ABIERTO';
--   -- ESPERADO: el MISMO error. Ignorar tampoco cierra.
-- Y despues de reasignar el comprador, el mismo UPDATE tiene que pasar.
--
-- ─── COMPROBACION 4 · RLS: un DST solo ve lo suyo ─────────────────────────
-- Mismo metodo del 2026-09-03. David Flores es f0443423-60a0-4156-9bcd-52394ae274fe,
-- auth_id 9aca0f7d-...; hay que usar SU auth_id, porque `mi_entidad_id()` ya
-- solo empata por `entidades.auth_id`.
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<auth_id de David>","email":"david80ffo@gmail.com","role":"authenticated"}';
--   SELECT count(*) FROM avisos_captura;                      -- solo los suyos
--   SELECT count(*) FROM avisos_captura WHERE id_entidad <> mi_entidad_id()
--     AND id_entidad NOT IN (SELECT t.id FROM mis_entidades() AS t(id));
--   -- ESPERADO: 0. Si sale > 0, una politica esta de mas.
--   DELETE FROM avisos_captura;   -- ESPERADO: ERROR de permiso (no hay politica)
--   ROLLBACK;
--
-- ─── COMPROBACION 5 · el codigo y la base dicen el mismo UUID ─────────────
--   npx playwright test --project=puras tests/avisos.spec.ts
--   -- 15 pruebas en verde. La ultima lee ESTE archivo y lo compara contra
--   -- ENTIDAD_PENDIENTE_DE_ASIGNAR en lib/avisos.ts.
--
-- ─── DESPUES DE APLICAR ────────────────────────────────────────────────────
--   1. Regenerar los tipos: el bloque `avisos_captura` de `types/database.ts`
--      esta escrito A MANO. Manda el generado.
--   2. Actualizar la regla 6 de CLAUDE.md: hay una tabla nueva y son 10 tablas
--      con RLS, no 9.
-- ============================================================================
