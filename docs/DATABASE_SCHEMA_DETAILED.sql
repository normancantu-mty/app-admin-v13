-- =============================================================================
-- DATABASE_SCHEMA_DETAILED.sql
-- Deep-Dive Documentation (PostgreSQL / Supabase) — V13
-- Source of truth used for this document:
--   1) types/database.ts (generated DB typings; regenerate after V13 migrations)
--   2) supabase/tkt-051-status-symmetry.sql (status symmetry migration)
--   3) Supabase calls across app/lib/actions (runtime usage contract)
-- =============================================================================

/* =============================================================================
WHY THIS LEDGER ARCHITECTURE EXISTS
============================================================================= */
/*
This schema intentionally separates:
  - Physical truth (inventario_ledger)
  - Monetary truth (finanzas_ledger)
  - Commercial event anchor (transacciones_tickets + ticket_detalles)

WHY:
1) Inmutability/Auditability:
   Every movement is appended as a ledger row (event-style). Corrections are done
   by status transitions (e.g., ANULADO) or compensating rows, not destructive
   overwrite of historical business facts.

2) Partida Doble Operativa:
   One sale can produce BOTH:
   - Inventory legs (outflow from source entity + optional inflow to buyer entity)
   - Financial legs (INGRESO_VENTA + fiscal liabilities + debt/commission legs)
   This avoids mixing "stock changed" with "cash/debt changed" in one table.

3) Role-aware accounting:
   id_entidad_relacionada in finanzas_ledger attaches each movement to the
   accountable actor/node in the network (ADMIN / DST / LOC), enabling debt and
   commission rollups without mutating the core ticket record.
*/

/* =============================================================================
DOMAIN SNAPSHOT: TABLES DETECTED
============================================================================= */
/*
public.catalogo_productos
public.cuentas_financieras
public.entidades
public.finanzas_ledger
public.inventario_ledger
public.listas_precios
public.recetas_produccion
public.ticket_detalles
public.transacciones_tickets
*/

/* =============================================================================
LEDGER STATUS CONTRACT (V13 — SYMMETRIC, STRICT)
============================================================================= */
/*
BOTH finanzas_ledger AND inventario_ledger enforce the same operational status
vocabulary at the database layer:

  CHECK (status IN ('ACTIVO', 'ANULADO'))

DEPRECATED — DO NOT USE FOR LEDGER OPERATIONS:
  - APPROVED
  - PENDING
  - REJECTED

WHY:
  Historical approval workflows wrote APPROVED/PENDING/REJECTED into finanzas_ledger.
  V13 unifies on ACTIVO (economically effective row) vs ANULADO (voided row).
  Application KPIs, POS posting, auditoría, and cascade annulment MUST filter/write
  status='ACTIVO' only. Legacy APPROVED rows may exist until backfill; new inserts
  MUST NOT use APPROVED.

MIGRATION REFERENCE:
  - inventario_ledger: supabase/tkt-051-status-symmetry.sql
  - finanzas_ledger:   same CHECK applied in V13 schema hardening (symmetry)
*/

/* =============================================================================
TABLE: public.catalogo_productos
============================================================================= */
/*
TABLE_DEFINITION
  - id                  : string (UUID inferred from Supabase conventions) [PK]
  - sku                 : string
  - nombre              : string
  - tipo                : string              -- observed values: INSUMO, TERMINADO
  - unidad_medida       : string | null
  - costo_unitario      : number | null

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - Referenced by inventario_ledger.id_producto
  - Referenced by listas_precios.id_producto
  - Referenced by recetas_produccion.id_insumo
  - Referenced by recetas_produccion.id_producto_terminado
  - Referenced by ticket_detalles.id_producto

CONSTRAINTS (observed)
  - tipo is consumed by app logic as TERMINADO/INSUMO.
    (No explicit CHECK visible in available migration snapshot.)
*/

