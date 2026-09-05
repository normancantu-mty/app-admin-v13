# ERP-59 — Delta de la clasificación (prompt 18-bis)

**Esto NO repite la lista.** Es solo lo que cambió respecto de
`CLASIFICACION_validaciones_ERP-59.md` después de las cuatro decisiones del
prompt 18-bis. Para el resto, ese archivo sigue vigente tal cual.

**Estado: APLICADO.** Los once puntos que quedan ya están construidos en código;
la migración está escrita y **sin aplicar** (ver el pie de este archivo).

---

## 1. El alcance que faltaba: `app/api/**/route.ts`

El prompt 18 me acotó a `app/actions/`. Mal acotado, y el agujero más caro
estaba fuera. Barrí los dos route handlers que existen:

| Archivo | Puntos de rechazo | Bloquean | Warning |
|---|---:|---:|---:|
| `app/api/finanzas/nuevo/route.ts` | 14 | 13 | **1** |
| `app/api/finanzas/aprobaciones/route.ts` | 12 | 12 | 0 |

`aprobaciones/route.ts` no aporta nada: **no es un camino de captura, es de
aprobación**. Sus 12 rechazos son rol, payload malformado, movimiento no
encontrado y fallas de `INSERT`/`UPDATE`. No hay dato que rescatar — el dato ya
existe y lo único que pasa es que alguien lo aprueba o lo rechaza.

**No hay más route handlers.** `find app/api -name route.ts` devuelve exactamente
esos dos (verificado 2026-09-05).

### ENTRA — W14 · `app/api/finanzas/nuevo/route.ts:35`

| | |
|---|---|
| **Qué rechazaba** | `categoria` obligatoria para todo lo que no fuera transferencia |
| **Qué hace ahora** | El egreso entra completo, con `categoria = 'SIN_CATEGORIZAR'` |
| **Severidad** | `REVISAR` |
| **Por qué** | Es la causa mecánica de los **$0.00 de gasto capturado desde el 1 de julio** — reverificado hoy contra producción: `SELECT count(*) FROM finanzas_ledger WHERE tipo_movimiento='GASTO_OPERATIVO' AND fecha_movimiento >= '2026-07-01'` → **0** |

`SIN_CATEGORIZAR` explícito y **nunca `NULL`**, como pediste: un valor que grita
se revisa, un `NULL` se pierde entre los legítimos. (Confirmado que hace falta:
hoy `finanzas_ledger.categoria` ya tiene filas en `NULL` y nadie sabe cuáles son.)

Costó 6 líneas de lógica, como estimaste. No hubo que parar.

---

## 2. Lo que SALE por la frontera de los dos ledgers (§3)

Tu regla: *el par inventario+finanzas de un movimiento que genera dinero no es
candidato a warning*. **Mi lista de 15 sí tenía cinco de esos. Los saco, y los
digo.**

| # | Dónde | Por qué sale |
|---|---|---|
| **W2** | `auditoria.ts:281` | Es una **liquidación**. Escribir las salidas de inventario y dejar el ticket sin cobrar es exactamente "el inventario baja y la deuda nunca nace". Está en tu lista corta por nombre. |
| **W5** | `compras.ts:128` | Una compra escribe `ENTRADA_COMPRA` **y** `COMPRA_INSUMOS`: genera dinero por diseño. Sin monto no se puede escribir el lado monetario, así que el par no se puede completar. ⚠️ **La compra no está en ninguna de tus dos listas de ejemplo** — la clasifiqué como generadora de dinero por lo que escribe el código. Si la lees al revés, dímelo y vuelve. |
| **W6** | `devoluciones.ts:225` | `ENTRADA_COMPRA` + `ABONO_DEUDA`. Sin precio no nace el abono: el DST sigue debiendo una botella que ya devolvió. Es el mismo asiento falso, con el signo cambiado. |
| **W7** | `inventario.ts:376` | Devolución física sin distribuidor. Doble motivo: parte el par, **y** tu decisión de W4 (§1) prohíbe la entidad en `NULL`, que era justo lo que proponía. |
| **W8** | `inventario.ts:391` | Mismo par que W7. Un abono en `$0` "por default" no grita — se ve idéntico a una devolución legítimamente gratuita. |

