-- ERP-10, segunda mitad: las 4 compras de insumo que nunca se capturaron.
--
-- Escrito el 2026-09-17 por el Socio Estrategico. Aplicada con apply_migration
-- del MCP, nunca con `supabase db push`.
--
-- Norman dio la palabra y los dos precios que solo el sabia, en el chat del
-- 2026-09-17: el LED a 5 pesos cada uno -diciendo el mismo que no estaba
-- seguro- y la lamina de plata a 2 pesos cada una.
--
-- ---------------------------------------------------------------------------
-- 1. DE DONDE SALE CADA NUMERO (R2: la operacion y el supuesto a la vista)
-- ---------------------------------------------------------------------------
--  CANTIDAD = consumido - capturado. Es el faltante que mide
--  `v_insumos_en_negativo`, creada en la migracion 20260918015908. No es un
--  conteo fisico: es el MINIMO que tuvo que existir para que la produccion ya
--  registrada fuera posible. Si ademas hay piezas en bodega hoy, la cantidad
--  real fue mayor, y eso solo lo dice un conteo (ERP-65).
--
--  COSTO UNITARIO, cada uno con su fuente:
--    Botella 50ml  4.53  Solo Vidrio, cotizacion 93500 del 2026-07-28
--                        (TEQUILERA MINI MEZCALERA 50 ML).
--    Tapa 50       0.42  misma cotizacion (TAPA PLASTICA 18-400 NEGRA LG).
--    Luz LED       5.00  Norman, en el chat. El mismo dijo no estar seguro:
--                        queda marcado como estimacion en las notas de la fila.
--    Lamina Plata  2.00  Norman, en el chat.
--
--  POR QUE LA COTIZACION DE JULIO Y NO LA DE SEPTIEMBRE. Existe una mas nueva
--  -Solo Vidrio 94507 del 2026-09-11- con botella 4.87 y tapa 0.44. Se uso la
--  de JULIO porque el consumo que estas compras respaldan ocurrio entre el
--  2026-05-23 y el 2026-08-24, y ese es el precio contemporaneo. La de
--  septiembre es el costo de REPOSICION de hoy, que es otra pregunta.
--
--  NO SE PRORRATEO EL FLETE, a proposito. La cotizacion de julio cobra 409 de
--  guia entre 330 piezas (1.24 por botella, un 25 por ciento encima del
--  envase) y la de septiembre 2,400.79 de tarima. Repartirlo exige saber que
--  pedido de verdad trajo estas piezas, y no se sabe. El costo queda
--  SUBESTIMADO y dicho aqui, que es mejor que un prorrateo inventado.
--
-- ---------------------------------------------------------------------------
-- 2. POR QUE LA FECHA ES 2026-05-22 Y NO HOY
-- ---------------------------------------------------------------------------
--  Es una RECONSTRUCCION, no una fecha conocida, y se elige asi porque una
--  entrada fechada hoy dejaria la curva historica de stock en negativo durante
--  junio, julio y agosto: o sea, afirmando que se embotello con botellas que
--  no existian. Fisicamente imposible. Fechandolas con la carga inicial, el
--  historico deja de mentir.
--
--  Y hay evidencia directa para al menos una: Botella 50ml Vacia tiene DOS
--  filas ENTRADA_COMPRA ANULADAS del 2026-05-22, de 800 y 880 piezas, junto a
--  la de 280 que quedo activa. La carga original fue mayor y se anulo. Para
--  Tapa 50, Lamina de Plata y Luz LED no hay filas anuladas, asi que para esas
--  tres la fecha es supuesto y no evidencia. Queda dicho.
--
-- ---------------------------------------------------------------------------
-- 3. POR QUE NO SE ESCRIBE NINGUNA FILA DE DINERO, Y ES LO IMPORTANTE
-- ---------------------------------------------------------------------------
--  ERP-79 advierte que escribir la entrada de stock sin la salida de dinero
--  regala inventario e infla el margen. Se midio antes de decidir, y aqui NO
--  aplica, por dos razones medidas:
--
--    (a) El dinero de los insumos YA ESTA REGISTRADO: `finanzas_ledger` tiene
--        unos 62,758 MXN de COMPRA_INSUMOS activos con fecha 2026-05-22.
--        Escribir otra salida seria DUPLICAR un gasto ya contado. El riesgo
--        real aqui es el contrario del que advierte ERP-79.
--    (b) El inventario de INSUMO no se valora en pesos en ninguna pantalla:
--        `calcularKPIs` calcula `valorComercialInventario` solo para TERMINADO
--        (app/dashboard/inventario/page.tsx). Estas 4 filas no pueden inflar
--        ningun margen porque no entran a ningun peso.
--
--  Ademas `costo_unitario_movimiento` no lo lee ni una linea del codigo: cero
--  usos en app/, lib/, components/ y tests/. Escribir el costo real ahi es
--  inerte hoy -no mueve ninguna cifra- y deja el dato guardado para cuando se
--  trabaje ERP-26 (15 de 17 SKU sin costo en el catalogo).
--
-- ES ADITIVA: solo INSERT. No actualiza ni borra ninguna fila existente.
--
-- ROLLBACK:
--   DELETE FROM public.inventario_ledger
--    WHERE usuario_creador = 'socio-erp10-backfill';
--   (las 4 filas se marcan con ese usuario justamente para que se puedan
--    quitar sin tocar nada mas)

