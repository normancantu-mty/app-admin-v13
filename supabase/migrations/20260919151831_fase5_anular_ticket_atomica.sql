-- ===========================================================================
--  AG-06 Fase 5 · la ANULACION de una venta, en UNA transaccion
-- ===========================================================================
--  Escrito el 2026-09-19. Es la gemela exacta de `registrar_venta_atomica`
--  (ERP-11, migracion 20260918023212) para el lado que quedo sin cubrir.
--
-- ---------------------------------------------------------------------------
--  1. EL DEFECTO
-- ---------------------------------------------------------------------------
--  `annulComercialCascadePorTicketId` (`lib/ticket-annul-cascade.ts`) son TRES
--  UPDATE sueltos: el encabezado, el dinero y el inventario. PostgREST abre y
--  cierra una transaccion por peticion, asi que entre uno y otro no hay nada
--  que los ate.
--
--  Si el segundo o el tercero falla, lo que queda es peor que no haber
--  empezado: **el ticket anulado y su inventario todavia activo**. O sea stock
--  descontado por una venta que ya no existe. El inventario no se guarda como
--  total sino que se REPLAY-ea desde el ledger completo (CLAUDE.md), asi que
--  esa fila huerfana no se nota en ninguna pantalla: simplemente el almacen
--  dice menos piezas de las que hay, para siempre.
--
--  Es exactamente el defecto que ERP-11 elimino del lado de la venta y que
--  seguia vivo del lado de la anulacion.
--
-- ---------------------------------------------------------------------------
--  2. LAS DECISIONES, Y SON LAS MISMAS DE ERP-11
-- ---------------------------------------------------------------------------
--  (a) **`SECURITY INVOKER`, nunca `DEFINER`.** El dueno de la funcion seria
--      `postgres`, que tiene `rolbypassrls = true`: con `DEFINER` esta funcion
--      anularia tickets ajenos saltandose todo el RLS y todos los triggers de
--      permiso. Con `INVOKER`, dentro de la funcion sigue mandando el rol de
--      quien llama — ni un permiso mas, ni uno menos que hoy.
--
--      Y hay una segunda consecuencia que importa aqui mas que en ERP-11: el
--      trigger `tg_vigilar_update_no_admin` sigue corriendo dentro, con el
--      mismo `mi_rol()` de siempre. La ventana de 12 h de un DST **no se
--      evapora** por pasar a ser una RPC.
--
--  (b) **Ni una regla de negocio se muda aqui.** Quien puede anular que, y
--      hasta cuando, se queda en TypeScript (`lib/anulacion-servidor.ts` y
--      `lib/ticket-annul-cascade.ts`), donde esta probado. Esta funcion no
--      pregunta permisos: **su unico trabajo es que los tres UPDATE vivan o
--      mueran juntos.**
--
-- ---------------------------------------------------------------------------
--  3. EL SILENCIO DE ERP-66, TRADUCIDO
-- ---------------------------------------------------------------------------
--  La leccion de ERP-66 es que **un UPDATE denegado por RLS no da error:
--  devuelve cero filas**. Aqui eso se distingue asi:
--
--    · El ENCABEZADO tiene que tocar exactamente 1 fila. Cero filas significa
--      "ese ticket no existe" o "no me dejaron", y las dos son motivo para
--      lanzar y deshacer todo. Hoy los tres UPDATE sueltos devolvian 200 con
--      cero filas y la app se iba creyendo que anulo una venta.
--    · El DINERO y el INVENTARIO **pueden ser cero filas legitimamente**: una
--      venta sin movimiento de inventario existe (una concesion ya entregada),
--      y una ya anulada a medias tambien. Ahi cero no es sospechoso, asi que se
--      CUENTA y se devuelve, para que quien llama pueda ensenar el numero — que
--      es justo lo que D4 exige decir antes del "va".
--
--  Idempotente a proposito: anular dos veces el mismo ticket no lanza. El
--  segundo pasa devuelve `{"finanzas":0,"inventario":0}`, que es la verdad.
--
-- ---------------------------------------------------------------------------
--  4. EL ENLACE POR `notas`, QUE NO SE TOCA
-- ---------------------------------------------------------------------------
--  `inventario_ledger` NO tiene columna `id_ticket`: el ticket viaja DENTRO de
--  `notas`, con la marca `ticket:<uuid>` que pone `notasConIdTicket()`. El
--  `ILIKE '%<uuid>%'` de aqui es el MISMO criterio que ya usaba el TypeScript,
--  copiado sin cambiarle nada — y por eso esta funcion **no escribe `notas`**:
--  pisarlas romperia el unico enlace que existe entre las dos tablas.
--
-- ---------------------------------------------------------------------------
--  5. COMO SE VUELVE ATRAS
-- ---------------------------------------------------------------------------
--    DROP FUNCTION public.anular_ticket_atomica(uuid);
--  y `lib/ticket-annul-cascade.ts` vuelve a los tres UPDATE sueltos con un
--  `git revert`. Mientras nadie la llame, dejarla puesta no hace dano.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.anular_ticket_atomica(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER              -- ver punto 2(a). NO cambiar a DEFINER.
SET search_path = public
AS $$
DECLARE
  v_tickets    integer;
  v_finanzas   integer;
  v_inventario integer;
BEGIN
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'anular ticket: p_ticket_id no puede ser nulo'
      USING ERRCODE = '22023';
  END IF;

  -- ── 1. El encabezado ──────────────────────────────────────────────────────
  UPDATE public.transacciones_tickets
     SET status = 'ANULADO'
   WHERE id = p_ticket_id;

  GET DIAGNOSTICS v_tickets = ROW_COUNT;
  IF v_tickets <> 1 THEN
    RAISE EXCEPTION 'anular ticket: el encabezado % toco % filas (esperaba 1)',
      p_ticket_id, v_tickets USING ERRCODE = '25000';
  END IF;

  -- ── 2. El dinero ──────────────────────────────────────────────────────────
  -- `APPROVED` sigue en el filtro porque sigue existiendo el DEFAULT que lo
  -- produce (regla 4 de CLAUDE.md: la migracion que lo cierra esta escrita y
  -- sin aplicar). Quitarlo aqui dejaria filas de dinero vivas colgando de un
  -- ticket muerto.
  UPDATE public.finanzas_ledger
     SET status = 'ANULADO'
   WHERE id_ticket = p_ticket_id
     AND status IN ('ACTIVO', 'APPROVED');

  GET DIAGNOSTICS v_finanzas = ROW_COUNT;

  -- ── 3. El inventario ──────────────────────────────────────────────────────
  -- Mismo criterio que el TypeScript que sustituye: `notas` contiene el uuid.
  UPDATE public.inventario_ledger
     SET status = 'ANULADO'
   WHERE status = 'ACTIVO'
     AND notas ILIKE '%' || p_ticket_id::text || '%';

  GET DIAGNOSTICS v_inventario = ROW_COUNT;

  RETURN jsonb_build_object(
    'ticket',     p_ticket_id,
    'finanzas',   v_finanzas,
    'inventario', v_inventario
  );
END;
$$;

COMMENT ON FUNCTION public.anular_ticket_atomica(uuid) IS
  'Fase 5 del bot. Los tres UPDATE de la anulacion de una venta (encabezado, '
  'finanzas, inventario) dentro de UNA transaccion: o se anula todo o no se '
  'anula nada. Sustituye los tres UPDATE sueltos de '
  'annulComercialCascadePorTicketId, que podian dejar un ticket anulado con su '
  'inventario vivo. SECURITY INVOKER a proposito: el dueno tiene BYPASSRLS y '
  'con DEFINER esta funcion se saltaria el RLS y la ventana de 12 h del '
  'trigger. No contiene ninguna regla de permiso: esas viven en '
  'lib/anulacion-servidor.ts.';

-- ERP-57: sin estas dos lineas la funcion nace siendo una RPC publica, porque
-- el default privilege de `public` concede EXECUTE a `anon`.
REVOKE EXECUTE ON FUNCTION public.anular_ticket_atomica(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.anular_ticket_atomica(uuid)
  TO authenticated, service_role;