/* =============================================================================
TABLE: public.entidades
============================================================================= */
/*
TABLE_DEFINITION
  - id                     : string (UUID inferred) [PK]
  - auth_id                : string | null
  - email                  : string | null
  - nombre                 : string
  - rol                    : string            -- observed: ADMIN, DST, LOC, SOCIO, SUB-ADMIN
  - zona                   : string
  - telefono               : string | null
  - ubicacion_maps         : string | null
  - es_distribuidor        : boolean | null
  - id_padre               : string | null     -- legacy topology parent
  - id_nodo_padre          : string | null     -- current topology parent
  - comision_base          : number | null
  - comision_base_local    : number | null
  - comision_hijo_local    : number | null
  - comision_logistica     : number | null
  - aplica_redondeo_costo  : boolean | null  -- DST/LOC pricing & cash-split rounding
  - fecha_ultimo_seguimiento: string | null
  - ultimo_seguimiento     : string | null

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - Self FK: id_padre -> entidades.id (legacy hierarchy)
  - Self FK: id_nodo_padre -> entidades.id (current hierarchy)
  - Parent of cuentas_financieras.id_entidad
  - Parent of finanzas_ledger.id_entidad_relacionada
  - Parent of inventario_ledger.id_entidad_origen/id_entidad_destino
  - Parent of transacciones_tickets.id_vendedor/id_comprador

DOUBLE-LEDGER SEMANTICS
  - id_entidad_origen vs id_entidad_destino (in inventario_ledger):
      Represents which node loses stock vs which node receives stock.
  - id_entidad_relacionada (in finanzas_ledger):
      Represents which node is economically attributed in that movement
      (debt owner, commission beneficiary, etc.).
*/

/* =============================================================================
TABLE: public.cuentas_financieras
============================================================================= */
/*
TABLE_DEFINITION
  - id               : string (UUID inferred) [PK]
  - id_entidad       : string | null          -- FK -> entidades.id
  - nombre           : string
  - tipo_fiscalidad  : string                 -- LIBRE | IVA_ONLY | FULL_TAX

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK cuentas_financieras_id_entidad_fkey -> entidades(id)
  - Referenced by transacciones_tickets.id_cuenta_destino
  - Referenced by finanzas_ledger.id_cuenta_destino / id_cuenta_origen

TAX ENGINE (V13 — REVERSE TAX ON tipo_fiscalidad)
  cuentas_financieras.tipo_fiscalidad is the fiscal trigger for ALL reverse-tax
  reconstruction paths, including audit collections (ABONO_DEUDA) — not only POS.

  Modes (lib/finance-utils.ts → calculateReverseTaxes):
    LIBRE     : base = gross; IEPS = 0; IVA = 0
    IVA_ONLY  : base = gross / 1.16; IEPS = 0; IVA = base * 0.16
    FULL_TAX  : base = gross / 1.7748; IEPS = base * 0.53; IVA = (base+IEPS)*0.16
                where 1.7748 = 1 + IEPS + (1+IEPS)*IVA

  When tipo_fiscalidad IN ('FULL_TAX', 'IVA_ONLY'), the application emits
  companion ledger rows:
    - tipo_movimiento = 'PASIVO_IVA'  (monto = reconstructed IVA)
    - tipo_movimiento = 'PASIVO_IEPS' (monto = reconstructed IEPS; FULL_TAX only)

  This applies during:
    - POS sales (procesarVentaPOS)
    - Pending abono approvals (app/api/finanzas/aprobaciones)
    - Physical audit collections (procesarCorteInventarioAction / auditoría)

  CRITICAL: ABONO_DEUDA from auditoría still runs reverse-tax when the destination
  account is fiscal. The ABONO row records totalCobranza (gross collected); PASIVO_*
  rows decompose embedded tax liabilities for KPI tracking (PASIVO_IVA / PASIVO_IEPS).

  Account resolution in auditoría: id_cuenta_destino on the ABONO and PASIVO rows
  points to the collector's cuenta; tipo_fiscalidad is read from that cuenta row.
*/

