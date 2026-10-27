# INFORME DE BRECHA — `REGLAS_COMERCIALES.md` contra el codigo vivo

**Fecha:** 2026-09-02 · **Rama:** `feat/reglas-comerciales` · **Nada de esto se aplico.**

Esta sesion **no cambio ningun comportamiento**. Los unicos archivos nuevos son
`lib/reglas-comerciales.ts` (funciones puras, que nadie importa todavia), su prueba, y este
informe. La base de datos se leyo, nunca se escribio.

Cifras de control al cerrar: **84 filas contables activas · 468 · 61 · $386,201**. `npm test`
46 pasadas (las 8 anteriores intactas) · `tsc --noEmit` limpio · `npm run build` verde.

---

## 0. Correcciones a los datos del encargo

Tres numeros del prompt no coinciden con lo que devuelve Supabase. Los datos mandan:

| Dato del prompt | Lo que hay realmente | Como se verifico |
|---|---|---|
| "21 lineas" de David Flores | **20 lineas** de `ticket_detalles` en 9 tickets | `count` sobre `ticket_detalles` de los 9 `id_ticket` |
| "Siete entraron por Efectivo y dos por Cuenta Fresnillo" | ✔ correcto: **7 tickets / 16 lineas** en efectivo, **2 tickets / 4 lineas** fiscales | `id_cuenta_destino = 7e6fc483…` |
| El segundo ticket fiscal, "otro tanto que tu calcules" | **$3,396** (hoy $3,072, **−$324**) | 12×250 ml @ $159 + 24×50 ml @ $62 |

Lo demas del encargo se confirmo tal cual: las 20 lineas estan cobradas **sin una sola excepcion**
a `ceil(PP × 0.80)` — 750→480, 250→144, 50→56 — y el golden test las reproduce exactamente.

---

## 1. Tabla de brecha — cada lugar donde hoy se calcula precio, comision o deuda

Once sitios. Los ordeno por dinero en juego, no por archivo.

| # | Archivo:linea | Que hace HOY | Que dice la regla | Brecha en pesos, sobre los datos de hoy |
|---|---|---|---|---|
| **1** | `app/pos/page.tsx:389-403` | Llama `calculateWaterfall` **sin** el argumento `simulacionFiscal` → la fiscalidad cae siempre a `'LIBRE'` → precio = `ceil(PP × (1−comision))` = **$480**, sin importar la cuenta destino | En Cuenta Fresnillo el precio es `PP − %×Base` = **$532** | **Este es el origen de todo.** −$52 por 750 ml, −$15 por 250 ml, −$7 por 50 ml. Sobre los 2 tickets fiscales: **−$1,128** de precio |
| **2** | `app/actions/pos.ts:263-267` | `montoBaseIngreso = calculateReverseTaxes(totalCobradoReal).montoBase` — divide entre 1.7748 un precio **que ya venia descontado 20%** | La deuda es `PP − comision`; no se vuelve a dividir | **Segundo descuento encadenado.** David: deuda registrada $4,219.07 + $1,730.90 en vez de $8,292 + $3,396 |
| **3** | `lib/distribuidores-saldos.ts:40-48` | Deuda del DST = `monto_base_ingreso`; del LOC = `total_cobrado_real` | La deuda es el precio cobrado en ambos casos | Consume la brecha #2. **David: +$5,738.03** en su saldo |
| **4** | `app/actions/pos.ts:543-545` (split CONTADO) | El vendedor DST cobra `comision_base` (20%) **aunque el comprador sea un LOC**; y el % se aplica al total **ya descontado**, no a la Base | Si vende su local: `comision_hijo_local` (15%) × Base | 🆕 **No estaba en la lista.** Ticket `bbbbc594` (Gilberto → Nuevo Ideal): Matriz **+$39.40**, Gilberto **−$58.60** |
| **5** | `app/actions/pos.ts:78-95`, llamado en **:507** (bloque 2, triangulacion) | Paga `comision_base` (20%) al DST dueño del inventario | `comision_hijo_local` (15%) | ✔ **Sospecha confirmada.** $0 hoy: **0 filas activas** por esta ruta |
| **6** | `app/actions/auditoria.ts:394-409` (**Cobranza**) | Comision del DST = `totalCobranza − ceil(totalCobranza × (1−comision_base_local))`. Dos problemas: aplica el 15% sobre un precio **ya descontado 15%**, y lee el campo del **LOC**, no `comision_hijo_local` del DST | 15% × Base, sobre PP | Por botella de 750 ml: Matriz **+$14.70**, DST **−$13.85**. **$0 hoy: 0 cobranzas ejecutadas** |
| **7** | `app/actions/auditoria.ts:255-268` (**Cobranza**) | `precioUnitario = ceil(PP × (1 − comision_base_local))`. **Nunca divide entre 1.7748**, ni cuando la cuenta destino es la fiscal | En cuenta fiscal el % va sobre la Base | $0 hoy (toda cobranza va a cuenta `LIBRE`). **Brecha latente identica a la #1** |
| **8** | `lib/pricing-waterfall.ts:20-24, 56-62` | `costo = ceil(Base × (1−comision))`. Con `LIBRE` da $480 ✔. Con `FULL_TAX` da `ceil(337.50 × 0.80)` = **$270** | **$532** | **Un tercer numero para el mismo hecho.** −$262/botella en el Catalogo con simulacion fiscal. Solo pantalla, no escribe ledger |
| **9** | `app/actions/auditoria.ts:396` | `Number(entidadObjetivo.comision_base_local ?? 15)` — un **15 escrito a mano** como respaldo | La tasa sale de `entidades` | $0 hoy (ninguna entidad tiene el campo nulo). **Es una bomba de tiempo**: si algun dia llega null, `normalizePercentage(15, 15)` devuelve `0.15` y nadie se entera |
| **10** | `app/api/finanzas/aprobaciones/route.ts:40` | `const base = monto / 1.7748` a mano | — | Sin brecha de pesos. Duplica `FACTOR_RECONSTRUCCION` de `lib/finance-utils.ts`: si cambia el IEPS, este no se entera |
| **11** | `app/actions/abonos.ts` · `lib/abonos.ts` | Reparto FIFO en centavos enteros. **Cero comisiones, cero fiscalidad**: solo consume saldo de tickets | Un abono es dinero que entra, no una comision | ✅ **SIN BRECHA — confirmado, no asumido.** Ver §2 |

