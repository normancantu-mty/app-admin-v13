# ERP-59 — Clasificación de validaciones: qué sigue bloqueando y qué pasa a warning

> ⚠️ **SUPERADO EN PARTE (2026-09-05).** Norman aprobó esta clasificación con
> correcciones. Lo que cambió — el barrido de `app/api/**`, el aviso nuevo del
> gasto sin categoría y los cinco que salieron por la frontera de los dos
> ledgers — está en **`CLASIFICACION_validaciones_ERP-59_delta.md`**, que hay
> que leer junto con este. El resto de este archivo sigue vigente tal cual.

**Estado original: PROPUESTA. No se ha tocado una línea de código.** Este archivo es el paso 1 del
PROMPT 18 y existe para que Norman lo revise antes de que se construya nada.

Alcance recorrido: los 8 archivos de `app/actions/` (3,326 líneas), uno por uno, en todos sus
puntos de rechazo (`return { success: false }`, `return { ok: false }`, `throw new Error`).
**No cubierto:** `app/api/**` (route handlers), validaciones de cliente en los formularios, y
los `CHECK`/triggers de Postgres. Ver el apéndice para el único route handler que sí importa.

---

## 1. El criterio, antes de la lista

La lista de abajo no se decidió caso por caso. Sale de una sola pregunta:

> **Si dejo entrar esta fila, ¿el sistema queda MINTIENDO o queda INCOMPLETO?**
>
> Mintiendo → bloquea. Incompleto → entra con aviso.

Un sistema incompleto se arregla desde la cola. Un sistema que miente no se arregla nunca,
porque nadie sabe que hay algo que arreglar.

De ahí salen seis familias. Cuatro bloquean, dos avisan:

| | Familia | Bloquea o avisa | Por qué |
|---|---|---|---|
| **A** | Identidad y permiso | **Bloquea** | Sesión inválida, rol sin derecho, entidad fuera de tu alcance. Nunca fue un problema de captura. |
| **B** | Referencia rota | **Bloquea** | Vino un `id` y **no existe** (entidad, producto, cuenta). Es la "entidad que no existe" del prompt. |
| **C** | Aritmética imposible | **Bloquea** | Negativo, stock insuficiente, un reparto que no cuadra con su total. |
| **D** | Falla de infraestructura | **Bloquea** | El `SELECT`/`INSERT` reventó. No hay dato que salvar; no llegó. |
| **E** | Campo ausente con default honesto | **Avisa** | Falta la fecha, el método de pago, la cuenta de origen, el comprador. El hecho ocurrió; falta la etiqueta. |
| **F** | Catálogo incompleto | **Avisa** | El hecho **físico** ocurrió pero no hay precio o no hay receta para valuarlo. Se escribe el ledger físico, se omite el monetario, y el aviso lo grita. |

**La regla transversal que más decide, y la que hay que entender antes de aprobar nada:**

> ### Ausente ≠ inválido.
>
> Campo vacío, `null` o `NaN` → **entra con default + aviso** (familia E/F).
> Valor que **sí vino y está mal** — negativo, un `id` que no resuelve, una cuenta de otra
> entidad — → **sigue rechazando** (familia B/C).

Ejemplo concreto de la diferencia, en la misma línea de código
(`inventario.ts:391`, "El monto de abono debe ser un número válido (>= 0)"):
monto vacío → warning, se escribe el inventario y se omite el abono. Monto `-500` → rechaza.

---

## 2. Los que PASAN A WARNING — la lista corta, que es la que hay que revisar

Son **13**, de ~148 puntos de rechazo. El resto sigue bloqueando.
Ordenados por cuánto dato rescatan.