/* =============================================================================
TABLE: public.transacciones_tickets
============================================================================= */
/*
TABLE_DEFINITION
  - id                           : string (UUID inferred) [PK]
  - fecha_transaccion            : string | null (timestamp)
  - id_vendedor                  : string | null   -- FK -> entidades.id
  - id_comprador                 : string | null   -- FK -> entidades.id
  - id_cuenta_destino            : string | null   -- FK -> cuentas_financieras.id
  - condicion_pago               : string          -- observed: CONTADO, CONCESION
  - subtotal_catalogo            : number
  - total_cobrado_real           : number
  - monto_base_ingreso           : number
  - impuesto_iva_calculado       : number | null
  - impuesto_ieps_calculado      : number | null
  - bonificacion_cascada_generada: number | null
  - usuario_creador              : string | null
  - status                       : string          -- ACTIVO | ANULADO (commercial header)

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK transacciones_tickets_id_vendedor_fkey -> entidades(id)
  - FK transacciones_tickets_id_comprador_fkey -> entidades(id)
  - FK transacciones_tickets_id_cuenta_destino_fkey -> cuentas_financieras(id)
  - Parent of ticket_detalles.id_ticket
  - Parent of finanzas_ledger.id_ticket

DATA_FLOW_NOTE
  - Ticket is the commercial "header event".
  - Monetary and inventory effects are decomposed into ledger tables; ticket is
    not the only accounting table.
*/

/* =============================================================================
TABLE: public.ticket_detalles
============================================================================= */
/*
TABLE_DEFINITION
  - id             : string (UUID inferred) [PK]
  - id_ticket      : string | null    -- FK -> transacciones_tickets.id
  - id_producto    : string | null    -- FK -> catalogo_productos.id
  - cantidad       : number
  - precio_unitario: number
  - subtotal_linea : number

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK ticket_detalles_id_ticket_fkey -> transacciones_tickets(id)
  - FK ticket_detalles_id_producto_fkey -> catalogo_productos(id)

DATA_FLOW_ANNOTATION (required)
  - ticket_detalles is the SKU bridge that explains "what was sold" per ticket.
  - inventario_ledger records stock movement rows by producto/entity.
  - transacciones_tickets + ticket_detalles gives commercial intent;
    inventario_ledger gives physical execution.
  - Traceability path:
      transacciones_tickets (header)
        -> ticket_detalles (line items / product quantities)
        -> inventario_ledger (origin/destination stock legs; notas may carry ticket:id)
*/

/* =============================================================================
TABLE: public.inventario_ledger
============================================================================= */
/*
TABLE_DEFINITION
  - id                       : string (UUID inferred) [PK]
  - fecha_movimiento         : string | null (timestamp)
  - id_producto              : string               -- FK -> catalogo_productos.id
  - id_entidad_origen        : string | null        -- FK -> entidades.id
  - id_entidad_destino       : string | null        -- FK -> entidades.id
  - tipo_movimiento          : string
  - cantidad                 : number
  - cubeta                   : string               -- observed: PAGADO, CONSIGNADO
  - costo_unitario_movimiento: number | null
  - notas                    : string | null        -- may embed ticket:{uuid} for cascade
  - status                   : string
  - creado_por               : string | null        -- audit trail (actor email / user id)

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK inventario_ledger_id_producto_fkey -> catalogo_productos(id)
  - FK inventario_ledger_id_entidad_origen_fkey -> entidades(id)
  - FK inventario_ledger_id_entidad_destino_fkey -> entidades(id)

AUDIT TRAIL (creado_por)
  - Immutable attribution of WHO posted the movement.
  - Populated on insert from session (e.g. currentUser.email) in POS, auditoría,
    producción, logística inversa.
  - Used by assertAnnullmentAllowed / ownership gates in app/actions/audit.ts.
  - NOT updated on ANULADO transition (status flip only; creator preserved).
  - Legacy column name in some typings: usuario_creador (alias until types regen).

DOUBLE-LEDGER SEMANTICS
  - id_entidad_origen means "who gives/loses inventory".
  - id_entidad_destino means "who receives inventory".
  - The same movement type can be interpreted as entrada/salida by perspective
    according to origin/destination and movement taxonomy.

CONSTRAINTS
  [CONFIRMED MIGRATION: supabase/tkt-051-status-symmetry.sql]
    CHECK inventario_ledger_status_check:
      status IN ('ACTIVO', 'ANULADO')

  DEPRECATED for ledger operations: APPROVED, PENDING, REJECTED (see LEDGER STATUS CONTRACT).

  [APPLICATION DOMAIN CONTRACT]
    tipo_movimiento observed set:
      ENTRADA_COMPRA, SALIDA_VENTA, PRODUCCION, MERMA, TRASPASO,
      DEVOLUCION_FISICA, INGRESO_TRASPASO, EGRESO_TRASPASO,
      ENTRADA_CONCESION, SALIDA_CONCESION, LIQUIDACION_INTERNA

    cubeta observed set: PAGADO, CONSIGNADO

  CASCADE ANNULMENT CORRELATION (notas)
    - POS and auditoría inject notasConIdTicket(ticketId, notas) → "ticket:{uuid}"
    - annulComercialCascadePorTicketId matches inventario_ledger.notas ILIKE %ticketId%
      to void inventory legs tied to a commercial event without DELETE.
*/

