-- ============================================================================
-- Anular una fila cierra sus avisos — ERP-59 (cola de captura)
-- ============================================================================
-- EL DEFECTO, con su caso real (2026-09-12, Fase 2 del bot de cobranza).
-- Se anulo una fila de prueba de `finanzas_ledger` y **su aviso se quedo vivo
-- en la cola de captura de Norman**, con el titulo y la consecuencia de una
-- fila que ya no existe. Hubo que cerrarlo a mano como IGNORADO, escribiendo
-- el motivo a mano. Un aviso huerfano no es ruido inofensivo: la cola vale
-- justamente porque lo que esta ahi hay que capturarlo. Si tiene basura, se
-- deja de leer, y entonces no protege nada.
--
-- Regla 6 manda: NO SE BORRA NADA. El ledger va a ANULADO y el aviso va a
-- IGNORADO con motivo escrito. Ni uno ni otro desaparece.
--
--
-- ─── DONDE VIVE ESTO, Y POR QUE. La pregunta no era obvia. ──────────────────
--
-- Habia dos sitios posibles: la accion de anular, en TypeScript, o un trigger
-- aqui. Se decidio con un dato y no con una preferencia: **se conto cuantos
-- caminos anulan una fila.** Son cuatro en el codigo, mas la mano:
--
--   app/actions/audit.ts:223 ......... anular movimiento (ADMIN)
--   app/actions/audit.ts:276 ......... anular con nota de anulacion
--   app/api/finanzas/aprobaciones/route.ts:140 .. rechazar un abono pendiente
--   lib/ticket-annul-cascade.ts:37 ... cascada al anular un ticket
--   + el editor SQL de Supabase ...... que es justo como nacio el caso real
--
-- Cablearlo en la accion habria tapado UNO de esos cinco caminos, y el quinto
-- —la mano— es el que produjo el bug. Un candado que solo cubre la puerta por
-- la que no entro el ladron no es un candado.
--
-- Y no es criterio nuevo: **es exactamente el que ya se aplico en esta misma
-- tabla.** `tg_avisos_vigilar_cierre` (2026-09-05) vive en un trigger, y su
-- comentario dice por que: *"la app no es el unico camino a la base. Con un
-- token valido, PostgREST atiende un curl"*. Lo mismo vale aqui.
--
-- LO QUE SE PIERDE, dicho completo: un trigger es **invisible desde el
-- codigo**. Quien lea `app/actions/audit.ts` no va a ver que anular cierra
-- avisos. Por eso el precio se paga en dos sitios y no en uno:
--   1. `tests/avisos.spec.ts` lee ESTE archivo y exige que cada tabla a la que
--      un aviso puede apuntar este cubierta. Si alguien agrega un
--      `tabla: 'otra_cosa'` en un `registrarAviso`, la prueba se pone roja.
--   2. Los `COMMENT ON TRIGGER` de abajo, que salen en el panel de Supabase.
--
--
-- ─── QUE NO HACE, A PROPOSITO ──────────────────────────────────────────────
--
-- 1. **No toca `transacciones_tickets`.** Un aviso W4 —venta en concesion sin
--    comprador— NO SE PUEDE CERRAR mientras el ticket apunte al centinela: lo
--    impide `tg_avisos_vigilar_cierre` con un RAISE. Si este trigger intentara
--    cerrarlo, la excepcion subiria y **la anulacion del ticket fallaria**.
--    Cambiar ese candado para que perdone a los tickets anulados es aflojar
--    una regla que Norman reviso con cinco comprobaciones; no se hace sin su
--    palabra. Queda reportado, no resuelto. El `tipo <> 'W4'` de abajo es el
--    cinturon por si alguien conecta el trigger a los tickets sin leer esto.
--
-- 2. **No reabre nada.** Si una fila ANULADA volviera a ACTIVO, su aviso se
--    queda IGNORADO: un aviso cerrado no se reabre (regla 2 de
--    `tg_avisos_vigilar_cierre`). Es deliberado — el rastro de que hubo un
--    aviso y de por que se cerro vale mas que la comodidad de reciclarlo.
--
-- 3. **No borra ni edita el aviso.** Solo mueve `estado` y `motivo_cierre`,
--    que son las dos unicas columnas que `tg_avisos_vigilar_cierre` deja
--    cambiar. La firma (`cerrado_por`, `cerrado_en`) la sigue poniendo ese
--    trigger, con `usuario_de_sesion()`, que devuelve 'sistema' cuando no hay
--    JWT — o sea que una anulacion hecha en el editor SQL tambien queda
--    firmada y no rompe el CHECK `avisos_cierre_coherente`.
--
--
-- ─── SI HAY QUE DESHACERLA ─────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_avisos_de_fila_anulada_finanzas ON public.finanzas_ledger;
--   DROP TRIGGER IF EXISTS trg_avisos_de_fila_anulada_inventario ON public.inventario_ledger;
--   DROP FUNCTION IF EXISTS public.tg_cerrar_avisos_de_fila_anulada();
-- Los avisos ya cerrados se quedan cerrados: regla 6, no se reabren.
--
-- ─── POR QUE ESTE ARCHIVO NO ESTA EN `supabase/migrations/` TODAVIA ─────────
-- Porque **el archivo se nombra DESPUES de aplicar**, no antes: `apply_migration`
-- sella con SU hora UTC y no con la del nombre que uno invente. Un archivo en
-- `migrations/` que la base no reconoce pone en rojo la prueba de sincronia de
-- ERP-73 (`tests/salud-del-sistema.spec.ts:82`) y con ella el `pre-push` entero.
-- Mismo sitio que `supabase/tkt-051-status-symmetry.sql`, por la misma razon.
-- Cuando Norman lo aplique, se mueve y se renombra con el sello real.
-- ============================================================================