| # | Dónde | Qué rechaza hoy | Qué haría en su lugar | Sev. | Riesgo |
|---|---|---|---|---|---|
| **W1** | `auditoria.ts:190` | **Sobregiro físico** en un corte: contaron **más** de lo esperado | Procesa las diferencias positivas normal; **la línea del sobregiro no genera movimiento** (nunca stock negativo) y sale como aviso con el conteo capturado | REVISAR | Bajo |
| **W2** | `auditoria.ts:281` | El monto de cobranza salió en cero (falta `listas_precios` Zacatecas o `costo_unitario`) | Escribe las **salidas de inventario** (las botellas sí salieron) + ticket en $0, y avisa que falta el precio | REVISAR | **Medio** |
| **W3** | `inventario.ts:143` | El producto no tiene receta (BOM) | Escribe el `PRODUCCION` (las botellas existen); **no descuenta insumos**; avisa que el insumo quedó sin descontar | REVISAR | **Medio** |
| **W4** | `pos.ts:169` | Venta en **concesión** sin comprador identificado | Escribe el ticket con `id_comprador` null y la salida a `CONSIGNADO`; avisa que esa consignación **no tiene dueño** | REVISAR | **Alto** |
| **W5** | `compras.ts:128` | Costo total en cero o ausente | Escribe la `ENTRADA_COMPRA` (el insumo llegó); **no escribe el gasto**; avisa que falta el costo | REVISAR | Bajo |
| **W6** | `devoluciones.ts:225` | El producto no tiene precio de lista en su zona | Escribe la `ENTRADA_COMPRA` (la botella volvió); **no escribe el `ABONO_DEUDA`**; avisa que la deuda sigue viva | REVISAR | Bajo |
| **W7** | `inventario.ts:376` | Devolución física sin distribuidor seleccionado | Escribe el movimiento de inventario con origen null; omite el abono; avisa | REVISAR | Medio |
| **W8** | `inventario.ts:391` | Monto de abono ausente / `NaN` (**solo ausente**; negativo sigue bloqueando) | Escribe el inventario, omite el abono, avisa | REVISAR | Bajo |
| **W9** | `inventario.ts:174` | La receta trae insumos inválidos | Escribe el `PRODUCCION` + **las líneas de BOM que sí son válidas**; avisa cuáles se saltaron | REVISAR | Medio |
| **W10** | `abonos.ts:149`, `:163` | Fecha del pago mal formada o ilegible | `fecha_movimiento = now()`, y el aviso guarda **lo que se capturó** | INFO | Bajo |
| **W11** | `abonos.ts:154` | Fecha del pago futura | **Se ancla a hoy** (no se guarda en el futuro: una fila con fecha futura desaparece de todo filtro "hasta hoy"), y el aviso dice la fecha original | REVISAR | Bajo |
| **W12** | `abonos.ts:330` | Método de pago no válido | `metodo_pago = null`, el texto capturado va al aviso | INFO | Bajo |
| **W13** | `abonos.ts:310` / `compras.ts:119` | Falta la **cuenta de origen** (la de destino y la entidad siguen bloqueando) | Cae a la cuenta `CTA-` por defecto de la entidad y avisa | REVISAR | **Alto** |

### Las tres que quiero que mires con lupa antes de aprobar

**W4 — concesión sin comprador (`pos.ts:169`).** Es la reclasificación más agresiva de la lista.
En contra: escribe consignación que **nadie debe**, y hoy ya hay 602 botellas en consignación sin
descargar — esto podría alimentar justo esa pila. A favor: el rechazo de hoy es la razón por la que
hay **72 botellas facturadas fuera del ERP**. La botella salió del almacén; ese es el hecho. Quién
la debe es el campo que falta, y para eso es la cola. **Mi recomendación: pasa a warning**, pero es
tu llamada, no mía.

**W13 — cuenta de origen ausente.** El riesgo es el Account_Firewall (regla 1): si el default cae
en una cuenta equivocada, el dinero aparece en el KPI de la Matriz sin serlo. Solo lo recomiendo con
la condición de que el default sea la cuenta `CTA-` **de la propia entidad**, nunca una cuenta ADMIN,
nunca `Fresnillo`. Si no te convence, esta se queda bloqueando y no se pierde casi nada: la cuenta
de origen sí sale de un `<select>`. **Nota:** en `abonos.ts:310` esta condición hoy es un solo `if`
que cubre entidad + origen + destino; habría que partirla en tres, y solo se ablanda el origen.

**W2 / W3 — falta precio, falta receta.** Las dos escriben en el ledger **físico** y dejan el
**monetario** sin fila. Es intencional: un ticket en $0 es una deuda que nadie cobra, y un
`PRODUCCION` sin BOM deja el insumo leyendo **más alto de lo real** hasta que alguien lo arregle.
Las dos consecuencias son visibles y reversibles. Un corte descartado no es ninguna de las dos.

---

## 3. La lista completa, archivo por archivo

Veredicto: 🔴 sigue bloqueando · 🟡 pasa a warning. La letra es la familia de la §1.