/* =============================================================================
TABLE: public.finanzas_ledger
============================================================================= */
/*
TABLE_DEFINITION
  - id                    : string (UUID inferred) [PK]
  - fecha_movimiento      : string | null (timestamp)
  - id_cuenta_origen      : string | null   -- FK -> cuentas_financieras.id (egreso source)
  - id_cuenta_destino     : string | null   -- FK -> cuentas_financieras.id (ingreso sink)
  - id_entidad_relacionada: string | null   -- FK -> entidades.id
  - id_ticket             : string | null   -- FK -> transacciones_tickets.id
  - tipo_movimiento       : string | null
  - monto                 : number
  - categoria             : string | null
  - categoria_gasto       : string | null
  - subcategoria          : string | null
  - descripcion           : string | null
  - es_recurrente         : boolean | null
  - status                : string
  - creado_por            : string | null   -- audit trail (actor email / user id)

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK finanzas_ledger_id_cuenta_origen_fkey -> cuentas_financieras(id)
  - FK finanzas_ledger_id_cuenta_destino_fkey -> cuentas_financieras(id)
  - FK finanzas_ledger_id_entidad_relacionada_fkey -> entidades(id)
  - FK finanzas_ledger_id_ticket_fkey -> transacciones_tickets(id)

AUDIT TRAIL (creado_por)
  - Same contract as inventario_ledger.creado_por (see above).
  - Legacy column name in some typings: usuario_creador.

DATA_FLOW_ANNOTATION: role-based debt semantics
  - id_entidad_relacionada is the PRIMARY accountability axis for KPI
    aggregation and commission tracking.
  - Mapping:
      * ABONO_DEUDA      -> entity whose debt was paid/reduced
      * INGRESO_COMISION -> entity earning commission
      * DEUDA_A_MATRIZ   -> entity that collected cash pending upstream delivery
      * COMISION_PASIVA  -> parent/distributor beneficiary node
      * CARGO_DEUDA      -> entity receiving a debt charge (admin -> node transfer)
      * PASIVO_IVA/IEPS  -> fiscal liability legs (see TAX ENGINE)

DOUBLE-LEDGER POLARITY (Debt perspective by id_entidad_relacionada)
  - CREDITS / ABONOS (decrease debt):
      ABONO_DEUDA, INGRESO_COMISION, COMISION_PASIVA
  - DEBITS / CARGOS / SALES (increase debt):
      DEUDA_A_MATRIZ, CARGO_DEUDA, CONCESION inventory-debt KPI sources
  - Signed intuition: saldo = debits - credits; saldo > 0 => node owes Admin

CONSTRAINTS
  [V13 DB CHECK — symmetric with inventario_ledger]
    CHECK finanzas_ledger_status_check:
      status IN ('ACTIVO', 'ANULADO')

  DEPRECATED for ledger operations:
    APPROVED — completely deprecated; do not insert or filter as operational truth.
    PENDING / REJECTED — legacy approval workflow only; not valid ledger lifecycle.

  [DB CHECK — business glossary: finanzas_ledger_tipo_movimiento_check]
    INGRESO_VENTA, GASTO_OPERATIVO, ABONO_DEUDA, INGRESO_COMISION,
    DEUDA_A_MATRIZ, COMISION_PASIVA, PASIVO_IVA, PASIVO_IEPS,
    EGRESO_TRASPASO, INGRESO_TRASPASO, SUBSIDIO_FISCAL, CARGO_DEUDA, COMPRA_INSUMOS

  TAX AMORTIZATION (application layer, V13)
    GASTO_OPERATIVO with fiscal payment concepts (e.g. categoria/subcategoria
    "Fuga_Fiscal_IVA", "Fuga_Fiscal_IEPS") reduces global PASIVO_IVA / PASIVO_IEPS KPIs.
    See lib/finance-utils.ts esPagoImpuestoIva / esPagoImpuestoIeps and
    lib/dashboard-utils.ts calcularPasivosFiscalesAdmin.
*/

