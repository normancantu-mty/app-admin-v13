-- ===========================================================================
--  ERP-11 · la venta del POS, en UNA transaccion
-- ===========================================================================
--  Escrito el 2026-09-17 por el Socio.  **ESTA MIGRACION NO ESTA APLICADA.**
--  Se aplica con `apply_migration` del MCP. NUNCA con `supabase db push`.
--
--  **NINGUN SITIO DE LLAMADA CAMBIA EN ESTA TANDA.** Este archivo crea una
--  funcion que hoy no llama nadie. `app/actions/pos.ts` sigue exactamente como
--  esta, el repo sigue verde, y el dia que Norman diga "va" el trabajo de SQL
--  ya esta hecho y revisado. El plan de corte esta en el punto 6.
--
-- ---------------------------------------------------------------------------
--  1. EL DEFECTO
-- ---------------------------------------------------------------------------
--  `procesarVentaPOS` escribe en CUATRO tablas con cinco llamadas sueltas
--  (`app/actions/pos.ts`, lineas ~533, 576, 749, 758, 772). Entre una y otra no
--  hay transaccion: PostgREST abre y cierra una por peticion. Si la tercera
--  falla, las dos primeras ya estan committeadas.
--
--  Lo que hay en su lugar es una compensacion a mano — `rollbackTicket`, que
--  BORRA lo escrito. Y ese borrado tiene su propio modo de fallo, que es ERP-66
--  y ya costo caro: **un DELETE denegado por RLS no da error; devuelve 200 con
--  cero filas.** Un vendedor no-ADMIN no puede borrar, asi que su venta a
--  medias se quedaba en el ledger y el usuario solo veia "Error al guardar
--  detalles". `lib/pos-rollback.ts` cerro el silencio —ahora se mira si el
--  borrado afecto filas— pero no cambia el fondo:
--
--      **la compensacion es otra escritura, y otra escritura puede fallar.**
--      (El nombre de la clase: *compensating transaction failure*.)
--
--  Con una funcion, las cinco escrituras caen dentro de la MISMA transaccion:
--  PostgREST envuelve cada llamada a RPC en una, y un `RAISE` en cualquier
--  punto deshace todo lo anterior sin que nadie tenga que borrar nada. El
--  camino de compensacion deja de existir, que es mejor que arreglarlo.
--
-- ---------------------------------------------------------------------------
--  2. LAS DOS DECISIONES QUE DECIDEN SI ESTO ES UN ARREGLO O UN AGUJERO
-- ---------------------------------------------------------------------------
--  (a) **`SECURITY INVOKER`, y no `DEFINER`.** Es la decision mas importante
--      del archivo. Medido hoy en esta base: el rol `postgres` —que seria el
--      dueno de la funcion— tiene **`rolbypassrls = true`**. Una funcion
--      `SECURITY DEFINER` correria con ese rol y **saltaria TODAS las politicas
--      de RLS**: cualquiera con sesion podria registrar ventas a nombre de
--      quien quisiera, con cualquier entidad y cualquier monto. Convertiria el
--      arreglo de atomicidad en el agujero mas grande del sistema. Con
--      `INVOKER`, dentro de la funcion sigue mandando el RLS del usuario, igual
--      que hoy — ni un permiso mas, ni uno menos.
--
--  (b) **Ni una regla de negocio se muda aqui.** Precios, comisiones,
--      triangulacion, impuestos y redondeos se quedan en TypeScript, donde
--      estan probados. Esta funcion **escribe lo que le dan**; su unico trabajo
--      es que las cinco escrituras vivan o mueran juntas. Duplicar las reglas
--      en SQL crearia dos verdades y la duplicacion es la deuda declarada de
--      este repo.
--
-- ---------------------------------------------------------------------------
--  3. EL CUIDADO DE ERP-66, TRADUCIDO A ESTA FUNCION
-- ---------------------------------------------------------------------------
--  El encargo pide que la funcion distinga "escribi cero porque no habia nada"
--  de "escribi cero porque no me dejaron". Aqui no hay ningun DELETE —no hace
--  falta compensar—, pero la misma clase de silencio existe en el INSERT y se
--  trata explicitamente:
--
--    · Un INSERT que viola una politica `WITH CHECK` **si lanza** (42501), y
--      eso deshace la transaccion entera: ese caso esta cubierto solo.
--    · El caso mudo es otro: que entren MENOS filas de las pedidas (una clave
--      mal escrita en el JSON, un arreglo que llego a medias). PostgREST no se
--      queja de eso. Por eso **cada INSERT cuenta lo que pidio y lo que
--      escribio, y si no coinciden lanza**. Cero filas pedidas se salta el
--      INSERT entero — que es "no habia nada"; cero filas escritas habiendo
--      pedido N es "no me dejaron", y revienta.
--    · Y el encabezado ademas exige su `RETURNING`: si no vuelve un id, no hay
--      venta.
--
--  La pregunta del control, contestada: si esto estuviera roto —si la funcion
--  no comparase— una venta con 3 renglones de los que solo entrara 1 terminaria
--  en `ok: true` y en un ticket que cobra de mas. Se veria igual que una venta
--  buena. Por eso se cuenta.
--
-- ---------------------------------------------------------------------------
--  4. EL CONTRATO CON QUIEN LA LLAMA
-- ---------------------------------------------------------------------------
--  · `p_ticket`     — objeto. UNA fila de `transacciones_tickets`.
--                     Puede traer `id`: **el cliente genera el uuid** para
--                     poder construir con el las `notas` y las `categoria` que
--                     llevan el folio. Si no lo trae, lo pone la base.
--  · `p_detalles`   — arreglo, al menos 1. `id_ticket` lo pone la funcion:
--                     lo que venga en el JSON se IGNORA, para que nadie pueda
--                     colgar renglones de un ticket ajeno.
--  · `p_finanzas`   — arreglo, puede ir vacio. `id_ticket` tambien lo fuerza
--                     la funcion.
--  · `p_inventario` — arreglo, puede ir vacio.
--
--  `usuario_creador` NO se toma del JSON aunque venga: el trigger
--  `tg_forzar_autor` (BEFORE INSERT) lo sobreescribe con el correo del JWT.
--  Eso ya pasa hoy y sigue pasando dentro de la funcion.
--
-- ---------------------------------------------------------------------------
--  6. EL PLAN DE CORTE — escrito, NO ejecutado
-- ---------------------------------------------------------------------------
--  Que cambia, en que orden, y como se vuelve atras. Cada paso es un commit.
--
--  PASO 0 (antes de nada). Aplicar esta migracion con `apply_migration` y
--         moverla a `supabase/migrations/` con el nombre sellado (ERP-83).
--         Hasta aqui NADA de la aplicacion cambia: la funcion existe y no la
--         llama nadie. Si se detiene el plan en este punto, no hay nada que
--         deshacer.
--
--  PASO 1 (depende de 0). `app/actions/pos.ts`: generar el uuid del ticket en
--         el servidor —`crypto.randomUUID()`— ANTES de armar los payloads, y
--         usar esa constante donde hoy se usa `ticketData.id`. Es un cambio
--         mecanico y **no cambia el comportamiento**: sigue habiendo cinco
--         escrituras sueltas. Se puede commitear solo y verificar en verde.
--         Es el paso que hace posible el siguiente, porque las `notas` y las
--         `categoria` llevan el folio del ticket dentro.
--
--  PASO 2 (depende de 1). Sustituir las CINCO llamadas por una:
--             const { data, error } = await supabase.rpc('registrar_venta_atomica', {
--               p_ticket, p_detalles, p_finanzas, p_inventario
--             })
--         y borrar `rollbackTicket` DEL CAMINO DE LA VENTA. El mensaje de
--         error al usuario pasa a ser el de la excepcion de Postgres.
--
--  PASO 3 (depende de 2). `lib/pos-rollback.ts` y su prueba **no se borran**:
--         `evaluarRollbackPOS` sigue siendo el juicio correcto para cualquier
--         otro sitio que compense a mano (compras, devoluciones). Lo que se
--         retira es su uso en el POS. Borrarlo seria tirar la leccion de
--         ERP-66 junto con el codigo que dejo de necesitarla.
--
--  PASO 4 (depende de 2). La prueba que cierra el ticket: una venta que falla
--         en el CUARTO insert no debe dejar ni encabezado ni renglones. Hoy
--         eso solo se puede comprobar contra la base (proyecto `equivalencia`,
--         service role). El control negativo es correr esa misma prueba contra
--         el codigo ANTERIOR: tiene que quedar roja, porque hoy el encabezado
--         SI sobrevive cuando el vendedor no es ADMIN.
--
--  COMO SE VUELVE ATRAS. Los pasos 1-4 son commits de codigo: `git revert`.
--  El paso 0 se deshace con `DROP FUNCTION public.registrar_venta_atomica
--  (jsonb, jsonb, jsonb, jsonb);` — y mientras nadie la llame, dejarla puesta
--  tampoco hace dano.
--
--  LO QUE ESTE ARCHIVO **NO** RESUELVE, Y NO SE VA A COLAR EN SILENCIO:
--
--  · **Reintento = venta doble.** Si la red se corta despues del COMMIT, el
--    cliente no sabe que entro y puede reintentar. Es un hueco que existe HOY
--    igual, y no es ERP-11. La cura seria una clave de idempotencia con indice
--    unico; se decide aparte porque implica columna nueva en una tabla viva.
--  · **El aviso W4 sigue fuera de la transaccion.** Hoy se escribe al final, a
--    proposito. Con la venta atomica podria entrar dentro de la funcion y
--    quedar atado a la venta. **Es una decision de negocio** —si un aviso
--    perdido es peor o mejor que una venta bloqueada por un aviso que fallo— y
--    la toma Norman, no esta migracion.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  5. LA FUNCION
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.registrar_venta_atomica(
  p_ticket     jsonb,
  p_detalles   jsonb,
  p_finanzas   jsonb DEFAULT '[]'::jsonb,
  p_inventario jsonb DEFAULT '[]'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER              -- ver punto 2(a). NO cambiar a DEFINER.
SET search_path = public
AS $$
DECLARE
  v_ticket_id  uuid;
  v_pedidas    integer;
  v_escritas   integer;
BEGIN
  -- ── 0. Que lo que llego sea lo que se espera ──────────────────────────────
  IF jsonb_typeof(p_ticket) <> 'object' THEN
    RAISE EXCEPTION 'venta atomica: p_ticket tiene que ser un objeto, llego %',
      jsonb_typeof(p_ticket) USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_detalles) <> 'array' OR jsonb_array_length(p_detalles) = 0 THEN
    RAISE EXCEPTION 'venta atomica: p_detalles tiene que ser un arreglo con al menos un renglon'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_finanzas) <> 'array' OR jsonb_typeof(p_inventario) <> 'array' THEN
    RAISE EXCEPTION 'venta atomica: p_finanzas y p_inventario tienen que ser arreglos'
      USING ERRCODE = '22023';
  END IF;

  -- ── 1. El encabezado ──────────────────────────────────────────────────────
  -- Las columnas se listan una por una a proposito. `jsonb_populate_record`
  -- habria sido mas corto y habria metido NULL en cada columna ausente,
  -- ATROPELLANDO los DEFAULT de la tabla (`status`, `condicion_pago`,
  -- `fecha_transaccion`, los impuestos en 0). Aqui, lo que no venga en el JSON
  -- se resuelve con COALESCE al mismo default que tiene la columna.
  INSERT INTO public.transacciones_tickets (
    id, id_vendedor, id_comprador, id_cuenta_destino,
    subtotal_catalogo, total_cobrado_real, monto_base_ingreso,
    impuesto_iva_calculado, impuesto_ieps_calculado, bonificacion_cascada_generada,
    fecha_transaccion, usuario_creador, condicion_pago, status
  )
  SELECT
    COALESCE((p_ticket ->> 'id')::uuid, gen_random_uuid()),
    (p_ticket ->> 'id_vendedor')::uuid,
    (p_ticket ->> 'id_comprador')::uuid,
    (p_ticket ->> 'id_cuenta_destino')::uuid,
    (p_ticket ->> 'subtotal_catalogo')::numeric,
    (p_ticket ->> 'total_cobrado_real')::numeric,
    (p_ticket ->> 'monto_base_ingreso')::numeric,
    COALESCE((p_ticket ->> 'impuesto_iva_calculado')::numeric, 0),
    COALESCE((p_ticket ->> 'impuesto_ieps_calculado')::numeric, 0),
    COALESCE((p_ticket ->> 'bonificacion_cascada_generada')::numeric, 0),
    COALESCE((p_ticket ->> 'fecha_transaccion')::timestamptz, now()),
    p_ticket ->> 'usuario_creador',
    COALESCE(p_ticket ->> 'condicion_pago', 'CONTADO'),
    COALESCE(p_ticket ->> 'status', 'ACTIVO')
  RETURNING id INTO v_ticket_id;

  IF v_ticket_id IS NULL THEN
    RAISE EXCEPTION 'venta atomica: el encabezado no devolvio id' USING ERRCODE = '25000';
  END IF;

  -- ── 2. Los renglones ──────────────────────────────────────────────────────
  v_pedidas := jsonb_array_length(p_detalles);

  INSERT INTO public.ticket_detalles (id_ticket, id_producto, cantidad, precio_unitario, subtotal_linea)
  SELECT v_ticket_id,            -- FORZADO. Ver el contrato, punto 4.
         x.id_producto, x.cantidad, x.precio_unitario, x.subtotal_linea
    FROM jsonb_to_recordset(p_detalles) AS x(
           id_producto     uuid,
           cantidad        integer,
           precio_unitario numeric,
           subtotal_linea  numeric
         );

  GET DIAGNOSTICS v_escritas = ROW_COUNT;
  IF v_escritas <> v_pedidas THEN
    RAISE EXCEPTION 'venta atomica: ticket_detalles pidio % renglones y escribio %',
      v_pedidas, v_escritas USING ERRCODE = '25000';
  END IF;

  -- ── 3. El lado monetario ──────────────────────────────────────────────────
  v_pedidas := jsonb_array_length(p_finanzas);
  IF v_pedidas > 0 THEN
    INSERT INTO public.finanzas_ledger (
      id_cuenta_origen, id_cuenta_destino, id_ticket, tipo_movimiento, monto,
      categoria, es_recurrente, fecha_movimiento, id_entidad_relacionada,
      categoria_gasto, status, descripcion, subcategoria, usuario_creador, metodo_pago
    )
    SELECT x.id_cuenta_origen, x.id_cuenta_destino,
           v_ticket_id,        -- FORZADO, igual que los renglones.
           x.tipo_movimiento, x.monto, x.categoria,
           COALESCE(x.es_recurrente, false),
           COALESCE(x.fecha_movimiento, now()),
           x.id_entidad_relacionada, x.categoria_gasto,
           COALESCE(x.status, 'ACTIVO'),
           x.descripcion, x.subcategoria, x.usuario_creador, x.metodo_pago
      FROM jsonb_to_recordset(p_finanzas) AS x(
             id_cuenta_origen       uuid,
             id_cuenta_destino      uuid,
             tipo_movimiento        varchar,
             monto                  numeric,
             categoria              varchar,
             es_recurrente          boolean,
             fecha_movimiento       timestamptz,
             id_entidad_relacionada uuid,
             categoria_gasto        text,
             status                 text,
             descripcion            text,
             subcategoria           text,
             usuario_creador        text,
             metodo_pago            text
           );

    GET DIAGNOSTICS v_escritas = ROW_COUNT;
    IF v_escritas <> v_pedidas THEN
      RAISE EXCEPTION 'venta atomica: finanzas_ledger pidio % movimientos y escribio %',
        v_pedidas, v_escritas USING ERRCODE = '25000';
    END IF;
  END IF;

  -- ── 4. El lado fisico ─────────────────────────────────────────────────────
  -- `inventario_ledger` NO tiene `id_ticket`: el ticket viaja dentro de
  -- `notas`, que las arma el cliente (`notasConIdTicket`). Por eso el contrato
  -- pide que el uuid del ticket lo genere quien llama.
  -- La entidad obligatoria de ERP-16 ya es un CHECK de la tabla: un movimiento
  -- sin origen ni destino lanza aqui y deshace la venta entera.
  v_pedidas := jsonb_array_length(p_inventario);
  IF v_pedidas > 0 THEN
    INSERT INTO public.inventario_ledger (
      id_producto, id_entidad_origen, id_entidad_destino, tipo_movimiento,
      cantidad, costo_unitario_movimiento, notas, fecha_movimiento,
      usuario_creador, cubeta, status
    )
    SELECT x.id_producto, x.id_entidad_origen, x.id_entidad_destino, x.tipo_movimiento,
           x.cantidad,
           COALESCE(x.costo_unitario_movimiento, 0.00),
           x.notas,
           COALESCE(x.fecha_movimiento, now()),
           x.usuario_creador,
           COALESCE(x.cubeta, 'PAGADO'),
           COALESCE(x.status, 'ACTIVO')
      FROM jsonb_to_recordset(p_inventario) AS x(
             id_producto               uuid,
             id_entidad_origen         uuid,
             id_entidad_destino        uuid,
             tipo_movimiento           varchar,
             cantidad                  numeric,
             costo_unitario_movimiento numeric,
             notas                     text,
             fecha_movimiento          timestamptz,
             usuario_creador           text,
             cubeta                    text,
             status                    text
           );

    GET DIAGNOSTICS v_escritas = ROW_COUNT;
    IF v_escritas <> v_pedidas THEN
      RAISE EXCEPTION 'venta atomica: inventario_ledger pidio % movimientos y escribio %',
        v_pedidas, v_escritas USING ERRCODE = '25000';
    END IF;
  END IF;

  RETURN v_ticket_id;
END;
$$;

COMMENT ON FUNCTION public.registrar_venta_atomica(jsonb, jsonb, jsonb, jsonb) IS
  'ERP-11. Las cinco escrituras del POS (encabezado, renglones, finanzas, '
  'comisiones e inventario) dentro de UNA transaccion: o entran todas o no '
  'entra ninguna, sin compensacion que borre nada. SECURITY INVOKER a '
  'proposito: el dueno tiene BYPASSRLS y con DEFINER esta funcion se saltaria '
  'todas las politicas. No contiene ninguna regla de negocio: esas viven en '
  'app/actions/pos.ts.';

-- ERP-57 en accion: sin estas dos lineas, la funcion nace siendo una RPC
-- publica, porque el default privilege de `public` concede EXECUTE a `anon`.
REVOKE EXECUTE ON FUNCTION public.registrar_venta_atomica(jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_venta_atomica(jsonb, jsonb, jsonb, jsonb)
  TO authenticated;