### `app/actions/pos.ts` — 1 pasa a warning, 17 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 158 | Sesión inválida | 🔴 A | |
| 163 | Payload POS vacío / sin items | 🔴 C | Una venta sin renglones no es un dato incompleto: no es una venta. |
| **169** | **Concesión sin comprador** | **🟡 E** | **W4.** Ticket con `id_comprador` null + aviso REVISAR. |
| 177 | No se validó la sesión operativa | 🔴 A | |
| 186 | Vendedor no válido | 🔴 B | |
| 190 | No autorizado a operar con otro vendedor | 🔴 A | |
| 195 | Origen de inventario inválido | 🔴 B | |
| 198 | No autorizado a usar inventario ajeno | 🔴 A | |
| 206 | Origen de inventario no validado | 🔴 B | |
| 219 | Cuenta destino no existe | 🔴 B | |
| 224 | Cuenta destino no es del vendedor | 🔴 A | Firewall: es dinero cruzando a otra entidad. |
| 245 | Bóveda financiera no encontrada | 🔴 B | La entidad no tiene **ninguna** cuenta. No hay dónde asentar. |
| 301 | Comprador no validado | 🔴 B | Vino un `id` y no resuelve — no es "ausente". |
| 313 | **Cuenta fiscal facturando a un DST** | 🔴 C | **Firme.** Dejarlo pasar hace que el motor de impuesto inverso separe IVA/IEPS que no existen: el sistema quedaría *mintiendo* (regla 2), no incompleto. |
| 322 / 323 / 325 | Triangulación: solo ADMIN · solo a LOC · origen = padre del LOC | 🔴 A/C | |
| 373 | **Stock insuficiente** | 🔴 C | Nombrado en el prompt. Nunca stock negativo (regla 3). |
| 381 | Stock consignado insuficiente | 🔴 C | |

### `app/actions/auditoria.ts` — 3 pasan a warning, 16 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 93 / 96 | Cuenta destino no existe / no es de la auditora | 🔴 B/A | |
| 109 / 207 / 217 | Fallas de lectura | 🔴 D | |
| 114 | La entidad auditada no tiene cuentas | 🔴 B | |
| 133 | Entidad inválida para el corte | 🔴 B | |
| 138 / 141 | Sesión · SOCIO es solo lectura | 🔴 A | |
| 151 / 170 | Entidad objetivo / auditora no resuelta | 🔴 B | |
| 160 | No autorizado a cortar en esa entidad | 🔴 A | |
| **190** | **Sobregiro físico** | **🟡 F** | **W1.** Hoy tira el corte entero por una línea. Se procesan las positivas; la del sobregiro sale como aviso. |
| **195** | **No hay diferencias positivas** | **🟡 E** | El corte cierra en cero con aviso INFO. ⚠️ **Ojo:** hoy el registro del corte *es* el ticket, así que un corte en cero no tiene fila a la cual colgar el aviso — este apunta a la **entidad**, no a un movimiento. Es el único de los 13 que necesita eso. |
| 252 | Producto del conteo no está en el catálogo | 🔴 B | El conteo sale de una pantalla que lista el catálogo: si trae un producto que no existe, el payload viene malformado. |
| **281** | **Monto de cobranza en cero** | **🟡 F** | **W2.** |
| 307 / 375 / 445 / 461 | Fallas de `INSERT` (ticket, inventario, finanzas, detalles) | 🔴 D | |

### `app/actions/inventario.ts` — 4 pasan a warning, 22 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 76 / 86 / 90 | Sesión · entidad operadora · SOCIO | 🔴 A | |
| 101 / 104 | No se resuelve la entidad ADMIN | 🔴 B | |
| 112 | Sin producto terminado | 🔴 B | Sin él no se sabe **qué** se produjo. |
| 116 | Cantidad ≤ 0 | 🔴 C | |
| 126 / 130 | Producto no existe / no es TERMINADO | 🔴 B | |
| 139 | Falla al leer recetas | 🔴 D | |
| **143** | **Sin receta (BOM)** | **🟡 F** | **W3.** |
| **174** | **Receta con insumos inválidos** | **🟡 F** | **W9.** Entran las líneas válidas; el aviso nombra las saltadas. |
| 182 / 314 / 413 / 431 | Fallas de `INSERT` | 🔴 D | |
| 204 / 214 / 218 | Sesión · identidad · SOCIO (cascada) | 🔴 A | |
| 227 / 231 | `id_entidad` / `id_producto` vacíos | 🔴 B | |
| 235 | Tipo de movimiento inválido para cascada | 🔴 C | |
| 239 | Cantidad a deducir ≤ 0 | 🔴 C | |
| 250 | Falla al leer movimientos | 🔴 D | |
| 306 | No se generó ninguna deducción | 🔴 C | Defensivo: la cascada ya se detuvo antes si faltaba stock. |
| 337 / 347 / 351 | Sesión · identidad · SOCIO (logística inversa) | 🔴 A | |
| 362 / 365 / 368 | Sin producto · tipo inválido · cantidad ≤ 0 | 🔴 B/C | |
| **376** | **Devolución física sin distribuidor** | **🟡 E** | **W7.** |
| 386 | El distribuidor seleccionado no es DST | 🔴 B | Vino un `id` y está mal. Distinto del 376, donde no vino nada. |
| **391** | **Monto de abono ausente / `NaN`** | **🟡 E** | **W8. Solo el caso ausente.** Negativo se queda en 🔴 C. |