/* =============================================================================
TABLE: public.listas_precios
============================================================================= */
/*
TABLE_DEFINITION
  - id          : string (UUID inferred) [PK]
  - id_producto : string | null          -- FK -> catalogo_productos.id
  - zona        : string                 -- observed heavily: Zacatecas
  - precio_final: number

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK listas_precios_id_producto_fkey -> catalogo_productos(id)

BUSINESS ROLE
  - Geographic price matrix used by POS, auditoría cobranza, and valuation KPIs.
*/

/* =============================================================================
TABLE: public.recetas_produccion
============================================================================= */
/*
TABLE_DEFINITION
  - id                    : string (UUID inferred) [PK]
  - id_producto_terminado : string | null    -- FK -> catalogo_productos.id
  - id_insumo             : string | null    -- FK -> catalogo_productos.id
  - cantidad_requerida    : number

PRIMARY_KEY
  - id

RELATIONSHIP_GRAPH
  - FK recetas_produccion_id_producto_terminado_fkey -> catalogo_productos(id)
  - FK recetas_produccion_id_insumo_fkey -> catalogo_productos(id)

BUSINESS ROLE
  - BOM: production posting inserts PRODUCCION for finished goods and TRASPASO
    outflows for required inputs (ADMIN as inventory owner).
*/

/* =============================================================================
MIGRATION NOTES (CONFIRMED + V13)
============================================================================= */
/*
Migration: supabase/tkt-051-status-symmetry.sql (inventario_ledger)
  1) Renamed inventario_ledger.estado -> status (if old column existed).
  2) Dropped old status/estado check constraints dynamically.
  3) Added CHECK: status IN ('ACTIVO', 'ANULADO')

V13 hardening (finanzas_ledger — target state):
  - finanzas_ledger_status_check: status IN ('ACTIVO', 'ANULADO')
  - Backfill: APPROVED -> ACTIVO where economically effective; ANULADO unchanged.
  - creado_por column (or rename from usuario_creador) on both ledgers for audit.

WHY IT MATTERS:
  - Single status dialect eliminates configuration drift between UI, KPIs, and DB.
  - Enables uniform annulment (UPDATE status='ANULADO') without DELETE.
  - creado_por enables zero-trust ownership on anulaciones.
*/

/* =============================================================================
SUPABASE ACCESS PATTERN SUMMARY (from codebase calls)
============================================================================= */
/*
High-frequency read/write tables:
  entidades, cuentas_financieras, transacciones_tickets, ticket_detalles,
  inventario_ledger, finanzas_ledger, catalogo_productos, listas_precios,
  recetas_produccion

Architectural implication:
  - Database is event backbone, not mutable balance snapshot.
  - Dashboards replay ledger + status + Account_Firewall (admin cuenta set).
  - All operational writes use status='ACTIVO'; void via status='ANULADO'.
*/

/* =============================================================================
RECOMMENDED HARDENING TODOs (schema-level)
============================================================================= */
/*
1) Regenerate types/database.ts after creado_por rename (if not already applied).
2) Formalize finanzas_ledger.tipo_movimiento CHECK from approved business glossary.
3) Formalize inventario_ledger.tipo_movimiento CHECK (INVENTARIO_TIPOS_MOVIMIENTO).
4) Formalize inventario_ledger.cubeta CHECK ('PAGADO','CONSIGNADO').
5) COMMENT ON COLUMN for id_entidad_relacionada, id_entidad_origen/destino, creado_por.
6) Index inventario_ledger (status, notas) for ticket cascade annulment lookups.
*/
