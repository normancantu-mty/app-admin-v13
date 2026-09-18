-- ERP-10 - El insumo en negativo se VE, y no se bloquea la produccion.
--
-- Escrito el 2026-09-17 por el Socio Estrategico. Aplicado con apply_migration
-- del MCP, nunca con `supabase db push`.
--
-- ---------------------------------------------------------------------------
-- 1. LO QUE SE MIDIO, Y CORRIGE DOS COSAS QUE YO MISMO HABIA ESCRITO MAL
-- ---------------------------------------------------------------------------
-- El diagnostico que traia este ticket decia que el `HAVING sum > 0` de
-- `v_stock_por_cubeta` escondia los insumos en negativo de la pantalla.
-- **Las dos mitades de esa frase son falsas, medidas hoy contra produccion:**
--
--   (a) `v_stock_por_cubeta` filtra `p.tipo = 'TERMINADO'`. Un INSUMO no entra
--       a esa vista NUNCA, tenga el signo que tenga. El `HAVING` no es lo que
--       los esconde; el filtro de tipo los excluye un paso antes.
--   (b) La pantalla que muestra insumos -`app/dashboard/inventario/page.tsx`-
--       NO LEE esa vista. Calcula el stock en TypeScript sobre el ledger crudo
--       (`calcularStockActual`, linea 224) y no filtra por signo. Los cuatro
--       negativos YA SE VEN ahi, en rojo.
--
-- O sea que el defecto no era de visibilidad en la pantalla. Era que **nada
-- vigila la condicion cuando nadie esta mirando la pantalla.**
--
-- ---------------------------------------------------------------------------
-- 2. Q-03 QUEDA CONTESTADA POR MEDICION, NO POR OPINION
-- ---------------------------------------------------------------------------
-- La pregunta abierta del backlog era: los insumos en negativo, son compras no
-- capturadas o produccion capturada de mas? Medido contra produccion:
--
--   * Cada insumo tiene EXACTAMENTE UNA fila ENTRADA_COMPRA, todas del
--     2026-05-22 (la carga inicial). No hay una segunda compra en el ledger.
--   * El consumo (TRASPASO) corre del 2026-05-23 al 2026-08-24.
--   * El consumo cuadra EXACTO con la produccion de producto terminado:
--       Botella 50ml, Tapa 50 y Etiqueta 50 se consumieron 727 cada una, y
--       PRODUCCION de Destilado Plata 50ml = 727.
--       Botella 250ml, Tapa 250 y Etiqueta 250: 436 cada una, y
--       PRODUCCION de Destilado Plata 250ml = 436.
--       Botella 750ml, Corcho, Etiqueta 750, Luz LED: 450 cada uno, y
--       PRODUCCION de Destilado Plata 750ml = 450.
--
-- Tres insumos distintos consumidos en cantidades IDENTICAS, y esa cantidad es
-- la del terminado que salio: el consumo es real y esta bien capturado. Lo que
-- falta es del otro lado. **Son compras de insumo no capturadas.**
--
-- ---------------------------------------------------------------------------
-- 3. POR QUE ESTO NO BLOQUEA, Y ES LA DECISION DE DISENO
-- ---------------------------------------------------------------------------
-- El titulo del ticket pide "validar stock de insumos antes de producir". Un
-- CHECK o un trigger que RECHACE el movimiento que deja el insumo en negativo
-- seria el arreglo obvio, y **estaria mal**:
--
--   Esas 727 botellas de 50ml existieron fisicamente y se embotellaron; el
--   producto salio y se vendio. Un bloqueo habria rechazado la captura de una
--   produccion que de verdad ocurrio. Un sistema que se niega a registrar la
--   realidad no produce datos correctos: produce datos ausentes, que es peor,
--   porque el hueco no se ve.
--
-- Norman ya habia llegado a esta conclusion y esta escrita en su propio
-- backlog, en ERP-79: "si en planta reciben insumo y no saben el costo, no van
-- a capturar, y eso es la causa raiz de ERP-10... Posible salida: escribir los
-- dos ledgers con el monto marcado como desconocido + aviso REVISAR, en vez de
-- bloquear." Esta migracion hace la mitad barata de eso: el AVISO.
--
-- Lo que NO hace, dicho en voz alta: no captura las compras que faltan. Eso
-- mueve costos reales y COGS, y es decision de Norman, no mia.
--
-- ---------------------------------------------------------------------------
-- 4. POR QUE UNA VISTA Y NO UN CALCULO EN PYTHON
-- ---------------------------------------------------------------------------
-- El replay del stock ya existe DOS veces -en SQL (`v_stock_por_cubeta`) y en
-- TypeScript (`getStockPorCubetaPorEntidad`)-, y `tests/vistas-equivalencia`
-- existe justamente para que no se separen. Calcular el stock una TERCERA vez
-- en el script de mantenimiento seria abrir una tercera fuente de verdad que
-- nadie mantiene en sinc. La regla de delta vive en SQL; el script solo
-- pregunta si hay filas.
--
-- ES ADITIVA: crea una vista nueva. No toca ninguna tabla, ninguna vista
-- existente, ninguna politica, ningun dato. Se deshace con un DROP VIEW.

