> ## ⚠️ ADVERTENCIA: este documento es ASPIRACIONAL, no descriptivo
>
> Lo que sigue describe una arquitectura multi-agente (LangGraph, E2B, Aider headless,
> Playwright MCP, circuit breakers, "16-Hour Autonomous Software Factory") **que NO existe
> en este repositorio**. Ninguno de esos componentes esta instalado, configurado ni corriendo.
> Es un diseno deseado, escrito antes de construir; no un mapa del sistema real.
>
> **No tomes nada de aqui como estado actual del ERP.** Si eres un agente y este archivo
> contradice al codigo, el que esta mal es este archivo.
>
> El mapa verificado del sistema real es **`docs/MAPA_ERP_v001_2026-09-01.md`**.
>
> Se conserva por su valor de intencion de diseno. Revisado el 2026-09-02.

```markdown
# AGENTS.md: 16-Hour Autonomous Software Factory Configuration

**SYSTEM DIRECTIVE:** This file constitutes the core routing, memory, and execution protocols for the Hierarchical Multi-Agent Swarm. All sub-agents must adhere to the defined strict decoupling, zero-trust governance, and autonomous loop mechanics. Failure to meet programmatic completion promises will trigger circuit breakers.

---

## 1. SWARM HIERARCHY & HANDOFF PROTOCOLS

The architecture relies on strict separation of concerns. Agents must never cross functional boundaries.

### [The Human CEO] (Product Owner)
* **Role:** Strategy provider and ultimate adjudicator.
* **Responsibilities:** Provides high-level business requirements and double-ledger accounting rules.
* **Handoff Protocol:** Intervenes *only* when the orchestrator's circuit breaker escalates to the `OPEN` state due to unresolvable errors, or to approve critical production merges.

### [The Strategist / Orchestrator] ("El Estratega v12.0")
* **Role:** Master Router and Quality Gatekeeper.
* **Framework:** Built on stateful, graph-based orchestration (e.g., LangGraph) for durable checkpointing and time-travel debugging.
* **Responsibilities:** Decomposes Epics into atomic, verifiable tickets. Enforces Zero-Trust sandboxing by blocking destructive commands.
* **Handoff Protocol:** Uses an asynchronous `Assign` pattern to spawn isolated worker threads. Monitors Terminal IDs. Halts sub-agents that violate interface contracts.

### [Aider CLI] (Headless Coder - DeepSeek V3.2)
* **Role:** Primary Implementation Engine.
* **Responsibilities:** Executes code edits, API integrations, and database migrations.
* **Constraints:** Must operate under strict token limits using a "Repo Map" for localized context.
* **Execution Rule:** Runs inside the "Ralph Wiggum Loop" (try, fail, read logs, fix). 
* **Circuit Breaker:** Fails fast. Maximum of 3 retries per identical error (State Transition: `CLOSED` → `HALF_OPEN` → `OPEN`).

### [QA / MCP Agent] (Automated Tester)
* **Role:** Verification and End-to-End Test Engine.
* **Responsibilities:** Validates Next.js UI rendering and Supabase state consistency.
* **Execution Rule:** Utilizes Playwright to verify DOM elements via the *accessibility tree*—not pixel-based screenshots—ensuring deterministic interaction.
* **Handoff Protocol:** If a test fails, generates machine-readable JSON bug reports and execution logs, passing them back to the Orchestrator for task re-assignment.

---

## 2. REQUIRED MCP SKILLS (TOOL SERVERS)

The Swarm must connect to the following Model Context Protocol (MCP) servers to interact securely with the ERP environment:

1. **Postgres / Supabase MCP:** 
   * **Function:** Introspection of database schemas, execution of `EXPLAIN ANALYZE` for performance, and verification of double-ledger Row-Level Security (RLS) policies. Ensures $ \sum debits + \sum credits = 0 $ constraints are met before commits.
2. **Playwright MCP:**
   * **Function:** Headless browser automation. Exposes the browser's accessibility tree as structured data, enabling the QA Agent to click, fill, and assert DOM states deterministically without fragile visual models.
3. **Git / GitHub MCP:**
   * **Function:** Version control management. Enables branch creation, pull request generation, and automated merge conflict resolution.
4. **Filesystem / E2B MCP:**
   * **Function:** Provides a fault-tolerant, isolated execution sandbox. Prevents destructive commands from corrupting the host machine while running long builds (`npm run build`) or test suites.

---

## 3. MEMORY & STATE (LIQUID MEMORY)

To prevent "Context Rot" and token bloat during 16-hour autonomous runs, conversational history must be routinely compressed and discarded. 

* **Git as the Single Source of Truth (SSOT):** Ephemeral message queues are forbidden. Git history acts as the "Liquid Memory" of the system. 
* **State Handoff:** When Aider updates a Supabase schema, it must commit the updated types/OpenAPI spec. The Playwright QA Agent reads this commit diff as the ultimate ground truth for its testing assertions.
* **Scar Memory Persistence:** Failed code approaches and associated error logs must be hashed and stored in local vector memory (e.g., SQLite/AgentDB). Before executing a new loop, agents must verify they are not repeating a known "Scar".

---

## 4. THE CONTINUOUS LOOP (THE COMPLETION PROMISE)

Autonomous execution is governed by the programmatic "Ralph Wiggum" pipeline. Agents cannot exit a task autonomously based on "vibe" or probabilistic confidence; they must prove completion.

* **The Stop Hook Rule:** A subprocess interceptor blocks the agent from exiting. If the task fails, the hook automatically injects the error log and forces a retry with a fresh context window.
* **The Completion Promise:** The loop terminates **ONLY** when the agent outputs a highly specific, pre-defined XML token explicitly requested in the prompt (e.g., `<promise>ALL_ERP_TESTS_PASSING</promise>`).
* **Repetition Entropy Halting:** If the agent consumes its token budget without reducing the error count, or attempts the exact same failing fix 3 times, the loop is forcibly killed and rolled back to the last stable Git commit.
```