-- ─── 1. LA FUNCION ──────────────────────────────────────────────────────────
-- Generica a proposito: `TG_TABLE_NAME` es lo mismo que se guarda en
-- `avisos_captura.tabla` ('finanzas_ledger', 'inventario_ledger'), asi que la
-- misma funcion sirve para los dos ledgers y para el que venga. SECURITY
-- DEFINER porque quien anula puede no tener politica de UPDATE sobre el aviso
-- —un DST anulando lo suyo— y el aviso tiene que cerrarse igual.

CREATE OR REPLACE FUNCTION public.tg_cerrar_avisos_de_fila_anulada() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_motivo   text;
  v_cerrados integer;
BEGIN
  -- El motivo dice DE QUE FILA venia y POR QUE se cerro. Sin eso, la cola
  -- muestra un IGNORADO sin autor ni causa, que es peor que el huerfano:
  -- parece que alguien lo desestimo a mano.
  v_motivo :=
    'Cerrado automaticamente: la fila de ' || TG_TABLE_NAME || ' ' || NEW.id::text ||
    ' quedo ANULADA el ' ||
    to_char(now() AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') ||
    ' (hora de Mexico). El aviso pedia completar la captura de esa fila; la fila ya no ' ||
    'cuenta, asi que no queda nada que capturar. Si la anulacion fue un error, se corrige ' ||
    'reponiendo la fila: este aviso no se reabre (regla 6).';

  UPDATE public.avisos_captura
     SET estado        = 'IGNORADO',
         motivo_cierre = v_motivo
   WHERE tabla       = TG_TABLE_NAME
     AND id_registro = NEW.id
     AND estado      = 'ABIERTO'
     -- El cinturon del punto 2 de la cabecera. W4 tiene su propio candado y
     -- cerrarlo desde aqui tumbaria la anulacion entera.
     AND tipo <> 'W4';

  GET DIAGNOSTICS v_cerrados = ROW_COUNT;

  IF v_cerrados > 0 THEN
    RAISE NOTICE '[avisos] % aviso(s) cerrados por la anulacion de %.%',
      v_cerrados, TG_TABLE_NAME, NEW.id;
  END IF;

  -- AFTER trigger: el valor de retorno se ignora.
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.tg_cerrar_avisos_de_fila_anulada() IS
  'Cierra como IGNORADO, con motivo automatico, los avisos ABIERTOS que apuntan '
  'a una fila que acaba de quedar ANULADA. Vive en un trigger y no en la accion '
  'de TypeScript porque hay cuatro caminos que anulan en el codigo y uno mas a '
  'mano en el editor SQL — y el caso real que la motivo entro por ese ultimo.';

-- Misma politica que el resto de las funciones de trigger de esta base: nadie
-- la llama por RPC (advisor de seguridad 0029).
REVOKE EXECUTE ON FUNCTION public.tg_cerrar_avisos_de_fila_anulada() FROM PUBLIC, anon, authenticated;


-- ─── 2. LOS DISPAROS ────────────────────────────────────────────────────────
-- `AFTER UPDATE OF status` y no `AFTER UPDATE` a secas: si el UPDATE no toca
-- `status`, Postgres ni evalua el WHEN. Y el WHEN exige la TRANSICION, no el
-- estado: sin `OLD.status IS DISTINCT FROM 'ANULADO'`, cualquier UPDATE sobre
-- una fila ya anulada volveria a disparar y a reescribir motivos ya escritos.

DROP TRIGGER IF EXISTS trg_avisos_de_fila_anulada_finanzas ON public.finanzas_ledger;
CREATE TRIGGER trg_avisos_de_fila_anulada_finanzas
  AFTER UPDATE OF status ON public.finanzas_ledger
  FOR EACH ROW
  WHEN (NEW.status = 'ANULADO' AND OLD.status IS DISTINCT FROM 'ANULADO')
  EXECUTE FUNCTION public.tg_cerrar_avisos_de_fila_anulada();

COMMENT ON TRIGGER trg_avisos_de_fila_anulada_finanzas ON public.finanzas_ledger IS
  'Anular arrastra los avisos de esa fila a IGNORADO. Aqui apuntan W10-W14, W16 '
  'y W17. Ver la migracion cerrar_avisos_de_fila_anulada.';

-- `inventario_ledger` entra por el mismo defecto y con el mismo codigo: los
-- avisos de `app/actions/inventario.ts` apuntan ahi (tabla: 'inventario_ledger')
-- y hoy quedan igual de huerfanos. Dejarlo fuera seria arreglar la mitad del
-- mismo bug y tener que volver a abrir el archivo.
DROP TRIGGER IF EXISTS trg_avisos_de_fila_anulada_inventario ON public.inventario_ledger;
CREATE TRIGGER trg_avisos_de_fila_anulada_inventario
  AFTER UPDATE OF status ON public.inventario_ledger
  FOR EACH ROW
  WHEN (NEW.status = 'ANULADO' AND OLD.status IS DISTINCT FROM 'ANULADO')
  EXECUTE FUNCTION public.tg_cerrar_avisos_de_fila_anulada();

COMMENT ON TRIGGER trg_avisos_de_fila_anulada_inventario ON public.inventario_ledger IS
  'Anular arrastra los avisos de esa fila a IGNORADO. Aqui apuntan W1 y W3. '
  'Ver la migracion cerrar_avisos_de_fila_anulada.';


-- ============================================================================
-- COMO SE APLICA, Y QUE SE COMPRUEBA — PENDIENTE (la aplica Norman)
-- ============================================================================
-- Se aplica pegando este archivo completo en el editor SQL de Supabase, de una
-- sola corrida. **NO con `supabase db push`** (ERP-73: 10 migraciones ya vivas
-- figuran como pendientes) ni por MCP (el clasificador bloquea DDL contra
-- produccion por los dos caminos). Es idempotente —CREATE OR REPLACE y DROP
-- TRIGGER IF EXISTS—: volver a correrla no rompe nada.
--
-- ─── COMPROBACION 1 · los dos triggers existen y disparan donde deben ───────
--   SELECT c.relname AS tabla, t.tgname, t.tgenabled
--     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE t.tgname LIKE 'trg_avisos_de_fila_anulada%'
--    ORDER BY 1;
--   -- ESPERADO: 2 filas (finanzas_ledger, inventario_ledger), tgenabled = 'O'.
--
-- ─── COMPROBACION 2 · EL CASO REAL, dentro de una transaccion deshecha ──────
-- Es la que importa: reproduce el bug del 2026-09-12 y exige que ya no pase.
--   BEGIN;
--     -- una fila cualquiera ACTIVA, con un aviso sembrado apuntandole
--     WITH f AS (SELECT id, id_entidad FROM finanzas_ledger WHERE status='ACTIVO' LIMIT 1)
--     INSERT INTO avisos_captura (tipo, severidad, mensaje, id_entidad, tabla, id_registro)
--     SELECT 'W14', 'REVISAR', 'PRUEBA huerfano', f.id_entidad, 'finanzas_ledger', f.id FROM f;
--
--     -- ANTES: el aviso esta ABIERTO
--     SELECT estado FROM avisos_captura WHERE mensaje='PRUEBA huerfano';
--     -- ESPERADO: ABIERTO
--
--     UPDATE finanzas_ledger SET status='ANULADO'
--      WHERE id = (SELECT id_registro FROM avisos_captura WHERE mensaje='PRUEBA huerfano');
--
--     -- DESPUES: cerrado solo, con motivo que nombra la fila
--     SELECT estado, cerrado_por, left(motivo_cierre, 60)
--       FROM avisos_captura WHERE mensaje='PRUEBA huerfano';
--     -- ESPERADO: IGNORADO · una firma (el correo de la sesion, o 'sistema') ·
--     --           'Cerrado automaticamente: la fila de finanzas_ledger <uuid>...'
--   ROLLBACK;
--
-- ─── COMPROBACION 3 · EL CONTROL POSITIVO, en la misma pasada ───────────────
-- Sin esto, la comprobacion 2 no distingue "el trigger funciono" de "el aviso
-- nunca estuvo abierto". Un aviso de OTRA fila NO se debe tocar.
--   BEGIN;
--     ... sembrar DOS avisos, uno apuntando a la fila que se anula y otro a una
--     fila distinta que se queda ACTIVA; anular la primera; y exigir:
--     ESPERADO: el primero IGNORADO, **el segundo sigue ABIERTO**.
--   ROLLBACK;
--
-- ─── COMPROBACION 4 · las cifras no se movieron ────────────────────────────
--   SELECT 'finanzas_ACTIVO' AS cifra, count(*)::text FROM finanzas_ledger WHERE status='ACTIVO'
--   UNION ALL SELECT 'inventario_ACTIVO', count(*)::text FROM inventario_ledger WHERE status='ACTIVO'
--   UNION ALL SELECT 'avisos_ABIERTO', count(*)::text FROM avisos_captura WHERE estado='ABIERTO';
--   -- Se corre ANTES y DESPUES de aplicar. Tienen que dar lo mismo: esta
--   -- migracion no toca ni una fila, solo agrega dos triggers.
-- ============================================================================