-- ---------------------------------------------------------------------------
-- 5. EL CAMBIO
-- ---------------------------------------------------------------------------
-- La regla de delta es la MISMA de `v_stock_por_cubeta`, a proposito: las dos
-- listas de tipos se copian tal cual para que un insumo y un terminado nunca
-- se sumen con criterios distintos. Lo unico que cambia es que aqui no hay
-- cubeta (PAGADO/CONSIGNADO es un concepto de venta, no aplica a un insumo) y
-- que el filtro de tipo es el contrario.

create or replace view public.v_insumos_en_negativo
with (security_invoker = true) as
with movimientos as (
  select
    e.id     as id_entidad,
    e.nombre as entidad,
    il.id_producto,
    case
      when il.id_entidad_destino = e.id
       and il.tipo_movimiento::text = any (array[
             'ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA',
             'INGRESO_TRASPASO','ENTRADA_CONCESION'])
      then il.cantidad
      else 0::numeric
    end as entrada,
    case
      when il.id_entidad_origen = e.id
       and il.tipo_movimiento::text = any (array[
             'SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO',
             'SALIDA_CONCESION','DEVOLUCION_FISICA'])
      then il.cantidad
      else 0::numeric
    end as salida
  from inventario_ledger il
    join entidades e
      on e.id = il.id_entidad_destino or e.id = il.id_entidad_origen
  where il.status = any (array['ACTIVO','APPROVED'])
)
select
  m.id_entidad,
  m.entidad,
  m.id_producto,
  p.sku,
  p.nombre        as insumo,
  p.unidad_medida,
  round(sum(m.entrada), 4)                     as capturado_entradas,
  round(sum(m.salida), 4)                      as consumido,
  round(sum(m.entrada) - sum(m.salida), 4)     as stock,
  round(sum(m.salida) - sum(m.entrada), 4)     as faltante
from movimientos m
  join catalogo_productos p on p.id = m.id_producto
where p.tipo = 'INSUMO'
group by m.id_entidad, m.entidad, m.id_producto, p.sku, p.nombre, p.unidad_medida
having round(sum(m.entrada) - sum(m.salida), 4) < 0;

comment on view public.v_insumos_en_negativo is
  'ERP-10. Insumos cuyo consumo capturado supera a sus entradas capturadas. '
  'Cero filas es el estado sano. Una fila NO dice que la produccion este mal: '
  'dice que falta capturar una compra, y `faltante` es cuanto. Medido el '
  '2026-09-17: 4 filas, todas por compras del 2026-05-22 que nunca tuvieron '
  'una segunda captura. No bloquea nada: solo se ve. El porque de no bloquear '
  'esta en la cabecera de la migracion que la creo y en ERP-79.';

-- Mismo reparto que las otras 7 vistas de `public`, verificado en pg_class
-- antes de escribir esto: `authenticated` y `service_role` si, `anon` no.
-- Con `security_invoker = true` la RLS del ledger se aplica al leerla, asi que
-- la vista no es un camino para saltarsela.
revoke all on public.v_insumos_en_negativo from public, anon;
grant select on public.v_insumos_en_negativo to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. ROLLBACK
-- ---------------------------------------------------------------------------
--   drop view if exists public.v_insumos_en_negativo;
