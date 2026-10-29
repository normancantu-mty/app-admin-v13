# ERP v2 — arranque en limpio, solo LOCAL

Escrito el 2026-10-29 por el Socio (ejecutor), rama `v2-arranque-limpio` (worktree
`C:/Users/norma/Documents/Cursor/app-admin-v2`, base `master` 6bde8ed).

**Nada de esto toca producción.** Supabase corre en Docker en esta máquina. Producción
(`gnnqxtsdrbvmlkhfemjw`) solo se leyó con SELECT, para copiar 9 tablas de catálogo y el libro
de consignación. No hay `supabase link`, ni `db push`, ni `--db-url` en ningún script.

## Arrancar

Desde `C:/Users/norma/Documents/Cursor/app-admin-v2`, en este orden:

1. `npx supabase start`
   Levanta Docker. Puertos: API 55321, DB 55322, Studio 55323, Mailpit 55324.
   Las migraciones y el seed de la CLI están apagados en `config.toml`.
2. `python scripts/v2_local_reset.py` (depende de 1)
   Hace `db reset` y aplica las migraciones con psql: 128 aplicadas, 5 saltadas (son solo de datos).
   Después corre los seeds:
   - `00` apaga el cron.
   - `50` trae los datos de producción. Lo genera `extraer_datos.py` del respaldo 2026-10-26 y está en gitignore.
   - `60` crea los usuarios de prueba.
3. La carga de arranque (depende de 2). La decisión vigente es **conciliado**:
   ```
   python scripts/cargar_arranque.py --captura scripts/arranque_datos/captura_norman.json --consig conciliado --conciliacion C:/Users/norma/Documents/Claude/Socio/_checkpoints/conciliacion_locales_2026-10-29.json
   python scripts/v2_verificar_conciliado.py C:/Users/norma/Documents/Claude/Socio/_checkpoints/conciliacion_locales_2026-10-29.json
   ```
   - El primer comando escribe; el segundo verifica.
   - Agrega `--seco` para ver el reporte sin escribir (hace ROLLBACK).
   - Otros modos de `--consig`: `cero` (es el default, nadie arranca con deuda), `libro` y `capturo`.
4. `npx next dev --webpack -p 3002` (depende de 1)
   - **No uses el 3000**: ahí corre `app-admin`, que atiende al bot de producción.
   - El 3001 es de `app-admin-dev`.
   - `.env.local` (en gitignore) apunta a `http://127.0.0.1:55321` con las llaves demo locales.

- App: http://localhost:3002
- Studio: http://127.0.0.1:55323

## Usuarios de prueba (solo existen en local)

| Rol | Correo | Clave | Entidad |
|---|---|---|---|
| ADMIN | normancantu@gmail.com | v2-local-admin | CEO Admin |
| DST | dst.prueba@v2.local | v2-local-dst | DST Prueba v2 (local) |

## Qué cambia frente a producción

Hay 4 migraciones nuevas, todas `20261028120*_v2_*`. No se editó ninguna migración existente.

| Migración | Qué hace |
|---|---|
| `120000_v2_compat_grants_agente` | Da a `service_role` lectura del esquema `agente`, igual que en producción. |
| `120100_v2_cuentas_clase_y_saldo_inicial` | Agrega `cuentas_financieras.clase` (EFECTIVO / PERSONAL / FISCAL / TRANSFERENCIAS) y `solo_egresos`. Agrega el tipo `SALDO_INICIAL`. El trigger `trg_cuenta_solo_egresos` impide que la Cuenta personal reciba ingresos. Crea la función `saldo_cuenta(uuid)`. |
| `120200_v2_categorias_movimiento` | Crea la lista cerrada de categoría y subcategoría. La llena la carga de arranque: 14 categorías, 64 subcategorías. |
| `120300_v2_transferencias_conversion` | Crea `conversiones_transferencia` y la RPC `convertir_transferencias(monto)`, que hace 95 a Efectivo y 5 de gasto "Financieros / Comisión por conversión de transferencias", redondeado al centavo y en una sola transacción. Crea también la vista `v_transferencias_resumen` (recibidas, convertidas, por convertir; FIFO). El parámetro `comision_conversion_transferencias_pct` vale 5. |

Hay además 2 migraciones de compatibilidad local, que existen porque la nube no reproduce el arranque desde cero:
- `20260101000000_v2_local_esquema_base_previo`: el esquema que vivía en la nube antes de la primera migración.
- `20261015164936_v2_local_compat_pg_net_cascaron`: un cascarón de `pg_net`. Ninguna llamada sale a la red.

Cambios en el código:
- El tablero general tiene una tarjeta de liquidez "Transferencias" y la tarjeta de métrica con su botón de conversión (`components/dashboard/TransferenciasCard.tsx`, `app/actions/transferencias.ts`).
- La captura de gasto exige la categoría y la subcategoría de la lista. La ruta `/api/finanzas/nuevo` rechaza con 400 lo que no esté en la lista.
- El POS no ofrece cuentas `solo_egresos`.
- `types/database.ts` está parchado a mano, porque la CLI local genera otro formato.

## Pruebas

| Comando | Qué prueba |
|---|---|
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_simular_ui.mjs <dir>` | Por la interfaz: venta en efectivo, venta por transferencia, consignación a Aeropuerto, abono, gasto con categoría y subcategoría, compra de insumo, merma y conversión. |
| `python scripts/v2_pruebas_api.py http://localhost:3002` | Conversión al centavo (333.33 da 16.67 y 316.66). Rechazos: convertir de más, DST, ingreso a la personal y categoría inventada. Además, un gasto válido por la ruta. |
| `docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_simulacion.sql` | Esperado contra obtenido, 29 filas. Supone la carga en modo **cero** más las dos simulaciones de arriba. |
| `python scripts/v2_verificar_conciliado.py <json>` | La carga conciliada contra el JSON, entidad por entidad. Se corre antes de cualquier movimiento nuevo. |
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_humo_lectura.mjs <dir>` | Humo de solo lectura: tablero, distribuidores y ficha de Aeropuerto. |

## La carga real (cuando exista la base de destino)

`cargar_arranque.py` solo sabe hablar con el contenedor local: verifica que el 55322 esté publicado y usa `docker exec`.

Contra una base nueva hay que cambiar el destino y correr el mismo comando del paso 3. **Esa decisión es de Norman, y la aprueba él** (R7). Producción no se toca nunca.