**Hallazgo colateral que hay que anotar, aunque no sea de este prompt:** las
líneas de W7 y W8 viven en un camino que **hoy no puede escribir nada**.
`registrarLogisticaInversaAction` inserta `tipo_movimiento = 'DEVOLUCION_FISICA'`,
y ese valor **no está en el `CHECK` de `inventario_ledger`** (los permitidos son
`ENTRADA_COMPRA, SALIDA_VENTA, PRODUCCION, MERMA, TRASPASO, ANULADO,
ENTRADA_CONCESION, SALIDA_CONCESION, LIQUIDACION_INTERNA`). Comprobado:
**0 filas** con ese tipo en toda la tabla. La devolución física nunca ha
funcionado. No lo toqué — no es ERP-59 y merece su propio ticket.

---

## 3. Los que se quedan, y por qué cada uno respeta la frontera

Nueve avisos, once puntos de código. Ninguno parte un par físico+monetario:

| # | Dónde | Cómo respeta la frontera |
|---|---|---|
| **W1** | `auditoria.ts:190` | Las líneas que **sí** se cobran escriben sus dos ledgers completos. La sobregirada no escribe **ninguno**. No hay par partido. |
| **W1b** | `auditoria.ts:195` | Cero filas. Es el único sin puntero a un registro: apunta a la entidad. |
| **W3** | `inventario.ts:143` | `PRODUCCION` no genera ni una fila de finanzas. El par que queda cojo es **inventario contra inventario** (el BOM), que es de los que "pueden ir solos". |
| **W4** | `pos.ts:169` | ✅ Aprobado. **Una `CONCESION` no escribe ninguna fila de finanzas** — el bloque financiero entero de `pos.ts` está dentro de `if (condicion_pago === 'CONTADO')`. Y con la entidad centinela el par de inventario se escribe **completo**, cosa que con `NULL` no pasaba. Tu decisión mejoró el diseño, no solo lo endureció. |
| **W9** | `inventario.ts:174` | Igual que W3. |
| **W10** | `abonos.ts:149`,`:163` | El abono entra **completo**, con todas sus filas y su monto. Solo cambia de qué día cuelga. |
| **W11** | `abonos.ts:154` | Igual. Se ancla a hoy. |
| **W12** | `abonos.ts:330` | Igual. El método de pago es una etiqueta; no mueve un peso. |
| **W13** | `abonos.ts:310` + `compras.ts:119` | ✅ Aprobado con tu condición. El movimiento entra **entero**; solo cambia de qué cuenta sale. |

### Recuento

| | Prompt 18 | Ahora |
|---|---:|---:|
| Puntos de rechazo recorridos | ~156 | **182** (+26 de los routes) |
| Bloquean | 141 | **171** |
| Pasan a warning | 15 | **11** |
| Avisos distintos | 13 | **9** … más W1b, que en el documento original quedó sin número: **10** |

---

## 4. Las dos condiciones, cumplidas

**§1 · W4 — entidad explícita, nunca `NULL`.** Entidad real
`11111111-1111-1111-1111-111111111111` · "PENDIENTE DE ASIGNAR" · rol `LOC`
(el comprador de una venta es un local, y con rol `DST` el candado de la cuenta
fiscal la habría rechazado). **El aviso no se puede cerrar sin asignar**, y el
candado no está en la app: está en el trigger `tg_avisos_vigilar_cierre`, que
bloquea tanto `RESUELTO` como `IGNORADO` mientras el ticket siga apuntando al
centinela. En la app no hay ningún botón que lo dé por bueno.

**§2 · W13 — jamás ADMIN, jamás la fiscal.** Tres vetos en
`resolverCuentaOrigenPorDefecto` (`lib/avisos.ts`): rol `ADMIN`, `FULL_TAX`, y
nombre que contenga `"fresnillo"` — el tercero es redundante hoy y está a
propósito, porque `pos.ts` decide la fiscalidad por coincidencia textual y no por
la columna; mientras esa regla sea textual, el veto también tiene que serlo.
**Si ninguna cuenta sobrevive, no hay default y se rechaza** — incluido el caso
de que quien captura sea el propio ADMIN.

---

## 5. Lo que falta para que esto corra

La migración **está escrita y NO aplicada**:
`supabase/migrations/20260905120000_cola_de_avisos_de_captura.sql`.
No corrí `supabase db push` (ERP-73) ni DDL por MCP. El SQL exacto para pegar y
las comprobaciones de después están al pie del informe de la sesión.

Hasta que se aplique, la cola no puede recibir avisos: los `INSERT` a
`avisos_captura` fallarán y `registrarAviso` los dejará en `console.error` **sin
tumbar la escritura que los generó** — que es como tiene que ser, pero significa
que los avisos de esos días se pierden. Aplicarla es el siguiente paso.