### `app/actions/abonos.ts` — 4 pasan a warning, 17 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 116 / 127 | Rol sin permiso · entidad fuera de tu alcance | 🔴 A | 127 usa `mis_entidades()`, la misma función que la política RLS. |
| 122 / 341 / 501 | Fallas de RPC / lectura / `INSERT` | 🔴 D | |
| **149 / 163** | **Fecha mal formada / ilegible** | **🟡 E** | **W10.** |
| **154** | **Fecha futura** | **🟡 E** | **W11.** Se ancla a hoy, no se guarda en el futuro. |
| 254 | Falta la entidad | 🔴 B | Un abono sin entidad es una deuda que nadie baja. |
| 310 | Faltan origen, destino **o** entidad | 🔴 B / **🟡 E** | **W13, parcial.** Hay que partir el `if`: entidad y destino siguen bloqueando; **solo el origen** se ablanda. |
| 313 | Origen = destino | 🔴 C | El dinero no se mueve, pero la fila baja deuda igual. Eso es mentir. |
| 321 | Monto ≤ 0 | 🔴 C | Nombrado en el prompt. |
| **330** | **Método de pago no válido** | **🟡 E** | **W12.** |
| 362 | Origen/destino no resuelven a cuentas reales | 🔴 B | |
| 375 | Transferencia que no es ADMIN↔DST/LOC | 🔴 C | *Candidata a que la muevas tú:* no corrompe, pero crea un par que ningún dashboard modela, así que el dinero no cae en el KPI de nadie. La dejo bloqueando por eso. |
| 385 | La cuenta del DST no es de la entidad del movimiento | 🔴 C | Abonaría la deuda de A con el efectivo de B. |
| 436 / 444 / 450 / 462 / 494 | Pedido duplicado · sin saldo · sobre-aplicado · suma que excede · reparto que no cuadra | 🔴 C | Los cinco son aritmética del reparto. Ablandar cualquiera cobra dos veces el mismo pedido. |

### `app/actions/compras.ts` — 2 pasan a warning, 10 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 70 | Sesión | 🔴 A | |
| 87 / 90 / 139 / 154 | Fallas de lectura | 🔴 D | |
| 119 | Falta insumo **o** cuenta de origen | 🔴 B / **🟡 E** | **W13, parcial.** Sin insumo se bloquea (no se sabe qué entró); **sin cuenta de origen** entra con la `CTA-` de la entidad. |
| 125 | Cantidad ≤ 0 | 🔴 C | |
| **128** | **Costo total en cero / ausente** | **🟡 F** | **W5.** Entra el inventario, no entra el gasto, el aviso lo grita. |
| 142 | El producto no existe o no es INSUMO | 🔴 B | |
| 157 | La cuenta de origen no es de tu entidad | 🔴 A | Firewall. |
| 177 / 212 / 220 | `INSERT` fallido y compensación | 🔴 D | |

### `app/actions/devoluciones.ts` — 1 pasa a warning, 12 bloquean

| Línea | Qué valida | | Por qué |
|---|---|---|---|
| 86 / 111 / 154 / 213 | Fallas de lectura | 🔴 D | |
| 89 | La entidad no existe | 🔴 B | |
| 141 / 192 | Falta la entidad o el producto | 🔴 B | |
| 197 | Cantidad ≤ 0 | 🔴 C | |
| 216 | El producto no existe o no es TERMINADO | 🔴 B | |
| **225** | **Sin precio de lista en la zona** | **🟡 F** | **W6.** |
| 250 / 286 / 294 | `INSERT` fallido y compensación fallida | 🔴 D | |

### `app/actions/audit.ts` — **0 pasan a warning. Los 22 bloquean.**

No es un camino de captura: es de **anulación**. No hay dato que rescatar, porque no entra dato —
se **deshace** uno que ya existe. Una anulación a medias no es un registro incompleto, es un
registro corrupto: no se puede "medio anular" una fila. Los candados de rol, propiedad y
`VENTANA_EDICION_HORAS` (líneas 81-128) además están **duplicados en triggers de Postgres**: la base
rechazaría de todos modos, y `tests/candados-base.spec.ts` falla si divergen.