### Rutas que revise y estan BIEN

- **`app/actions/pos.ts:552`, split CONTADO con venta a cliente final.** Martin Reyes vendio 3
  tickets a cliente final **a precio publico** ($599/$179/$69) y se quedo con
  `floor(total × 0.20)`. Es el escenario **A** exacto. Las diferencias son de **$0.60, $0.40 y
  $0.80** — puro `Math.floor`, y siempre **a favor de la Matriz**, que es justo lo que manda la
  ley de redondeo. **No es brecha, es la regla funcionando.**
- **El precio en efectivo, en toda la app.** Base = PP, precio = `ceil(PP × 0.80)`,
  `monto_base_ingreso` = `total_cobrado_real`. Las 16 lineas en efectivo de David cuadran al peso.

---

## 2. El abono — verificado, no asumido

Norman pidio expresamente confirmarlo. **No hay brecha, y la razon es estructural:**
`app/actions/abonos.ts` y `lib/abonos.ts` no contienen ni una multiplicacion por un porcentaje de
comision ni una division entre 1.7748. Lo unico que hacen es repartir un monto capturado contra los
saldos abiertos, en centavos enteros, con un invariante duro
(`abonos.ts:490-494`: si la suma escrita no es exactamente el monto capturado, **no se escribe
nada**). Eso esta bien hecho.

**Pero hay un detalle que si conviene que sepas, y no es una brecha de comision sino de
consistencia:**

`abonos.ts:221` calcula el saldo de un ticket con **`total_cobrado_real`**, mientras
`distribuidores-saldos.ts:44` calcula la deuda del DST con **`monto_base_ingreso`**. En efectivo
los dos campos son iguales y nadie lo nota. **En los 2 tickets fiscales de David no lo son:**

| Ticket | `total_cobrado_real` | `monto_base_ingreso` |
|---|---|---|
| `a83054d0` | $7,488 | $4,219.07 |
| `8fdb213c` | $3,072 | $1,730.90 |

