# ERP de red de distribucion — The Fresnillo Distillery

ERP interno para una destileria que vende a traves de una red jerarquica de distribuidores.
Cubre punto de venta, produccion contra receta, inventario en consignacion, cobranza y el
calculo fiscal inverso (IEPS + IVA) de cada venta.

**La idea central, y lo unico que hay que entender para todo lo demas:** cada evento comercial
escribe en **dos libros independientes** — uno **fisico** (que mercancia se movio) y uno
**monetario** (que se debe y que se cobro) — y **ningun saldo se almacena**. Stock, deuda,
comisiones y ventas se recalculan reproduciendo el historico completo del ledger en cada carga
de pagina. No hay columna de "saldo actual" en ninguna tabla, y esa ausencia es deliberada.

Stack: **Next.js 16 (App Router) + React 19 + Supabase (Postgres)**, sin ORM — `supabase-js`
escrito a mano. Desplegado en Vercel.

---

## Como esta armado

```
                   ┌──────────────────────┐
   ADMIN (matriz)  │  transacciones_      │   el punto donde
        │          │  tickets +           │   se juntan los
        ├─ DST ────│  ticket_detalles     │   dos libros
        │   │      └──────────┬───────────┘
        │   └─ LOC            │
        └─ LOC          ┌─────┴─────┐
                        ▼           ▼
              inventario_ledger   finanzas_ledger
              (que se movio)      (que se debe / cobro)
              cubeta PAGADO |     tipo_movimiento
                    CONSIGNADO    + status
```

`ADMIN` es la matriz. Cuelgan de ella distribuidores (`DST`), y de cada distribuidor pueden
colgar locales (`LOC`). La jerarquia es autorreferente dentro de `entidades`.

## Modelo de dominio — las 9 tablas

| Tabla | Para que es |
|---|---|
| `entidades` | Los nodos de la red y su jerarquia. `rol` es `ADMIN`, `DST`, `LOC` o `SOCIO`. Guarda los parametros comerciales de cada nodo (comisiones, redondeo). |
| `cuentas_financieras` | Una o mas cuentas por entidad. Su `tipo_fiscalidad` (`LIBRE`, `IVA_ONLY`, `FULL_TAX`) determina si una venta que cae ahi paga impuestos. |
| `catalogo_productos` | Los SKUs, divididos en `TERMINADO` (lo que se vende) e `INSUMO` (lo que se consume al producir). |
| `listas_precios` | Precio por SKU y **zona**: local (`Zacatecas`) o `Foraneo`. |
| `recetas_produccion` | La receta (BOM) de cada producto terminado: que insumos consume y cuantos. Admite cantidades fraccionarias. |
| `transacciones_tickets` | El encabezado de cada venta o corte de cobranza. **Es el punto donde se juntan los dos libros.** |
| `ticket_detalles` | Los renglones de cada ticket: SKU, cantidad, precio. |
| `inventario_ledger` | **Libro fisico.** Una fila por movimiento (entradas, salidas, produccion, merma, traspaso), cada una etiquetada con su `cubeta`: `PAGADO` o `CONSIGNADO`. |
| `finanzas_ledger` | **Libro monetario.** Una fila por movimiento de dinero o deuda (ingresos, abonos, deuda a matriz, pasivos fiscales, gastos). |

Las dos ultimas son el corazon del sistema. **Nunca se editan filas para "corregir" un saldo:**
se agrega un movimiento nuevo, o se anula el viejo.

## Seguridad

**RLS (Row Level Security) esta activo en las 9 tablas, con 49 politicas.** Todas van
`TO authenticated`: el rol anonimo no gana acceso por politica, y ademas tiene revocados
`SELECT` y escritura.

| Rol | Que ve | Que escribe |
|---|---|---|
| `ADMIN` | todo | todo |
| `SOCIO` | todo | **nada** — es un rol de solo lectura |
| `DST` | lo suyo y el de sus locales hijos | acotado a ese mismo alcance |
| `LOC` | solo lo suyo | nada (hoy no inician sesion) |

Notas que importan si vas a tocar politicas:

- **No hay `FORCE ROW LEVEL SECURITY`.** El dueno de las tablas y la llave privada siguen
  pasando de largo — de eso dependen las lecturas de inventario del servidor.
- El alcance de un usuario se resuelve con funciones auxiliares en Postgres (`mi_rol()`,
  `mi_entidad_id()`, `mis_entidades()`), no repitiendo el `JOIN` en cada politica.
- Las politicas de RLS son la **segunda** linea de defensa. La primera siguen siendo los
  chequeos de rol dentro de cada server action. Ninguna de las dos sobra.

**Nunca subas una llave al repo.** Ni de ejemplo. Las variables van por nombre en `.env.local`,
que esta en `.gitignore`.

---

## Como correr

Requiere **Node 20** o superior.

```bash
npm install
```

Crea un archivo `.env.local` en la raiz con estas variables. **Aqui van solo los nombres; los
valores se sacan del panel de Supabase (Settings -> API) y no se escriben en ningun archivo
versionado:**

| Variable | Para que | Quien la necesita |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase | navegador y servidor |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Llave publica (anon) | navegador y servidor |
| `SUPABASE_SERVICE_ROLE_KEY` | Llave privada, salta RLS | **solo servidor**, solo para lecturas de inventario |

