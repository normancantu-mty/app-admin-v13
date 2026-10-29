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
   Hace `db reset` y aplica las migraciones con psql: 130 aplicadas, 5 saltadas (son solo de datos).
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
   - Escenario alterno, NO vigente: `conciliacion_locales_2026-10-29_alt_martin_sin_merma.json` (misma
     carpeta). Solo cambia Martin Reyes: no se le cobra la merma de 43 botellas, y su deuda queda en 2,064.00
     en lugar de 11,327. La deuda total de la red pasa de 68,537.93 a 59,274.93. Se usa solo si Norman lo decide.
   - La carga renombra "Cuenta personal" a **"Cuenta Gilberto"**. Busca la cuenta por `clase = 'PERSONAL'` y no por
     nombre, y antes revisa que no choque con otra cuenta que ya se llame así (Norman, 2026-10-29).
4. `npx next dev --webpack -p 3002` (depende de 1)
   - **No uses el 3000**: ahí corre `app-admin`, que atiende al bot de producción.
   - El 3001 es de `app-admin-dev`.
   - `.env.local` (en gitignore) apunta a `http://127.0.0.1:55321` con las llaves demo locales.
   - **Token del bot.** El entorno de usuario de Windows ya trae un `BOT_API_TOKEN`, presumiblemente el de producción.
     Next le da prioridad a la variable del proceso sobre `.env.local`, así que el servidor local lo hereda.
     Para probar las rutas `/api/bot/*`, arranca con un token local propio:
     `BOT_API_TOKEN=<token local> npx next dev --webpack -p 3002`.
     Las pruebas lo reciben en `V2_BOT_TOKEN`.

- App: http://localhost:3002
- Studio: http://127.0.0.1:55323

## Usar la v2: modo producción, no dev

Para USAR la v2 (revisarla, capturar, enseñarla) se corre en modo producción: `npm run v2:prod`
(`next build && next start -p 3003`; depende de los pasos 1-3). `next dev` compila cada ruta la
primera vez que se abre (0.8-2.1 s por ruta); producción ya trae todo compilado. Medido el
2026-10-29: x3 más rápido al navegar y x6 en la carga completa. `next dev` queda solo para
desarrollar.

- Build con Turbopack (el default de Next 16): compila (`Compiled successfully in 11.6s`, 2026-10-29).
  Si algún día falla, el respaldo es `next build --webpack`.
- `next build` prerenderiza páginas y necesita `.env.local` en la carpeta desde donde se corre;
  sin él truena en `/login` con *"Your project's URL and API key are required"*.
- Después de cambiar código hay que volver a correr `npm run v2:prod`: producción no recarga sola.

## Usuarios de prueba (solo existen en local)

| Rol | Correo | Clave | Entidad |
|---|---|---|---|
| ADMIN | normancantu@gmail.com | v2-local-admin | CEO Admin |
| DST | dst.prueba@v2.local | v2-local-dst | DST Prueba v2 (local) |

## Qué cambia frente a producción

Hay 6 migraciones nuevas, todas `2026102[89]120*_v2_*`. No se editó ninguna migración existente.

