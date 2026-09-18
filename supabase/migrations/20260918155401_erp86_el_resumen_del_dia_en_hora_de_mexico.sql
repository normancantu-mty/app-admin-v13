-- Norman, 2026-09-18: "tambien quisiera un reporte diario ya en la noche de lo
-- que se hizo, de manera concisa".
--
-- El calculo vive en SQL y no en el script de Python por una razon concreta: el
-- dia. Todas las fechas del ERP son timestamptz en UTC, y a las 20:47 hora de
-- Mexico ya es el dia SIGUIENTE en UTC. Un resumen que hiciera la resta en
-- Python contra UTC reportaria el dia equivocado justo a la hora en que se
-- manda, y nadie lo notaria porque los numeros se verian plausibles.
--
-- Una sola fila, siempre. Si no hubo movimiento, los contadores van en cero y
-- es el script quien decide callarse: un reporte que llega todos los dias
-- diciendo 0 se deja de leer.
create or replace view public.v_resumen_del_dia
with (security_invoker = true) as
 with dia as (
   select (now() at time zone 'America/Mexico_City')::date as d
 ), ventas as (
   select count(*) as n, coalesce(sum(t.total_cobrado_real), 0::numeric) as monto
     from transacciones_tickets t, dia
    where t.status = 'ACTIVO'
      and (t.fecha_transaccion at time zone 'America/Mexico_City')::date = dia.d
 ), gastos as (
   select count(*) as n, coalesce(sum(abs(f.monto)), 0::numeric) as monto
     from finanzas_ledger f, dia
    where f.status in ('ACTIVO', 'APPROVED')
      and f.tipo_movimiento in ('GASTO_OPERATIVO', 'COMPRA_INSUMOS')
      and (f.fecha_movimiento at time zone 'America/Mexico_City')::date = dia.d
 ), abonos as (
   select count(*) as n, coalesce(sum(abs(f.monto)), 0::numeric) as monto
     from finanzas_ledger f, dia
    where f.status in ('ACTIVO', 'APPROVED')
      and f.tipo_movimiento = 'ABONO_DEUDA'
      and (f.fecha_movimiento at time zone 'America/Mexico_City')::date = dia.d
 ), lotes_hoy as (
   select count(*) as n
     from lotes l, dia
    where l.fecha_inicio = dia.d
 ), avisos as (
   select count(*) as n
     from avisos_captura a
    where a.estado = 'PENDIENTE'
 )
 select dia.d as fecha,
    ventas.n as ventas,
    ventas.monto as ventas_monto,
    gastos.n as gastos,
    gastos.monto as gastos_monto,
    abonos.n as abonos,
    abonos.monto as abonos_monto,
    lotes_hoy.n as lotes,
    avisos.n as avisos_pendientes,
    (ventas.n + gastos.n + abonos.n + lotes_hoy.n) as movimientos_del_dia
   from dia, ventas, gastos, abonos, lotes_hoy, avisos;

grant select on public.v_resumen_del_dia to authenticated, service_role;
