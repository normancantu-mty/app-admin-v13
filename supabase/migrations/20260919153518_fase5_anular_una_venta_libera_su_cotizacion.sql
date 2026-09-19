-- ===========================================================================
--  AG-06 Fase 5 · anular una venta LIBERA la cotizacion que la origino
-- ===========================================================================
--  Escrito el 2026-09-19, el mismo dia que `20260919151831_fase5_anular_ticket_atomica`
--  y que el Paso 6 (convertir una cotizacion en venta). Aditiva: `CREATE OR
--  REPLACE` sobre la misma firma, sin `DROP` de nada. La version anterior de la
--  funcion queda descrita aqui abajo para poder volver a ella.
--
-- ---------------------------------------------------------------------------
--  1. EL DEFECTO QUE ESTA MIGRACION EVITA, Y QUE NO EXISTIA AYER
-- ---------------------------------------------------------------------------
--  El Paso 6 estrena la conversion: una cotizacion se vuelve venta y la fila
--  queda `estado = 'CONVERTIDA'` con `id_ticket` apuntando al ticket. El
--  `CHECK cotizaciones_convertida_lleva_ticket` amarra las dos cosas:
--
--      CHECK ((estado = 'CONVERTIDA') = (id_ticket IS NOT NULL))
--
--  Si esa venta se anula despues —y anular ventas es justo lo que el Paso 3
--  acaba de poner en el chat— la cotizacion **se queda CONVERTIDA apuntando a
--  un ticket ANULADO**. Consecuencias, las tres reales:
--
--      · la cotizacion ya no se puede volver a convertir: el Paso 6 rechaza
--        todo lo que no este VIGENTE, asi que la unica salida es recotizar;
--      · `v_cotizaciones.estado_efectivo` la sigue contando como cerrada, o sea
--        que el embudo de cotizaciones miente hacia arriba;
--      · y la venta que la respaldaba no existe. Es una conversion sin venta.
--
--  Es un estado que nadie escribio a proposito y que ninguna pantalla ensena
--  como problema. Se arregla aqui, en la misma transaccion que anula la venta,
--  porque hacerlo en TypeScript lo dejaria fuera del camino de la app: la
--  pantalla del POS anula por esta misma funcion.
--
-- ---------------------------------------------------------------------------
--  2. A QUE ESTADO VUELVE, Y POR QUE NO SIEMPRE A 'VIGENTE'
-- ---------------------------------------------------------------------------
--  Vuelve a lo que le tocaria hoy por su propia vigencia:
--
--      VIGENTE  si `vigente_hasta >= hoy en Mexico`
--      VENCIDA  si ya paso
--
--  Devolverla siempre a VIGENTE resucitaria una promesa de precio que caduco
--  hace un mes, y los precios se mueven — que es la razon por la que la
--  vigencia existe. Devolverla siempre a VENCIDA castigaria a quien anula una
--  venta del mismo dia por haberse equivocado de comprador.
--
--  `vigente_hasta` es una columna GENERADA (`fecha + vigencia_dias`), asi que
--  no hay que recalcular nada ni hay dos verdades sobre la misma fecha.
--
--  **El dia se toma en hora de Mexico, no en UTC.** A las 18:01 de Zacatecas ya
--  es el dia siguiente en UTC, y una cotizacion que vence hoy pasaria a VENCIDA
--  seis horas antes de tiempo. Es el mismo defecto que `hoyEnMX()` existe para
--  no cometer en TypeScript.
--
-- ---------------------------------------------------------------------------
--  3. POR QUE NO LLEVA `GET DIAGNOSTICS` CON `RAISE`
-- ---------------------------------------------------------------------------
--  Los pasos 1 a 3 exigen filas porque un ticket sin encabezado no existe. Este
--  es distinto: **la inmensa mayoria de las ventas no vienen de una cotizacion**
--  (hoy hay 66 tickets activos y 0 cotizaciones). Cero filas aqui es el caso
--  normal, no un fallo. El conteo se devuelve en el jsonb para que quien llame
--  pueda decirlo, y ahi se acaba.
--
-- ---------------------------------------------------------------------------
--  4. COMO SE VUELVE ATRAS
-- ---------------------------------------------------------------------------
--  Se vuelve a aplicar `20260919151831_fase5_anular_ticket_atomica.sql` tal
--  cual: es la misma firma y la misma funcion sin el bloque 4. No hace falta
--  ningun DROP.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.anular_ticket_atomica(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER              -- NO cambiar a DEFINER. Ver la migracion anterior.
SET search_path = public
AS $$
DECLARE
  v_tickets      integer;
  v_finanzas     integer;
  v_inventario   integer;
  v_cotizaciones integer;
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

  -- ── 4. La cotizacion que la origino, si la hubo ────────────────────────────
  -- Las dos columnas se mueven en el MISMO UPDATE porque el
  -- `CHECK cotizaciones_convertida_lleva_ticket` las amarra: dejar `estado` en
  -- 'CONVERTIDA' con `id_ticket` nulo —o al reves— no es un estado intermedio
  -- feo, es una fila que Postgres no acepta. Ver el punto 1.
  UPDATE public.cotizaciones
     SET estado = CASE
                    WHEN vigente_hasta IS NULL THEN 'VIGENTE'
                    WHEN vigente_hasta >= (now() AT TIME ZONE 'America/Mexico_City')::date
                      THEN 'VIGENTE'
                    ELSE 'VENCIDA'
                  END,
         id_ticket = NULL
   WHERE id_ticket = p_ticket_id;

  GET DIAGNOSTICS v_cotizaciones = ROW_COUNT;

  RETURN jsonb_build_object(
    'ticket',       p_ticket_id,
    'finanzas',     v_finanzas,
    'inventario',   v_inventario,
    'cotizaciones', v_cotizaciones
  );
END;
$$;

COMMENT ON FUNCTION public.anular_ticket_atomica(uuid) IS
  'Fase 5 del bot. Los UPDATE de la anulacion de una venta (encabezado, '
  'finanzas, inventario y la cotizacion que la origino) dentro de UNA '
  'transaccion: o se anula todo o no se anula nada. El paso 4 se agrego el '
  '2026-09-19 junto con la conversion de cotizaciones: sin el, anular una venta '
  'convertida dejaba la cotizacion CONVERTIDA apuntando a un ticket ANULADO, '
  'sin poder reconvertirse y contada como cerrada en el embudo. SECURITY '
  'INVOKER a proposito: el dueno tiene BYPASSRLS y con DEFINER esta funcion se '
  'saltaria el RLS y la ventana de 12 h del trigger. No contiene ninguna regla '
  'de permiso: esas viven en lib/anulacion-servidor.ts.';

REVOKE EXECUTE ON FUNCTION public.anular_ticket_atomica(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.anular_ticket_atomica(uuid)
  TO authenticated, service_role;