| Migración | Qué hace |
|---|---|
| `120000_v2_compat_grants_agente` | Da a `service_role` lectura del esquema `agente`, igual que en producción. |
| `120100_v2_cuentas_clase_y_saldo_inicial` | Agrega `cuentas_financieras.clase` (EFECTIVO / PERSONAL / FISCAL / TRANSFERENCIAS) y `solo_egresos`. Agrega el tipo `SALDO_INICIAL`. El trigger `trg_cuenta_solo_egresos` impide que la cuenta de clase PERSONAL reciba ingresos. Esa cuenta se llama "Cuenta Gilberto" desde el 2026-10-29. `tg_cuenta_solo_egresos` queda sin EXECUTE para PUBLIC, anon y authenticated. Crea la función `saldo_cuenta(uuid)`. |
| `120200_v2_categorias_movimiento` | Crea la lista cerrada de categoría y subcategoría. La llena la carga de arranque: 14 categorías, 64 subcategorías. |
| `20261029120000_v2_cartera_acreedor` | `v_cartera` agrega `id_acreedor = COALESCE(id_nodo_padre, id_padre)`. Así la cartera separa la deuda con la matriz de la deuda de un local con su distribuidor (T6: 19,382 ya no se cuentan dos veces). |
| `20261029120100_v2_devolucion_fisica_cubeta` | `v_stock_por_cubeta` cuenta la `DEVOLUCION_FISICA` como PAGADO del lado de quien la recibe. El nodo que devuelve la descuenta de su CONSIGNADO. |
| `120300_v2_transferencias_conversion` | Crea `conversiones_transferencia` y la RPC `convertir_transferencias(monto)`, que hace 95 a Efectivo y 5 de gasto "Financieros / Comisión por conversión de transferencias", redondeado al centavo y en una sola transacción. Crea también la vista `v_transferencias_resumen` (recibidas, convertidas, por convertir; FIFO). El parámetro `comision_conversion_transferencias_pct` vale 5. |

Hay además 2 migraciones de compatibilidad local, que existen porque la nube no reproduce el arranque desde cero:
- `20260101000000_v2_local_esquema_base_previo`: el esquema que vivía en la nube antes de la primera migración.
- `20261015164936_v2_local_compat_pg_net_cascaron`: un cascarón de `pg_net`. Ninguna llamada sale a la red.

Cambios en el código:
- El tablero general tiene una tarjeta de liquidez "Transferencias" y la tarjeta de métrica con su botón de conversión (`components/dashboard/TransferenciasCard.tsx`, `app/actions/transferencias.ts`).
- La captura de gasto exige la categoría y la subcategoría de la lista. La ruta `/api/finanzas/nuevo` rechaza con 400 lo que no esté en la lista.
- El POS no ofrece cuentas `solo_egresos`.
- `types/database.ts` está parchado a mano, porque la CLI local genera otro formato.
- Liquidez: la cuenta se clasifica primero por `clase` y después por nombre (`lib/dashboard-utils.ts`). El tablero muestra "Liquidez Cuenta Gilberto".
- Actividad y "días sin actividad": **una sola regla** para el tablero general y el directorio (`lib/actividad.ts`, lectura en `lib/actividad-servidor.ts`).
  - Cuenta lo más reciente entre: movimientos vivos donde el nodo es parte (finanzas e inventario, destino u origen), sus tickets vivos, su seguimiento manual y el corte de arranque.
  - Los días son de calendario en hora de México.
  - Antes había dos reglas, y el mismo nodo salía "Sin contacto" en una pantalla y "Hace 1 días" en la otra (T4, ronda 2).
- La cartera y el bot (`lib/vistas.ts`, `lib/bot-consultas.ts`) suman como deuda solo la que se tiene con la matriz. La deuda de un local con su distribuidor va en una línea aparte (T6).
- Devolución física (`app/actions/devoluciones.ts`):
  - El abono se hace al precio con que nació la deuda. Toma lo más reciente entre dos fuentes:
    - el ticket de consignación activo;
    - la consignación de arranque. La carga conciliada guarda el `precio_neto` en `costo_unitario_movimiento`.
  - Sin ninguna de las dos, usa `ceil(PP × (1 − comisión propia))`, sin la comisión de red del padre.
  - Antes se abonaba el precio de lista (599 en lugar de 480). Después, para los locales de un DST, se abonaba 420 en lugar de 510.
  - La fila de inventario sale de la cubeta CONSIGNADO (T5).
- Cola de aprobaciones (`app/dashboard/finanzas/PendingApprovalsPanel.tsx`): el desglose sale de la fiscalidad de la cuenta (`tipo_fiscalidad` y `clase`) por medio de `calcularFugaFiscal` (`lib/aprobacion-abonos.ts`).
  - Antes había una clave fija: `CUENTA_PERSONAL` se trataba como IVA incluido.
  - "Cuenta Gilberto" es LIBRE, así que su abono va sin IVA.