> ⚠️ La tercera es la llave privada: da acceso total a la base saltandose RLS. Va **unicamente**
> en `.env.local` y en las variables de entorno de Vercel. **No la pongas en CI** — ninguna
> prueba la necesita.

```bash
npm run dev        # servidor de desarrollo
npm test           # pruebas (aritmetica pura: sin red, sin base, sin navegador)
npm run build      # build de produccion
npx tsc --noEmit   # verificacion de tipos (strict mode)
npm run lint       # eslint (hoy con errores preexistentes conocidos)
```

`npm test` corre las pruebas de calculo de `tests/calculo.spec.ts`: el motor fiscal inverso,
la cascada de deduccion de inventario y la clasificacion de tipos de movimiento. No piden
navegador, asi que no hace falta `playwright install`. Los e2e que si lo necesitan estan
marcados con `test.describe.skip`.

### CI

`.github/workflows/ci.yml` corre en cada push y cada pull request: tipos, pruebas, lint
(informativo) y build.

**El build necesita `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` como secretos
del repositorio.** Si no estan configurados, el workflow **se salta el build con un aviso** en
vez de fallar en rojo — tipos y pruebas si corren igual. Para configurarlos:

**Settings -> Secrets and variables -> Actions -> New repository secret**, uno por cada nombre.

---

## Como trabajar aqui

### Migraciones

Todo cambio de esquema va como migracion versionada, nunca a mano en el panel:

```bash
supabase migration new nombre_del_cambio   # crea el archivo en supabase/migrations/
supabase db push                           # aplica
```

Escribe el rollback junto con la migracion. Hay precedente en `supabase/` de rollbacks
guardados aparte; sigue esa costumbre.

### La regla de oro

> **Despues de cada cambio, las cifras historicas de control deben seguir dando
> `118 · 468 · 61 · $386,201`.**

Es decir: `finanzas_ledger` = **118** filas, `inventario_ledger` = **468** filas,
tickets en estado `ACTIVO` = **61**, ventas activas acumuladas = **$386,201**.

Estas cuatro cifras son el sismografo del sistema. Como **ningun saldo se guarda**, un error de
agregacion no rompe nada visible: no hay excepcion, no hay pantalla en blanco, no hay prueba en
rojo. Solo cambian los numeros. Si alguna de las cuatro se movio y tu no lo hiciste a proposito,
tu cambio esta mal — sin importar que `tsc`, `lint` y las pruebas pasen.

`npm run lint` y `npx tsc --noEmit` **no dicen nada** sobre si el dinero esta bien calculado.
Despues de tocar `lib/finance-utils.ts`, `lib/pricing-waterfall.ts`, `lib/inventario-auditoria.ts`
o cualquier archivo de `app/actions/`, verifica a mano contra Supabase.

---

## Decisiones de diseno, y por que

**El saldo se recalcula, no se guarda.**
No existe columna de saldo en ninguna tabla. Todo se reproduce del ledger completo en cada
carga. Cuesta rendimiento y lo pagamos a gusto: un saldo almacenado se desincroniza en silencio
y despues nadie sabe cual de los dos numeros era el bueno. Reproducir el historico significa que
**la respuesta siempre es derivable y auditable hacia atras**. El dia que el volumen lo exija,
la salida es cachear o paginar — no empezar a guardar totales.

**Anulacion en vez de borrado.**
El "borrar" del usuario nunca es un `DELETE`: mueve `status` a `ANULADO`. La fila se queda y
deja de contar. Un `DELETE` sobre un ledger destruye justo lo que hace auditable al sistema —
el rastro de que ahi hubo algo. Hoy hay filas anuladas en los dos libros, y poder verlas es
parte del valor, no basura.

**Dos libros separados en vez de uno.**
Lo fisico y lo monetario se mueven a ritmos distintos: la mercancia sale en consignacion hoy y
el dinero llega semanas despues, o no llega. Un solo libro obligaria a inventar un asiento falso
para cada desfase. Con dos, **el desfase es el dato** — es exactamente lo que hay que ver.

**Avisar en vez de bloquear.**
El lint corre en CI en modo informativo y el build se salta si faltan secretos, con aviso. Un CI
que se pone rojo por algo que nadie va a arreglar hoy deja de leerse en dos semanas, y entonces
ya no protege nada. Lo que **si** bloquea es lo que de verdad rompe el sistema: tipos y pruebas.

---

## Donde esta lo demas

| Archivo | Que contiene |
|---|---|
| `docs/MAPA_ERP_v001_2026-09-01.md` | **El mapa verificado del sistema real**, contrastado contra la base de produccion. Si algo lo contradice, empieza por creerle a el. |
| `CLAUDE.md` | Como escribir codigo en este repo: reglas de negocio, trampas de Next.js 16, convenciones. |
| `CONVENTIONS.md` | Convenciones de codigo y decisiones YAGNI. |
| `BACKLOG.md` | Tickets pendientes. |
| `LECCIONES_DE_GUERRA.md` | Incidentes reales y como se resolvieron. |
| `AGENTS.md` | ⚠️ **Aspiracional, no descriptivo.** Describe una arquitectura que no existe en este repo. |