### `app/actions/distribuidores.ts` — **0 pasan a warning. Los 25 bloquean.**

Tampoco es captura: es **CRUD estructural** de la red. Un ADMIN da de alta una entidad de forma
deliberada y rara vez; no hay un capturista apurado del otro lado, que es el problema que la cola
viene a resolver. Y una entidad a medio crear (sin nombre, sin credenciales, sin cuenta
financiera) envenena **cada ledger que la referencie después** — es la definición de mentir. Las
líneas 200-244 ya tienen su propio rollback manual de auth + entidad + cuenta.

---

## 4. Recuento

| Archivo | Bloquean | Warning |
|---|---:|---:|
| `pos.ts` | 17 | 1 |
| `auditoria.ts` | 16 | 3 |
| `inventario.ts` | 22 | 4 |
| `abonos.ts` | 17 | 4 |
| `compras.ts` | 10 | 2 |
| `devoluciones.ts` | 12 | 1 |
| `audit.ts` | 22 | 0 |
| `distribuidores.ts` | 25 | 0 |
| **Total** | **141** | **15** |

15 puntos de código para 13 avisos distintos (W13 toca dos archivos; `abonos.ts:149` y `:163` son
el mismo aviso). **Nueve de cada diez validaciones se quedan como están.** La cola no afloja el
sistema: le abre trece puertas medidas.

---

## 5. Lo que se decide junto con esto (y que quiero confirmar antes de construir)

1. **Dos ledgers, un aviso.** W2, W3, W5, W6, W7 y W8 escriben en el ledger **físico** y omiten a
   propósito la fila del **monetario**. Es la decisión de fondo de toda la cola: *los dos ledgers
   pueden divergir mientras el aviso lo diga*. Si no estás de acuerdo con eso, seis de los trece
   se caen y hay que rediseñarlos.
2. **A qué apunta un aviso.** Casi todos apuntan a una fila (`tabla` + `id`). El de
   `auditoria.ts:195` (corte en cero) no tiene fila: apunta a una **entidad**. La tabla
   `avisos_captura` tiene que admitir las dos formas desde el principio.
3. **Severidad.** Solo dos avisos son `INFO` (W10, W12: fecha y método de pago). Los otros once son
   `REVISAR`, porque los once significan **dinero o inventario sin cuadrar**. Si `REVISAR` se
   vuelve el 85% de la cola, la cola se vuelve ruido. Alternativa a considerar: bajar W7, W8 y W11 a
   `INFO`. **Yo no lo haría** — prefiero una cola corta y toda urgente a una cola larga que nadie
   abre — pero es exactamente el tipo de decisión que se paga después.
4. **Nada de esto cambia las cifras de control.** Las 13 son puertas hacia adelante: ninguna toca
   filas existentes ni reprocesa historia. `84 · 468 · 61 · $386,201.00` quedan intactas por
   construcción. Se verifican igual antes y después.

---

## Apéndice — fuera de `app/actions/`, pero es donde está el agujero del gasto

El prompt cita **$0.00 de gasto capturado desde el 1 de julio**. Ese formulario no pasa por
`app/actions/`: pasa por **`app/api/finanzas/nuevo/route.ts`** (`FinanzaForm.tsx` → `POST`).
Sus rechazos, con el mismo criterio:

| Línea | Qué valida | | |
|---|---|---|---|
| 32 | `tipo_movimiento` inválido | 🔴 C | |
| 35 | **`categoria` obligatoria** | **🟡 E** | Un egreso sin categoría es un egreso **capturado**. Hoy se pierde entero. |
| 38 | `cuenta_destino` inválida | 🔴 B | |
| 42 / 45 | Transferencia sin origen / origen = destino | 🔴 B/C | |
| 49 | Monto ≤ 0 | 🔴 C | |
| 76 / 85 / 89 | Sin sesión · identidad · SOCIO | 🔴 A | |

**Pregunta directa: ¿incluyo la línea 35 en el trabajo?** El prompt me acotó a `app/actions/`, así
que no la conté en los totales de arriba. Pero si el objetivo es que vuelva a haber gasto
capturado, es la reclasificación de mayor impacto de todo el ERP-59 y son ~6 líneas de código.

---

**Siguiente paso: tu revisión.** Marca cuáles apruebas, cuáles bajas de severidad y cuáles se
quedan bloqueando. Con eso se construye la tabla `avisos_captura`, la pantalla y el resumen para
el bot. Hasta entonces no muevo código.
