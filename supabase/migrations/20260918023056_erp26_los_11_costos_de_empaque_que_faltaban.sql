-- ERP-26, parte 3: los 11 costos de empaque que faltaban, cada uno con su papel.
--
-- Escrito el 2026-09-17 por el Socio Estrategico. Aplicada con apply_migration.
--
-- NO ES ADITIVA: son UPDATE sobre filas existentes. Norman lo autorizo de forma
-- explicita en el chat del 2026-09-17, sabiendo que no es aditiva: *"poner costos
-- es un UPDATE, no es aditivo -- Si hazlo por favor"*.
--
-- LOS DOS SUPUESTOS DE LOS QUE DEPENDE TODO ESTO, DICHOS ANTES DE LOS NUMEROS
-- ---------------------------------------------------------------------------
-- (1) Los costos son NETOS: sin IVA. La cotizacion de ETIQUS dice "+ IVA" de
--     forma explicita; las de Solo Vidrio no lo separan y se asumen netas. Si
--     resultara que el vidrio viene con IVA incluido, estos costos estan un 16%
--     ALTOS y el margen sale bajo -- que es el lado seguro del error.
-- (2) NO incluyen flete, igual que en ERP-10 y por la misma razon: la guia de
--     Solo Vidrio 94507 es una tarima de 2,400.79 por 1,920 piezas mezcladas,
--     y repartirla exige saber que pedido trajo que pieza. El costo queda
--     SUBESTIMADO y dicho, no prorrateado a ojo.
--
-- POR QUE EL PRECIO MAS NUEVO Y NO EL CONTEMPORANEO
-- ---------------------------------------------------------------------------
-- Es la decision contraria a la de ERP-10, y a proposito. Alla se reconstruia
-- una compra que ya habia ocurrido: mandaba el precio del dia en que ocurrio.
-- Aqui se llena el COSTO DE CATALOGO, que es con lo que se decide el precio de
-- la produccion que viene. Para eso el numero util es el de REPOSICION: lo que
-- cuesta comprarlo hoy. Por eso manda la cotizacion 94507 del 2026-09-11.
--
-- CADA COSTO Y SU FUENTE
--   Solo Vidrio, cotizacion 94507 del 2026-09-11:
--     botella-50-vacia   4.87   botella-250-vacia   9.96
--     tapa50             0.44   tapa250             0.51
--     botella-750-vacia 19.80   corcho             11.68
--   ETIQUS, cotizacion 410COT del 2026-08-06, juego completo a 1,000 piezas:
--     etiqueta-50        2.63 (frente 1.33 + reverso 1.30)
--     etiqueta-250       3.57 (2.06 + 1.51)
--     etiqueta-750      13.26 (5.35 + 3.04 + 2.77 + 2.10, juego de cuatro)
--   Norman, en el chat del 2026-09-17:
--     lamina-plata       2.00
--     led                5.00   -- el mismo dijo no estar seguro. Hay un 5.50
--                               -- dictado el 09-02; gana el 5.00 porque lo dijo
--                               -- hoy, y lo de hoy manda (jerarquia, escalon 1).
--
-- UNA CONTRADICCION QUE SE RESUELVE AQUI, Y HAY QUE SABERLO
-- ---------------------------------------------------------------------------
-- botella-750-vacia tenia 15.50 en el catalogo, sin cotizacion detras: era el
-- unico costo que el ERP traia cargado y venia sin fuente. La cotizacion 94507
-- dice 19.80. Gana la cotizacion por jerarquia -es la unica de las dos con
-- documento y fecha-, y eso significa que **el costo real de la botella de 750
-- es 27.7% mas alto de lo que el sistema creia**. El margen de ese producto
-- estaba sobreestimado en 4.30 por botella.
--
-- LO QUE ESTE ARCHIVO NO ARREGLA, Y ES LO MAS CARO
--   - Bolsa-pasta y Etiqueta-pasta siguen en 0: no hay una sola cotizacion de
--     ninguna de las dos en todo el arbol. Pasta-Guajillo-2kg se queda sin costo.
--   - Ninguna receta incluye el liquido, asi que `v_costo_produccion` va a seguir
--     devolviendo margen NULL para los tres destilados aunque todo el empaque ya
--     tenga precio. Eso es correcto y es la guarda de la migracion anterior.
--
-- ROLLBACK EXACTO, con los valores viejos:
--   update public.catalogo_productos set costo_unitario = 15.50 where sku = 'botella-750-vacia';
--   update public.catalogo_productos set costo_unitario = 0.00
--    where sku in ('botella-50-vacia','tapa50','botella-250-vacia','tapa250',
--                  'corcho','etiqueta-50','etiqueta-250','etiqueta-750',
--                  'lamina-plata','led');

DO $erp26$
DECLARE
  v_tocadas integer := 0;
  v_n       integer;
  v_sin     integer;
BEGIN
  -- Cada UPDATE exige el valor viejo. Si alguien ya movio un costo, esa fila no
  -- se toca, el conteo no cuadra y la migracion entera se revierte: asi nunca
  -- se pisa en silencio un dato que otro puso.
  update public.catalogo_productos set costo_unitario =  4.87 where sku = 'botella-50-vacia'  and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  0.44 where sku = 'tapa50'            and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  9.96 where sku = 'botella-250-vacia' and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  0.51 where sku = 'tapa250'           and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario = 19.80 where sku = 'botella-750-vacia' and costo_unitario = 15.50;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario = 11.68 where sku = 'corcho'            and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  2.63 where sku = 'etiqueta-50'       and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  3.57 where sku = 'etiqueta-250'      and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario = 13.26 where sku = 'etiqueta-750'      and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  2.00 where sku = 'lamina-plata'      and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;
  update public.catalogo_productos set costo_unitario =  5.00 where sku = 'led'               and costo_unitario = 0.00;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tocadas := v_tocadas + v_n;

  IF v_tocadas <> 11 THEN
    RAISE EXCEPTION 'ERP-26: esperaba tocar 11 filas y toque %. Alguien ya habia movido un costo. Se revierte todo.', v_tocadas;
  END IF;

  -- La comprobacion que importa: despues de esto, ningun insumo que aparezca en
  -- la receta de un DESTILADO puede quedarse sin costo. Si queda uno, el archivo
  -- se quedo corto y prefiere no aplicarse.
  SELECT count(*) INTO v_sin
    FROM public.recetas_produccion r
    JOIN public.catalogo_productos pt ON pt.id = r.id_producto_terminado
    JOIN public.catalogo_productos pi ON pi.id = r.id_insumo
   WHERE pt.sku LIKE 'plata-%' AND coalesce(pi.costo_unitario, 0) = 0;
  IF v_sin <> 0 THEN
    RAISE EXCEPTION 'ERP-26: quedan % insumos sin costo en las recetas de destilado. Se revierte todo.', v_sin;
  END IF;

  RAISE NOTICE 'ERP-26: 11 costos cargados. El empaque de los tres destilados ya esta completo.';
END
$erp26$;
