# Frontend Architecture — V13

**Document type:** UI/UX & Next.js rendering contract  
**Version:** V13  
**Last updated:** 2026-05-19  
**Companion docs:** `docs/SYSTEM_MANIFEST_V13.json` (business logic), `docs/DATABASE_SCHEMA_DETAILED.sql` (ledger schema)

This document defines **Zero-Trust UI directives** for the App Admin dashboard. It intentionally lives outside the backend manifest to keep JSON lean and to give designers and frontend engineers a single source of truth for **conditional rendering**, **routing**, **aggregation rules**, and **tenant isolation at the presentation layer**.

---

## Table of contents

1. [Design principles](#1-design-principles)
2. [Role-based conditional rendering](#2-role-based-conditional-rendering)
3. [Dashboard aggregation & state blindness](#3-dashboard-aggregation--state-blindness)
4. [Tenant isolation firewall (UI layer)](#4-tenant-isolation-firewall-ui-layer)
5. [Audit traceability](#5-audit-traceability)
6. [Approval workflows](#6-approval-workflows)
7. [Route & component map](#7-route--component-map)
8. [Implementation checklist](#8-implementation-checklist)

---

## 1. Design principles

| Principle | Meaning in this app |
|-----------|---------------------|
| **Fail closed** | If role, account ownership, or movement status cannot be verified, hide the control or exclude the row from totals—never guess. |
| **Server truth, client gates** | KPI numbers are computed in Server Components / `lib/dashboard-utils.ts`; UI only **filters what is shown** and **hides cards**—it must not invent balances client-side. |
| **No cross-tenant bleed** | Admin dashboards aggregate **only** movements that touch Admin-owned `cuentas_financieras`. Distributor cash accounts are invisible in Admin finance views. |
| **LOC = physical debt only** | Locals operate on consigned inventory; liquid commission and “cash to remit” KPIs are not part of their mental model and must not appear on their profile. |
| **Trace before trash** | Every annullable row shows **who created it** (email) in the column immediately preceding the annul action. |

---

## 2. Role-based conditional rendering

### 2.1 Entity profile — `LOC` card visibility

**Rule:** When viewing an entity profile (`/dashboard/distribuidores/[id]`), if `entidad.rol === 'LOC'`, the UI **must not render**:

- **Total Ganado** (earned commissions for the period)
- **Saldo por Pagar (Efectivo)** (liquid cash pending remittance to Admin)

**Allowed for `LOC`:**

- **Saldo Pendiente** (physical / inventory debt — concession bottle obligation)
- **Total Mermas**
- Inventory bucket panels (PAGADO / CONSIGNADO)
- Action panel (Nueva Venta, Cobranza, Abono, Devolución) when `canMutate`

**Implementation reference:**

```ts
const showComisionYsaldoEfectivo = entidad.rol !== 'LOC'
```

- File: `app/dashboard/distribuidores/[id]/page.tsx`
- Grid layout collapses from 4 columns to 2 when `LOC` (only physical + mermas cards).

**Rationale:** Locals do not earn network commission splits or hold “caja por entregar a matriz” in the same way as `DST`. Showing those cards would misstate their economic role and leak distributor-level semantics.

| Role | Total Ganado | Saldo Pendiente | Saldo por Pagar (Efectivo) |
|------|:------------:|:---------------:|:--------------------------:|
| `ADMIN` (viewing any) | Per target `entidad.rol` | Yes | Per target `entidad.rol` |
| `DST` | Yes (self / network) | Yes | Yes |
| `LOC` | **Hidden** | Yes | **Hidden** |
| `SOCIO` | Read-only mirror of above | Read-only | Read-only |

### 2.2 Network directory — `Zona` column

**Rule:** The **Zona** column in the Network Directory table is rendered **only** when the session user has `rol === 'ADMIN'`.

- Prop: `showZonaColumn={currentUser?.rol === 'ADMIN'}`
- Parent: `app/dashboard/distribuidores/page.tsx`
- Child: `app/dashboard/distribuidores/DirectoryTableClient.tsx`

For non-Admin roles (`DST`, `LOC`, `SOCIO`), the column must be **omitted from the DOM** (not merely hidden with CSS). This prevents layout inspection or responsive overrides from exposing geographic segmentation to unauthorized actors.

**Search note:** DST search filters by name/phone only; zone is not a client-side filter for non-Admins.

### 2.3 Other role gates (summary)

| Surface | Condition | Behavior |
|---------|-----------|----------|
| POS vendor override | `ADMIN` only | Selector + `?vendedor=` deep link |
| POS inventory triangulation | `ADMIN` + buyer `LOC` | `origenInventarioId` selector |
| Entity edit / delete | `ADMIN` | `EditEntidadModal`, delete in modal |
| Finanzas approvals | `ADMIN` / `SUB-ADMIN` | `PendingApprovalsPanel` |
| Cobranza / auditoría on foreign entity | `ADMIN` or parent `DST` | Server action guard in `auditoria.ts` |
| Anular movimiento (DST) | Creator + 6h window | `app/actions/audit.ts` |

---

## 3. Dashboard aggregation & state blindness

### 3.1 Effective movement filter

All **General** KPIs, **Finanzas** summaries, **Distribution** cards, and **pasivos fiscales** must include only rows that are economically active:

```ts
// lib/finance-utils.ts — movimientoContableEfectivo
status === 'ACTIVO' || status === 'APPROVED'
// AND NOT: ANULADO, PENDING, REJECTED
// AND NOT: categoria === 'ABONO_PENDIENTE' (pending approval gateway)
```

**V13 target:** New writes use `status = 'ACTIVO'` only. Legacy rows may still carry `APPROVED`; aggregations must accept **both** until backfill completes.

### 3.2 State blindness warning

> **Strict warning — do not filter KPI queries with `APPROVED` alone.**

If server or client queries use:

```ts
.in('status', ['APPROVED'])  // ❌ WRONG after V13 posting paths
```

…dashboards will show **$0.00** while the ledger contains valid `ACTIVO` rows. This is **state blindness**: the UI appears empty though the database is not.

**Correct patterns:**

```ts
.in('status', ['ACTIVO', 'APPROVED'])           // transitional queries
// or, post-backfill:
.eq('status', 'ACTIVO')
```

Always pair status filters with `movimientoContableEfectivo()` (or equivalent) when reducing totals client-side.

### 3.3 Pending abonos vs status

Distributor-initiated settlements that await Admin approval use:

- `status: 'ACTIVO'` (DB CHECK allows only `ACTIVO` | `ANULADO`)
- `categoria: 'ABONO_PENDIENTE'` (excluded from KPIs via `esAbonoPendienteAprobacion`)

Do **not** insert `status: 'PENDING'` from the UI—it violates the V13 ledger CHECK and causes constraint errors.

### 3.4 Surfaces that aggregate movements

| Surface | Aggregator | Status filter |
|---------|------------|---------------|
| General dashboard | `lib/dashboard-utils.ts` → `getFinanzasDashboard`, `getLiquidezPorCuenta` | `ACTIVO` + legacy `APPROVED` |
| Finanzas page resumen | `calcularResumen` + `movimientoContableEfectivo` | Per-row on fetched set |
| Distribuidores directory saldos | `lib/distribuidores-saldos.ts` | Active + excludes `ABONO_PENDIENTE` |
| Entity profile KPIs | `page.tsx` server calculations | Ledger replay, `ACTIVO` inventory |
| Pasivos IVA/IEPS | `calcularPasivosFiscalesAdmin` | `ACTIVO` only in pasivo helper |

---

## 4. Tenant isolation firewall (UI layer)

The backend manifest documents **Account_Firewall** for `lib/dashboard-utils.ts`. The UI must apply the **same predicate** before rendering Admin finance tables and period totals.

### 4.1 Definition

```ts
adminAccountSet = Set<cuenta_financieras.id>
// where cuenta.id_entidad → entidades.rol === 'ADMIN'
```

Resolve IDs once per request (`getAdminAccountIds`, `fetchAdminCuentaIds`).

### 4.2 Inclusion predicate

A `finanzas_ledger` row is **visible** in Admin finance UI iff:

```ts
adminAccountSet.has(id_cuenta_destino) || adminAccountSet.has(id_cuenta_origen)
```

**Implementation:**

- `filtrarMovimientosFirewallAdmin` — `app/dashboard/finanzas/page.tsx`
- `movimientoTocaFirewallAdmin` / `movimientoTocaCuentaAdminId` — `lib/dashboard-utils.ts`

### 4.3 What to exclude

Rows where **only** `id_cuenta_destino` points to a **Distributor (`DST`) or Local (`LOC`) cash account** must **not** appear in:

- Admin **Movimientos** table (historical + period)
- Admin **Ingresos / Egresos / Balance** cards
- General dashboard liquidity buckets

Admin views show **Admin accounts only**—movements that never touch an Admin cuenta are out of scope for Matriz KPIs.

### 4.4 Ingresos vs egresos (UI must mirror math)

| Flow | UI rule |
|------|---------|
| **Ingresos** | Sum `monto` when `tipo_movimiento ∈ { INGRESO_VENTA, ABONO_DEUDA, … }` and `id_cuenta_destino ∈ adminAccountSet` |
| **Egresos** | Subtract `monto` when tipo is egreso admin and `resolveCuentaEgresoAdmin(mov) ∈ adminAccountSet` — for `GASTO_OPERATIVO`, **`id_cuenta_origen`** is the account that loses cash |

Failing to subtract `id_cuenta_origen` outflows inflates liquidity and causes **silent cross-tenant leaks** when combined with incomplete filters.

### 4.5 Anti-patterns

| Anti-pattern | Risk |
|--------------|------|
| Render all `finanzas_ledger` rows for date range | DST/LOC cash mixed into Admin totals |
| Filter only `id_cuenta_destino` | Miss transfers out of Admin via `id_cuenta_origen` |
| Client-side sum without `adminAccountSet` | Any RLS gap exposes foreign cuenta balances |

---

## 5. Audit traceability

### 5.1 Column contract

Data tables that support annulment **must** include a **Creado por** column:

- **Label:** `Creado por`
- **Value:** `usuario_creador` (email) from ledger/ticket row; display `—` if null/legacy
- **Position:** Immediately **before** the **Anular** action column (trash / checkbox)

> **Schema note:** V13 schema documentation uses `creado_por`; generated types may still expose `usuario_creador` until types are regenerated. UI label remains **Creado por**.

### 5.2 Implementations

| Table | File | Column order (audit → action) |
|-------|------|-------------------------------|
| Distributor activity | `HistorialActividadTableClient.tsx` | … Monto → **Creado por** → **Anular** |
| Finanzas movimientos | `MovimientosTable.tsx` | … Monto → **Creado por** (bulk Anular checkbox is first column for ADMIN batch ops) |
| Inventario movimientos | `MovimientosTable.tsx` (inventario) | Creator shown; annul rules per `audit.ts` |

### 5.3 Annulment UX

- Annul = `status → 'ANULADO'` (no `DELETE`)
- Row styling: `opacity-60`, `line-through`, badge `ANULADO`
- DST: only if `usuario_creador === session.email` and within 6h (finanzas/inventario) or ticket cascade rules (`ticket-annul-cascade.ts`)

### 5.4 Feed & color semantics (activity)

Reference: `app/dashboard/feed/page.tsx`

| Event | Color intent |
|-------|----------------|
| Concesión ticket | Grey (non-cash emphasis) |
| `ABONO_DEUDA`, `INGRESO_COMISION` | Green |
| `DEUDA_A_MATRIZ` | Grey |
| Default expense | Red |

---

## 6. Approval workflows

### 6.1 When approval is required

Manual transfers or settlements initiated by **Distributors (`DST`)** or **Locals (`LOC`)** that represent cash remittance to Admin must pass through the **approval gateway** before affecting KPIs:

| Actor | Movement | Gateway |
|-------|----------|---------|
| `DST` / `LOC` | `ABONO_DEUDA` (entity → Admin cuenta) | `categoria: 'ABONO_PENDIENTE'` |
| `ADMIN` | Same paths | Immediate `categoria: 'ABONO_REAL'` (or fiscal split on approve) |

Entry UI: `app/dashboard/distribuidores/[id]/abono/page.tsx`  
Approval UI: `app/dashboard/finanzas/PendingApprovalsPanel.tsx`  
API: `app/api/finanzas/aprobaciones/route.ts`

### 6.2 Insert contract (prevents DB constraint violations)

```ts
// ✅ V13 — satisfies CHECK (status IN ('ACTIVO','ANULADO'))
{
  status: 'ACTIVO',
  categoria: requiereAprobacionAdmin ? 'ABONO_PENDIENTE' : 'ABONO_REAL',
  tipo_movimiento: 'ABONO_DEUDA',
  ...
}
```

```ts
// ❌ FORBIDDEN — triggers CHECK violation / state drift
{ status: 'PENDING' | 'APPROVED', ... }  // from DST client forms
```

**Why:** The ledger no longer accepts `PENDING` as operational status. Pending business state is encoded in **`categoria`**, not `status`.

### 6.3 Admin approval flow

1. Admin opens Finanzas → pending panel loads rows with `categoria === 'ABONO_PENDIENTE'`.
2. On approve, API recalculates fiscal split (`calculateReverseTaxes` / `calcularDesgloseFiscal`) when cuenta is fiscal.
3. Row updates: `categoria → 'ABONO_REAL'`, optional `monto` adjustment, companion `PASIVO_*` rows inserted.
4. On reject, row → `status: 'ANULADO'` (or equivalent void path).

Until approval, `movimientoContableEfectivo` returns **false** for pending rows → **no KPI impact**.

### 6.4 User messaging

| Outcome | Message pattern |
|---------|-----------------|
| DST submits abono | “Abono registrado y enviado a la cola de aprobación del Admin.” |
| ADMIN submits | “Transferencia registrada correctamente.” |

---

## 7. Route & component map

| Route | Primary components | Zero-Trust notes |
|-------|-------------------|------------------|
| `/dashboard/general` | General KPIs | Firewall + `ACTIVO`/`APPROVED` |
| `/dashboard/finanzas` | `MovimientosTable`, `PendingApprovalsPanel` | `filtrarMovimientosFirewallAdmin` |
| `/dashboard/distribuidores` | `DirectoryTableClient` | `showZonaColumn` ADMIN-only |
| `/dashboard/distribuidores/[id]` | Profile KPI cards, `HistorialActividadTableClient` | Hide liquid KPIs for `LOC` |
| `/dashboard/distribuidores/[id]/abono` | Transfer form | `ABONO_PENDIENTE` for non-Admin |
| `/dashboard/distribuidores/[id]/cobranza` | Cobranza / auditoría | Server-side role guards |
| `/pos` | POS terminal | ADMIN god-mode; fiscal cuenta rules |
| `/dashboard/inventario` | Stock KPIs | `status === 'ACTIVO'` stock reads |

**Layout:** `app/dashboard/layout.tsx` — session role available to children via server auth helpers (`getCurrentUser`).

---

## 8. Implementation checklist

Use this before merging UI changes:

- [ ] **LOC profile:** `Total Ganado` and `Saldo por Pagar (Efectivo)` are not in the DOM when `entidad.rol === 'LOC'`.
- [ ] **Directory:** `Zona` column only when viewer is `ADMIN`.
- [ ] **KPI queries:** Include `ACTIVO` (and legacy `APPROVED` if not backfilled); never `APPROVED`-only.
- [ ] **Pending abonos:** Excluded via `ABONO_PENDIENTE`, not `status: 'PENDING'`.
- [ ] **Admin finanzas:** All rendered movimientos pass `adminAccountSet` firewall.
- [ ] **Egresos:** Outflows deduct via `id_cuenta_origen` / `resolveCuentaEgresoAdmin`.
- [ ] **Tables:** `Creado por` column present and populated from `usuario_creador` / `creado_por`.
- [ ] **DST transfers:** Non-Admin `ABONO_DEUDA` to Admin uses approval gateway before KPI impact.
- [ ] **Annul:** Only `ANULADO` status transition; creator/role rules enforced.

---

## Related symbols

| Symbol | Location |
|--------|----------|
| `CATEGORIA_ABONO_PENDIENTE` / `CATEGORIA_ABONO_REAL` | `lib/finance-utils.ts` |
| `movimientoContableEfectivo` | `lib/finance-utils.ts` |
| `filtrarMovimientosFirewallAdmin` | `app/dashboard/finanzas/page.tsx` |
| `showComisionYsaldoEfectivo` | `app/dashboard/distribuidores/[id]/page.tsx` |
| `notasConIdTicket` | `lib/ticket-annul-cascade.ts` |

---

*End of FRONTEND_ARCHITECTURE_V13.md*