O sea: **la pantalla de abonos cree que David debe $7,488 por ese ticket, y su perfil dice
$4,219.07.** Los dos numeros salen del mismo ticket. Cuando arregles la ruta fiscal esto se
resuelve solo (los dos campos vuelven a coincidir), pero mientras tanto son dos verdades distintas
sobre la misma deuda.

---

## 3. Impacto en pesos si la regla se aplicara de hoy en adelante

**Solo el calculo. No se aplico nada.**

### Los 4 distribuidores

| Distribuidor | Tickets CONCESION | Saldo HOY | Saldo con la REGLA | Diferencia |
|---|---|---|---|---|
| **David Flores** | 9 | $850.90 | **$6,588.93** | **+$5,738.03** |
| **Martin Reyes** | 2 | $11,327.00 | $11,327.00 | **$0.00** |
| **Gilberto Franco** | 1 | $8,496.00 | $8,496.00 | **$0.00** |
| **Luis Rodriguez** | 0 | $0.00 | $0.00 | **$0.00** |
| | | **$20,673.90** | **$26,411.93** | **+$5,738.03** |

**Todo el impacto es un solo distribuidor y una sola causa.** Martin, Gilberto y Luis nunca
operaron por `Cuenta Fresnillo`, y en efectivo el sistema ya calcula bien. La brecha entera vive en
los **2 tickets fiscales de David** — que, segun el propio documento, **son un error de captura**
(Norman confirmo que con David nunca ha manejado nada por esa cuenta).

> ⚠️ **Consecuencia incomoda:** si esos 2 tickets se corrigen como error de captura —
> recapturandolos a `Efectivo` — **el impacto de aplicar la regla baja a $0.00 en los 4
> distribuidores.** La regla seguiria siendo necesaria para el futuro, pero hoy no hay ni un peso
> mal cobrado que cobrar. Vale la pena decidir el orden: corregir la captura primero deja la
> migracion de la regla sin datos que arreglar.

### Aparte del saldo de consignacion

- **Ticket `bbbbc594`** (CONTADO, Gilberto → Nuevo Ideal, 2026-09-01, activo): Matriz cobro
  **$39.40 de menos** y Gilberto gano **$58.60 de mas**. No entra en la tabla de arriba porque cae
  en "Saldo por Pagar (Efectivo)", no en la deuda de consignacion.
- **Rutas con brecha pero sin datos:** triangulacion (0 filas activas), cobranza DST→LOC
  (0 ejecuciones), `COMISION_PASIVA` (**0 filas en todo el ledger**; `INGRESO_COMISION` tiene 7, de
  las cuales 4 activas). La brecha esta en el codigo, esperando el primer uso.

---

## 4. Veredicto

**La regla de `REGLAS_COMERCIALES.md` NO es implementable tal como esta escrita.** Las cinco
funciones puras salieron y las pruebas estan en verde, pero eso es porque **yo tuve que elegir** en
cinco puntos donde el documento admite mas de una lectura. Cada eleccion mia esta marcada en el
codigo, y cada una mueve dinero real. **Estas cinco cosas las tiene que resolver Norman antes de
tocar un solo camino de escritura.**

### 🔴 A · ¿Sobre que monto se calculan el IEPS y el IVA?

Es la mas cara de las cinco y el documento **no la responde en ninguna parte** — solo se deduce.

La fila **B** dice que la Matriz se queda con **$270**. Ese numero solo sale si los impuestos se
calculan sobre el **precio publico completo ($599 → $261.50)**, no sobre lo que de verdad entra a
la cuenta. Y cuadra perfecto: `Base − comision = 337.50 − 67.50 = 270`. El documento es
internamente consistente. **Pero eso implica declarar impuesto sobre $599 cuando por la cuenta solo
pasaron $531.50** — el impuesto de la comision que el distribuidor se quedo lo absorbe la Matriz.

Tres respuestas posibles, tres cifras distintas para el mismo ticket `a83054d0`:

| Base gravable | Impuestos del ticket | vs. hoy ($3,268.94) |
|---|---|---|
| **PP completo, $9,336** — lo que implica la fila B | **$4,075.69** | **+$806.75** |
| Lo que la regla cobra, $8,292 | $3,619.92 | +$350.98 |
| Lo cobrado hoy, $7,488 — lo que hace el codigo | $3,268.94 | — |