- Formularios que guardan y redirigen: ya no llaman `router.refresh()` junto al `router.push`. Son el POS, el abono, la devolución, la compra de insumo y el alta de distribuidor.
  - El refresh de la ruta ACTUAL le podía ganar al push y dejaba al usuario en el formulario ya guardado. Así se arriesga capturar dos veces.
  - El push ya trae datos frescos: Next 15+ no guarda en caché las páginas dinámicas (`staleTimes.dynamic = 0`).

## Pruebas

Antes de los pasos, `v2_simular_ui.mjs` y `v2_simular_t5.mjs` precalientan las rutas de destino. El servidor de desarrollo compila cada ruta la primera vez que se pide. Si eso cae en medio de un `router.push`, el HMR recarga la página de origen y el paso falla aunque el dato ya se guardó. En producción no pasa, porque ahí no se compila bajo demanda.

| Comando | Qué prueba |
|---|---|
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_simular_ui.mjs <dir>` | Por la interfaz: venta en efectivo, venta por transferencia, consignación a Aeropuerto, abono, gasto con categoría y subcategoría, compra de insumo, merma y conversión. |
| `python scripts/v2_pruebas_api.py http://localhost:3002` | Conversión al centavo (333.33 da 16.67 y 316.66). Rechazos: convertir de más, DST, ingreso a la personal y categoría inventada. Además, un gasto válido por la ruta. |
| `docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_simulacion.sql` | Esperado contra obtenido, 29 filas. Supone la carga en modo **cero** más las dos simulaciones de arriba. |
| `python scripts/v2_verificar_conciliado.py <json>` | La carga conciliada contra el JSON, entidad por entidad. Se corre antes de cualquier movimiento nuevo. |
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_humo_lectura.mjs <dir>` | Humo de solo lectura: tablero, distribuidores y ficha de Aeropuerto. |
| `docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_cuentas.sql` | 11 chequeos de cuentas sobre la carga conciliada. Incluye que "Cuenta Gilberto" rechace un ingreso. |
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_prueba_arranque_ui.mjs <json>` | T4 y T6 por pantalla: sin "999 días" y sin doble conteo de la cartera. |
| `npx playwright test tests/v2-cartera-acreedor.spec.ts --project=puras` | T6, prueba pura de `totalesCarteraVista`. |
| `npx playwright test tests/v2-actividad.spec.ts --project=puras` | La regla única de actividad. Cubre días de calendario en hora de México, qué cuenta y qué no, y un control negativo. |
| `npx playwright test tests/v2-desglose-aprobacion.spec.ts --project=puras` | El desglose de la cola de aprobaciones según la fiscalidad de la cuenta: Cuenta Gilberto LIBRE, Fresnillo FULL_TAX, efectivo propio y fiscalidad desconocida. Incluye un centinela que impide volver a la clave fija. |
| `E2E_BASE_URL=http://localhost:3002 node scripts/v2_prueba_devolucion_precio.mjs <json>` | El precio de abono de una devolución contra el `precio_neto` de la conciliación. Prueba la vista previa de Al son, Nuevo Ideal y Aeropuerto, y una devolución real de Al son. |
| T5, en este orden, sobre la carga conciliada: `scripts/v2_t5_fixture.sql` → `node scripts/v2_simular_t5.mjs <dir>` → `V2_BOT_TOKEN=<token> python scripts/v2_pruebas_t5_bot.py http://localhost:3002 <json>` → `scripts/v2_verificar_t5.sql` | Por la interfaz y por las rutas del bot. Prueba: venta Fresnillo con IVA e IEPS, consignación, devolución, venta del DST, anulación por pantalla y por bot, lote y envasado con falta de empaque. El SQL da 40 OK y 1 BRECHA: COMISION_PASIVA 24.00 contra los 53.70 de REGLAS_COMERCIALES, pendiente de Norman. |

## La carga real (cuando exista la base de destino)

`cargar_arranque.py` solo sabe hablar con el contenedor local: verifica que el 55322 esté publicado y usa `docker exec`.

Contra una base nueva hay que cambiar el destino y correr el mismo comando del paso 3. **Esa decisión es de Norman, y la aprueba él** (R7). Producción no se toca nunca.
