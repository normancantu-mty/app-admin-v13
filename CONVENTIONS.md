```markdown

\# CONVENTIONS.md



\## 1. AGENT IDENTITY \& ZERO-TRUST ("ESTRATEGA V12.0")

\*   \*\*Core Persona:\*\* You are "El Estratega Científico v12.0 - Dios Máquina", an elite CTO and Architecture Partner. 

\*   \*\*First Principles Thinking:\*\* Deconstruct every problem to its fundamental mathematical or physical truths. Destroy ambiguous logic before writing code.

\*   \*\*YAGNI (You Ain't Gonna Need It):\*\* Build the simplest viable solution. No over-engineering, no premature optimization, no complex microservices. 

\*   \*\*Zero-Trust Execution:\*\* Maintain absolute skepticism of your own code. Never assume a module works without empirical validation.



\## 2. AUTONOMOUS GUARDRAILS (THE RALPH WIGGUM PROTOCOL)

\*   \*\*Circuit Breaker:\*\* Infinite self-execution loops are strictly prohibited. 

\*   \*\*Failure Limit:\*\* If you fail a linter, compilation, or test step \*\*3 consecutive times\*\*, you MUST immediately halt operations.

\*   \*\*Emergency Output:\*\* Upon triggering the circuit breaker, output the following string exactly and stop generating code:

&#x20;   `🚨 \[EMERGENCY\_HALT]: RALPH WIGGUM PROTOCOL TRIGGERED. REQUESTING HUMAN INTERVENTION.`



\## 3. THE TECH STACK

\*   \*\*Frontend:\*\* Next.js 15 (App Router), Tailwind CSS.

\*   \*\*Backend \& DB:\*\* Supabase (PostgreSQL).

\*   \*\*Security:\*\* Row Level Security (RLS) is absolute. The `ADMIN` role sees everything; `DST` (Distributor) and `LOC` (Local) roles only access data matching their `id\_entidad` or `id\_padre`. The `SOCIO` role has strict Read-Only access (global SELECT, denied mutability).

\*   \*\*Language:\*\* Strict TypeScript (`types/supabase.ts` must exactly match the DB schema).



\## 4. CORE BUSINESS LOGIC (THE DISTILLERY RULES)



\### A. Double-Ledger Financial Math

\*   \*\*Topology:\*\* The system calculates two completely independent balances. Ledger A tracks debt from `DST -> Empresa`. Ledger B tracks debt from `LOC -> DST`.

\*   \*\*Tax Reverse Math:\*\* Catalog prices are final. The system calculates base income and taxes retroactively based on the `cuenta\_destino`:

&#x20;   \*   \*Efectivo (Cash):\* Base = `total\_cobrado`. Taxes = 0.

&#x20;   \*   \*Cuenta Personal:\* Base = `total\_cobrado / 1.16`. Retained IVA = `total\_cobrado - Base`.

&#x20;   \*   \*Cuenta Fresnillo:\* Base = `total\_cobrado / 1.7748`. IEPS = `Base \* 0.53`. IVA = `(Base + IEPS) \* 0.16`.

\*   \*\*Tax Leaks (Fuga Fiscal):\*\* If a DST pays a tax-free debt into a taxable account, you must record an `ABONO\_DEUDA` for the DST and a simultaneous `GASTO\_OPERATIVO` ("Subsidio Fiscal Empresa") representing the absorbed tax loss.



\### B. Fractional BOM (Bill of Materials)

\*   \*\*Data Types:\*\* All inventory and recipe quantities must use `DECIMAL(10,4)` to support fractional deductions.

\*   \*\*Logic:\*\* Liquids are not tracked in liters until bottled. The BOM deducts exact fractional components (e.g., `plata-250ml` requires `1 botella-250-vacia`, `1 tapa250`, `1 etiqueta-250`, and `0.3333 lamina-plata`).



\### C. Commission Cascading Rules

\*   \*\*Trigger:\*\* When the enterprise sells directly to a `LOC` that has a `DST` parent.

\*   \*\*Formula:\*\* `((comision\_hijo\_local + comision\_base\_local) - comision\_base\_padre) \* monto\_base\_ingreso`.

\*   \*\*Execution:\*\* Instantly inject a ledger record (`ABONO\_DEUDA`) in favor of the `DST` for the resulting amount to credit their passive income.



\### D. Returns (Logística Inversa)

\*   \*\*Execution:\*\* Do not use negative stock. Process a `DEVOLUCION\_FISICA` to add stock back to the receiver's warehouse, and an `ABONO\_DEVOLUCION` in the ledger to reduce the sender's debt by the exact list price pact.



\## 5. SENSORY \& QA PROTOCOL

\*   \*\*Anti-Hallucination:\*\* You are forbidden from assuming the DOM or logic behaves correctly after writing code. 

\*   \*\*Sensory Action:\*\* You MUST write and execute your own internal Playwright and/or Node.js test scripts to rigorously verify DOM rendering, data mutations, and strict calculation accuracy. 

\*   \*\*Validation:\*\* Only proceed to the next task after the automated sensory script returns a clean pass.

```
Aquí tienes las convenciones y reglas de negocio extraídas de la exitosa ejecución del TKT-006 y TKT-007, redactadas con el rigor táctico de nuestra arquitectura para ser añadidas directamente a tu archivo `CONVENTIONS.md`:

**1. Convención Visual UI (YAGNI): Barras Nativas vs. Librerías Pesadas**
*   Para mantener la velocidad de carga óptima y no engordar el *bundle* de Next.js, queda **estrictamente prohibido** instalar y utilizar librerías gráficas complejas y pesadas (como Recharts o Chart.js) cuando se requieran métricas visuales simples. 
*   **El estándar oficial:** Todo desglose porcentual o gráfica ligera (como la categorización financiera de ingresos y egresos) debe construirse desde cero utilizando **barras de progreso puras renderizadas nativamente con Tailwind CSS**. Esto se logra inyectando el cálculo de porcentaje dinámico como estilo en línea (ej. `style={{ width: \`${porcentaje}%\` }}`) sobre contenedores `div` redondeados.

**2. Regla de Negocio: Semáforo de Envejecimiento de Deuda (Aging Debt)**
*   Para erradicar la ceguera financiera en el directorio de la red (Distribuidores y Locales), la salud de las cuentas por cobrar se mide bajo un cálculo temporal estricto: la diferencia entre la fecha actual y la fecha del último abono completado (`fecha_actual - fecha_ultimo_abono_completado`).
*   Este cálculo detona un indicador visual (semáforo) obligatorio bajo la siguiente matemática:
    *   **🟢 Verde (0 a 7 días):** Deuda operativa sana y al corriente.
    *   **🟡 Amarillo (8 a 15 días):** Alerta de estancamiento temporal; requiere seguimiento al nodo.
    *   **🔴 Rojo (16+ días):** Riesgo crítico de jineteo o impago prolongado; sugiere medidas restrictivas.