**Esto no es una decision de software, es una decision fiscal.** Antes de codificarla deberia
verla Konta.

### 🔴 B · El techo en el escenario C: $419.30, $420 o $420.10

El documento dice que la Matriz recibe **$419.30**. Pero la ley de redondeo dice que el costo del
nodo sube con `Math.ceil` siempre que `aplica_redondeo_costo` sea true — **y los 4 distribuidores y
los 11 locales lo tienen en true**. Segun cuando se aplique el techo salen tres numeros:

| Camino | Resultado |
|---|---|
| Regla pura, sin techo | **$419.30** ← lo que dice el documento |
| Techo una vez, al final de la cadena | **$420.00** |
| Techo al entregar al DST ($480) y despues restar el ajuste de $59.90 | **$420.10** ← lo que pasaria en el sistema real, porque el ajuste llega despues |

Deje `deudaPorEntrega` con el techo como parametro, y la prueba documenta los tres. **Falta que
Norman diga cual.**

### 🔴 C · Seis de los once locales no cobran 15%

El ajuste "−10% × Base" **solo funciona con locales al 15%**. En la base de datos hoy:

| Local | `comision_base_local` | Cadena entrega | A la Matriz le queda | Ajuste real |
|---|---|---|---|---|
| Al son del Mezcal, Dulceria ruiz, Mi dulce catrina, Venta mayoreo, Dulceria el Eden | 15% | 30% | 70% ✔ | **−10%** |
| **Delirio 85, Casa Verde, Aeropuerto, Nuevo Ideal** | **20%** | **35%** | **65%** | **+15%** |
| **Descuento del 30%** | **30%** | **45%** | **55%** | **+25%** |

El documento dice *"generaliza solo si un local tiene otro porcentaje"* — y **seis de once ya lo
tienen**. Con `Descuento del 30%` la Matriz se queda con el **55%**, no con el 70%. **¿Es
intencional, o esos porcentajes estan mal capturados?**

### 🔴 D · Seis locales no tienen padre — nadie cobra la comision de red

`Delirio 85`, `Casa Verde`, `Venta mayoreo`, `Aeropuerto`, `Descuento del 30%` y
`Dulceria el Eden` tienen **`id_padre` y `id_nodo_padre` en null**. Cuelgan directo de la Matriz.
Para ellos la cadena entrega solo `comision_base_local` y **no hay DST que cobre red**. La regla no
dice nada de este caso. Lo implemente asi (sin red), que es lo unico coherente — **pero si esos
locales deberian colgar de alguien, hoy hay un 15% que nadie esta cobrando.**

### 🟡 E · El orden de redondeo del ajuste — esto ya lo resolvi, pero quiero que lo sepas

Redondear cada comision por separado y despues restarlas **no da lo mismo** que sumar los
porcentajes primero. En la ruta fiscal, 15% de $337.50 = $50.625, que redondea a $50.63 **dos
veces**, y el ajuste sale **$33.76** en vez de **$33.75**. Un centavo por botella.

Lo implemente **combinando los porcentajes primero**, porque asi esta literalmente escrita la
formula del documento (`(local + red − base) × Base`) y porque no acumula error. Esta anotado en
`lib/reglas-comerciales.ts`. **Si alguien prefiere lo contrario, es una linea — pero que sea una
decision, no un accidente.**

---

## 5. Lo que entrego

| Archivo | Que es |
|---|---|
| `lib/reglas-comerciales.ts` | Las 5 funciones puras, en **centavos enteros**, sin Supabase ni React. **Nadie la importa todavia** |
| `tests/reglas-comerciales.spec.ts` | 38 pruebas: los 3 escenarios, los 3 SKU diarios, el ajuste del 10%, y el golden test de los 9 tickets de David |
| `INFORME_BRECHA_REGLAS_COMERCIALES.md` | Este archivo |

El golden test reproduce **480 / 144 / 56** exactamente sobre las 16 lineas en efectivo, y demuestra
que las 4 lineas fiscales no cuadran: **$8,292 y $3,396** contra los **$7,488 y $3,072** de hoy.
