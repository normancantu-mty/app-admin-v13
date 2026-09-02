# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # start dev server (Next.js 16 + Turbopack)
npm run build    # production build
npm run start    # run production build
npm run lint     # eslint (20 pre-existing errors + 1 warning; informational in CI)
npm test         # playwright test — pure arithmetic specs, no browser/network/db
npx tsc --noEmit # type-check (strict mode is on in tsconfig.json)
```

**`npm test` works, and it is thin.** Playwright is in `package.json`, `playwright.config.ts` exists, and `tests/calculo.spec.ts` holds 8 pure arithmetic tests covering the reverse-tax engine, the inventory deduction cascade, and movement-type classification. They need no browser, network, or database. The e2e in `tests/finanzas.spec.ts` is `test.describe.skip`. CI lives in `.github/workflows/ci.yml` and runs `tsc --noEmit`, `npm test` and `npm run build` on every push and PR (lint runs informational; the build is skipped with a warning when the Supabase secrets are not configured).

**That suite is not a safety net for money math.** It tests pure functions, not the ledger. **After changing anything in `lib/finance-utils.ts`, `lib/pricing-waterfall.ts`, `lib/inventario-auditoria.ts`, or `app/actions/*.ts`, manually verify the numbers against Supabase** — `npm run lint`, `tsc` and `npm test` passing means nothing about correctness of money or stock math. The control figures are `118 · 468 · 61 · $386,201` (see README).

## Architecture

This is a Next.js App Router + Supabase (Postgres, no ORM — hand-written `supabase-js` queries everywhere) ERP for a distillery/distribution business (Destilado Plata + a pasta product line). It manages a hierarchical dealer network and keeps **two independent ledgers** for every commercial event: a physical one and a monetary one.

### Domain model

- **`entidades`** — network nodes with `rol`: `ADMIN` (matriz) → `DST` (distribuidor) → `LOC` (local), plus read-only `SOCIO` and `SUB-ADMIN`. Self-referencing hierarchy via `id_padre` / `id_nodo_padre` (both are read for parent resolution — a legacy bridge, see Known Risks).
- **`cuentas_financieras`** — one or more financial accounts per entidad (e.g. `CTA-<Nombre>`, plus special accounts like "Fresnillo").
- **`inventario_ledger`** — physical stock ledger. Every row is a movement (`ENTRADA_*`, `SALIDA_*`, `PRODUCCION`, `TRASPASO`, `MERMA`, `DEVOLUCION_FISICA`, ...) tagged with a **cubeta**: `PAGADO` or `CONSIGNADO`. Stock is never stored as a running total — it is always replayed from the full ledger.
- **`finanzas_ledger`** — monetary ledger (`INGRESO_VENTA`, `INGRESO_COMISION`, `DEUDA_A_MATRIZ`, `ABONO_DEUDA`, `PASIVO_IVA`, `PASIVO_IEPS`, `GASTO_OPERATIVO`, ...), linked to `cuentas_financieras` via `id_cuenta_origen` / `id_cuenta_destino`.
- **`transacciones_tickets`** / **`ticket_detalles`** — POS/audit sales receipts; the join point between the two ledgers.
- **`catalogo_productos`**, **`listas_precios`** (zone pricing: Zacatecas vs. Foráneo), **`recetas_produccion`** (BOM, `DECIMAL(10,4)` fractional quantities).

### Write path (the only places that should mutate ledgers)

All mutations funnel through exactly 5 files in `app/actions/`:
- `pos.ts` — `procesarVentaPOS`, the POS sale engine.
- `auditoria.ts` — physical stock counts / cobranza (cash collection) settlement.
- `inventario.ts` — production (`registrarProduccionAction`, posts BOM deductions) and reverse logistics.
- `distribuidores.ts` — entity CRUD.
- `audit.ts` — annulment, single and bulk. Despite the name, `bulkDeleteMovements` **annuls**: it loops calling `anularMovimientoFinanzas`, it does not `DELETE`. It writes **no audit trail** (see rule 6).

Every one of these does **sequential inserts across multiple tables** (ticket → detalles → finanzas_ledger → inventario_ledger) with **no SQL transaction** — there is no `BEGIN`/`COMMIT` anywhere in this codebase. On a failure partway through, they call a manual compensating rollback (e.g. `rollbackTicket` in `pos.ts`) that issues sequential `DELETE`s. A crash between inserts leaves a permanent partial commit. Any new multi-table write must follow this same manual-rollback pattern; there is no better primitive available today.

### Read path

`lib/dashboard-utils.ts` (~850 lines) is the KPI/aggregation engine for all dashboards. It replays the full ledger history on every load (no pagination yet) and implements the **Account_Firewall** (see below).

### Ground-truth docs

`docs/SYSTEM_MANIFEST_V13.json` and `docs/FRONTEND_ARCHITECTURE_V13.md` are self-maintained architecture docs that were spot-checked against the live code and found accurate as of this writing. Prefer reading them over re-deriving business logic from scratch — but verify against the actual file when precision matters, since docs can drift.

## Critical business rules (never violate silently)

1. **Account_Firewall** — any "global"/Admin-level KPI must only include `finanzas_ledger` rows where `id_cuenta_origen` or `id_cuenta_destino` belongs to a cuenta owned by an `ADMIN` entidad (`adminAccountSet`). Implementations: `movimientoTocaCuentaAdminId` / `movimientoTocaFirewallAdmin` in `lib/dashboard-utils.ts`, `filtrarMovimientosFirewallAdmin` in `app/dashboard/finanzas/page.tsx`. Skipping this leaks DST/LOC cash into Matriz totals.
2. **Reverse-tax engine** — whether a sale is taxed is decided by a **case-insensitive substring match** on the destination account's name containing `"fresnillo"` (`resolveTipoFiscalidadCuenta` / `cuentaEsDeAdmin` in `app/actions/pos.ts`). `FULL_TAX` factor is `1.7748` (`montoBase = precioFinalCobrado / 1.7748`; `ieps = montoBase * 0.53`; `iva = (montoBase + ieps) * 0.16`), defined in `lib/finance-utils.ts`. Any other account defaults to `LIBRE` (no tax). This is a textual match, not a flag — renaming an account or creating a second one containing "fresnillo" silently breaks fiscal math.
3. **Inventory deduction order** — always burn from cubeta `PAGADO` first, only overflow into `CONSIGNADO` (`calcularDeduccionCascada` in `lib/inventario-auditoria.ts`). Hard-stops with an error if the requested quantity exceeds total physical stock. Never allow negative stock.
4. **Ledger status contract** — only `'ACTIVO'` and `'ANULADO'` are valid for **new writes** (DB CHECK constraint). `'APPROVED'`/`'PENDING'`/`'REJECTED'` are deprecated legacy values that reads must still tolerate (many queries do `.in('status', ['ACTIVO','APPROVED'])`) but new code must never write them. Pending-approval state is encoded via `categoria: 'ABONO_PENDIENTE'` / `'ABONO_REAL'`, not via `status`.
5. **LOC profile visibility** — entities with `rol === 'LOC'` must never see "Total Ganado" or "Saldo por Pagar (Efectivo)" — they only track physical/consignment debt, not liquid commission math (`showComisionYsaldoEfectivo` in `app/dashboard/distribuidores/[id]/page.tsx`).
6. **Annulment, not deletion** — user-facing "delete" of a ledger row must transition `status → 'ANULADO'`, never `DELETE`. This holds with no exception in `app/actions/audit.ts`: the ADMIN bulk path (`bulkDeleteMovements`) annuls row by row. The physical `DELETE`s that do exist are elsewhere — `eliminarEntidadAction` in `app/actions/distribuidores.ts` and `rollbackTicket` in `app/actions/pos.ts`. **Pending: there is no audit trail of who annulled what.** A table named `auditoria_logs` is referenced by older docs but **does not exist** and no code writes it (`grep -rn "auditoria_logs"` returns zero); if you need the trail, it has to be built.
7. **Rounding law** — the Admin/matriz portion of any split always rounds **up** (`Math.ceil`), the node/distributor portion always rounds **down** (`Math.floor`) or is computed as the exact complement of the total, keeping splits integer-safe and complementary.

## Known risks / fragile areas

- `procesarVentaPOS` in `app/actions/pos.ts` (~660 lines) is a single function doing auth, validation, stock-cascade calculation, two distinct commission engines (`calcularComisionConRedondeo` vs. `calcularComisionPasiva`, which differ only by `Math.ceil` vs. `Math.floor`), and four table writes. Logic (fresnillo detection, reverse-tax call, rounding rules, `notasConIdTicket` injection) is duplicated between `pos.ts` and `auditoria.ts` rather than shared — tax/commission rule changes must be mirrored in both or you get drift (this has happened before, see `BACKLOG.md` TKT-034/TKT-035).
- `id_nodo_padre` vs `id_padre` are both still read for parent resolution ("puente legacy"). Don't remove either without grepping all usages first.
- `lib/inventario-auditoria.ts` uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS for stock reads. RLS **is now on** in all 9 tables (49 policies, all `TO authenticated`; see `supabase/migrations/20260902021000_habilitar_rls_y_politicas.sql` and the README). There is no `FORCE ROW LEVEL SECURITY`, so the service-role reads still pass through by design. RLS is the second line of defence, not the first: the scattered `if (rol !== 'ADMIN')` checks inside server actions still carry real authorization — treat every one of them as load-bearing security, not a UI nicety.
- Fiscal/geo constants are hardcoded and scattered rather than centralized: `TASA_IEPS = 0.53`, `TASA_IVA = 0.16` in `lib/finance-utils.ts`; `ZONA_PRECIO_CALLE = 'Zacatecas'` in `app/actions/auditoria.ts`.
- `AGENTS.md` describes an aspirational multi-agent LangGraph/E2B/Playwright swarm architecture that does **not** actually exist in this repo (no such dependencies, no MCP servers configured; Playwright exists but only as a plain test runner, not as the agent tooling that file describes). Don't treat it as ground truth about actual tooling — it's aspirational narrative, not infrastructure documentation.
- Stray root-level files/folders with broken names (e.g. `(Parte`, `And the buttons section`, `Now for the bulk delete state`, `Lee`, `FIX`) are debris from prior AI agent runs, not intentional project structure.

## Next.js 15/16 gotchas specific to this repo

(Distilled from `LECCIONES_DE_GUERRA.md` / `AI_OPERATIONS_MANUAL.md` — real incidents hit in this codebase, not generic advice.)

- `cookies()` and `searchParams` are **Promises** — always `await` them before use. Forgetting this doesn't always error visibly; it silently freezes the server on stale cached data.
- Never import `next/headers` (or any server-only utility) into a file that also has `'use client'` or client hooks — it's a fatal Turbopack Client Boundary Error. Keep server-only cookie/header reads in `page.tsx` / server actions, and pass results down as plain props (never invent client hooks like `useCurrentUser()` to read session state).
- Any Server Component or Route Handler whose output depends on the session must export `export const dynamic = 'force-dynamic'`, or Turbopack's aggressive caching will serve a stale pre-auth response (including stale 403s) after the user is authenticated.
- Session reads must go through `@supabase/ssr`'s `createServerClient`, instantiated per-request with the resolved cookie store — never a pre-configured global `@supabase/supabase-js` client in server code.
- Client Components write global UI state (e.g. the date-range filter) to `document.cookie`; Server Components read the same state via `cookies()`. Don't route this state through URL `searchParams` — it gets reset on sidebar navigation in this app's layout.
- Reserve `alert()` for direct user-initiated actions (e.g. clicking "Aprobar/Rechazar"); use `console.error()` for background/on-mount fetch failures so the dev overlay surfaces the error without freezing the UI thread.

## Conventions

- Domain vocabulary is Spanish and canonical in code (`entidades`, `cuentas_financieras`, `inventario_ledger`, `cubeta`, `comision_base`, etc.) — don't translate identifiers to English.
- No heavy charting libraries (Recharts, Chart.js, etc.) for simple visualizations — build percentage breakdowns from native Tailwind progress bars (`style={{ width: \`${pct}%\` }}` on a rounded `div`), per explicit YAGNI decision in `CONVENTIONS.md`.
- Follow YAGNI generally: simplest viable solution, no speculative abstractions.
- Prefer keeping files under ~500 lines and single-purpose where practical (existing exceptions like `pos.ts` and `dashboard-utils.ts` are known debt, not a pattern to copy).