DO $erp10$
DECLARE
  v_admin      uuid := 'e0000000-0000-0000-0000-000000000001';
  v_insertadas integer;
  v_negativos  integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.entidades WHERE id = v_admin AND rol = 'ADMIN') THEN
    RAISE EXCEPTION 'ERP-10: la entidad ADMIN esperada no existe. No se escribe nada.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.inventario_ledger
              WHERE usuario_creador = 'socio-erp10-backfill') THEN
    RAISE EXCEPTION 'ERP-10: este backfill ya corrio antes. No se duplica.';
  END IF;

  INSERT INTO public.inventario_ledger
    (id_producto, id_entidad_destino, tipo_movimiento, cantidad,
     costo_unitario_movimiento, fecha_movimiento, usuario_creador, cubeta, status, notas)
  VALUES
    ('c2000000-0000-0000-0000-000000000003', v_admin, 'ENTRADA_COMPRA', 447,
     4.53, '2026-05-22 12:00:00-06', 'socio-erp10-backfill', 'PAGADO', 'ACTIVO',
     'ERP-10 backfill 2026-09-17. Cantidad DERIVADA (consumido 727 menos capturado 280), no contada. Costo: Solo Vidrio cotizacion 93500 del 2026-07-28, sin flete. Fecha reconstruida; hay dos filas ANULADAS de 800 y 880 del 2026-05-22 que respaldan que la carga original fue mayor.'),
    ('c2000000-0000-0000-0000-000000000009', v_admin, 'ENTRADA_COMPRA', 447,
     0.42, '2026-05-22 12:00:00-06', 'socio-erp10-backfill', 'PAGADO', 'ACTIVO',
     'ERP-10 backfill 2026-09-17. Cantidad DERIVADA (consumido 727 menos capturado 280), no contada. Costo: Solo Vidrio cotizacion 93500 del 2026-07-28, sin flete. Fecha reconstruida, sin fila anulada que la respalde.'),
    ('c2000000-0000-0000-0000-000000000010', v_admin, 'ENTRADA_COMPRA', 413.737,
     2.00, '2026-05-22 12:00:00-06', 'socio-erp10-backfill', 'PAGADO', 'ACTIVO',
     'ERP-10 backfill 2026-09-17. Cantidad DERIVADA (consumido 643.737 menos capturado 230), no contada. Costo dicho por Norman en el chat el 2026-09-17. Fecha reconstruida, sin fila anulada que la respalde.'),
    ('c2000000-0000-0000-0000-000000000011', v_admin, 'ENTRADA_COMPRA', 220,
     5.00, '2026-05-22 12:00:00-06', 'socio-erp10-backfill', 'PAGADO', 'ACTIVO',
     'ERP-10 backfill 2026-09-17. Cantidad DERIVADA (consumido 450 menos capturado 230), no contada. Costo dicho por Norman en el chat el 2026-09-17, ESTIMADO: el mismo dijo no estar seguro del precio del LED. Fecha reconstruida.');

  GET DIAGNOSTICS v_insertadas = ROW_COUNT;
  IF v_insertadas <> 4 THEN
    RAISE EXCEPTION 'ERP-10: esperaba escribir 4 filas y escribi %. Se revierte todo.', v_insertadas;
  END IF;

  -- LA GUARDA QUE HACE QUE ESTO SE COMPRUEBE SOLO. El instrumento que midio el
  -- problema es el que valida el arreglo: si despues de escribir queda un solo
  -- insumo en negativo, alguna cantidad esta mal y la migracion entera se cae
  -- sin dejar rastro. Un backfill que corrige a medias es peor que uno que no
  -- corre: deja el numero equivocado con cara de revisado.
  SELECT count(*) INTO v_negativos FROM public.v_insumos_en_negativo;
  IF v_negativos <> 0 THEN
    RAISE EXCEPTION 'ERP-10: despues del backfill quedan % insumos en negativo. Se revierte todo.', v_negativos;
  END IF;

  RAISE NOTICE 'ERP-10: 4 entradas reconstruidas. v_insumos_en_negativo quedo en cero.';
END
$erp10$;
