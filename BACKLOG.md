# BACKLOG.md

## EPIC 1: Recurrent Billing & Sub-Admin Security (Fase Beta - Core Operativo)

### [x] TKT-001: Implementación del Rol SUB-ADMIN y Prevención de Borrado
- **Objetivo Estratégico:** Habilitar un rol de supervisión ("SUB-ADMIN") con acceso de lectura global que no pueda confirmar abonos pendientes ni eliminar registros.
- **Reglas de Negocio (Context):** La tabla `entidades` debe aceptar el rol `SUB-ADMIN`. A diferencia del `SOCIO` (que está atrapado en el Muro de Niebla), el `SUB-ADMIN` puede navegar todos los dashboards pero el botón "Aprobar/Rechazar" en `PendingApprovalsPanel.tsx` y la capacidad de borrar tickets deben estar ocultos. El backend (`app/api/finanzas/aprobaciones/route.ts`) debe rechazar peticiones de `SUB-ADMIN`.
- **Archivos a Modificar:** `types/database.ts`, `app/dashboard/finanzas/PendingApprovalsPanel.tsx`, `app/api/finanzas/aprobaciones/route.ts`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint && npx tsc` pasa sin errores de tipado. Playwright assertion: `await expect(page.locator('button:has-text("Aprobar")')).not.toBeVisible()` al iniciar sesión como SUB-ADMIN.

### [x] TKT-002: Borrado Múltiple con Registro de Auditoría (Admin-Only)
- **Objetivo Estratégico:** Permitir al ADMIN borrar movimientos erróneos de Finanzas e Inventario de forma masiva, dejando un rastro inmutable en la tabla de auditoría.
- **Reglas de Negocio (Context):** Al seleccionar múltiples filas en `/dashboard/finanzas` y presionar "Eliminar", se ejecuta una Server Action que: 1) Registra el `json_estado_anterior` en `auditoria_logs` con `accion: 'DELETE'` y el `usuario_id` del ADMIN. 2) Elimina los registros de `finanzas_ledger` o `transacciones_tickets`.
- **Archivos a Modificar:** `app/dashboard/finanzas/page.tsx`, `app/actions/audit.ts`
- **Criterio de Aceptación (Promesa de Finalización):** Ejecutar `npm run lint`. Playwright assertion: Al eliminar, verificar en base de datos: `const log = await supabase.from('auditoria_logs').select().eq('accion', 'DELETE'); expect(log.data.length).toBeGreaterThan(0);`

### [x] TKT-003: Motor de Gastos Recurrentes (Configuración UI)
- **Objetivo Estratégico:** Crear la interfaz para registrar pagos fijos (ej. Contador $800, Renta, Servicios) automatizados.
- **Reglas de Negocio (Context):** En el formulario de "Nuevo Movimiento" (`/dashboard/finanzas/nuevo`), si se selecciona "Egreso", mostrar un checkbox "Gasto Recurrente". Si se activa, desplegar inputs para "Frecuencia (Mensual/Quincenal)" y "Duración en Meses (o Indefinido)". Esto guardará el movimiento con `es_recurrente: true` en `finanzas_ledger`.
- **Archivos a Modificar:** `app/dashboard/finanzas/nuevo/page.tsx`, `types/database.ts`
- **Criterio de Aceptación (Promesa de Finalización):** Playwright assertion: `await page.check('input[name="es_recurrente"]'); await expect(page.locator('select[name="frecuencia"]')).toBeVisible();`

## EPIC 2: Ojo de Dios - Global "Power BI" Filters (Inteligencia de Negocio)

### [x] TKT-004: Contexto Global de Fechas (Layout Wrapper)
- **Objetivo Estratégico:** Implementar un selector de fechas de nivel superior (Top Bar) que envuelva la aplicación e inyecte el rango de tiempo seleccionado a todos los dashboards.
- **Reglas de Negocio (Context):** Crear un React Context (`DateFilterContext`) con opciones: "Hoy", "Este Mes", "Trimestre", "Personalizado". El `TopBar` actualizará este estado.
- **Archivos a Modificar:** `app/dashboard/layout.tsx`, `components/providers/DateFilterProvider.tsx`, `components/ui/TopBar.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint`. Playwright assertion: Seleccionar "Este Mes" en el Header asegura que la URL o el estado global se actualiza, `expect(await page.locator('#date-filter-display').innerText()).toContain('Este Mes');`.

### [x] TKT-005: Recálculo Dinámico de Analíticas (Dashboard Utils)
- **Objetivo Estratégico:** Conectar el filtro de fechas global con las funciones matemáticas del servidor para recalcular ingresos, egresos y deudas al vuelo.
- **Reglas de Negocio (Context):** Las funciones `getMovimientos()`, `getTransaccionesTickets()` y `calcularKPIs()` en `lib/dashboard-utils.ts` deben aceptar opcionalmente `fechaInicio` y `fechaFin`. Las consultas a Supabase usarán `.gte('fecha_movimiento', fechaInicio).lte('fecha_movimiento', fechaFin)`.
- **Archivos a Modificar:** `lib/dashboard-utils.ts`, `app/dashboard/general/page.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint && npx tsc`. La aplicación compila sin errores de Server Components y las sumatorias cambian al modificar las fechas.

## EPIC 3: Módulo Analítico Avanzado (Gráficas y KPIs Extendidos)

### [X] TKT-006: Gráficas de Pastel y Categorización Financiera
- **Objetivo Estratégico:** Proveer desglose visual de ingresos y egresos por categoría dentro de la pestaña de Finanzas.
- **Reglas de Negocio (Context):** Renderizar gráficas (usando Recharts ligero o barras Tailwind) bajo las tarjetas de KPI en `/dashboard/finanzas`. Extraer agrupaciones del `finanzas_ledger` por `categoria` (Renta, Nómina, Insumos, Fuga Fiscal IVA/IEPS). Omitir la "Utilidad Neta" compleja por ahora para evitar fricción cognitiva.
- **Archivos a Modificar:** `app/dashboard/finanzas/page.tsx`, `components/dashboard/CategoryPieChart.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** Playwright assertion: `await expect(page.locator('[data-testid="category-pie-chart"]')).toBeVisible();` comprobando que las categorías maestras se renderizan en el DOM.

### [x] TKT-007: Ranking de Distribuidores Geográfico y Envejecimiento de Deuda
- **Objetivo Estratégico:** Separar la red por zona geográfica (Zacatecas vs Foráneo) y aplicar el semáforo de envejecimiento de deuda a los Locales y Distribuidores.
- **Reglas de Negocio (Context):** En `/dashboard/distribuidores`, crear dos secciones de tabla: "Directos" e "Indirectos". Agregar columna de estado agrupado por `zona`. El semáforo de deuda evalúa `fecha_actual - fecha_ultimo_abono_completado` (0-7d Verde, 8-15d Amarillo, 16+d Rojo). Agregar botón de URL para `ubicacion_maps`.
- **Archivos a Modificar:** `app/dashboard/distribuidores/page.tsx`, `lib/network-utils.ts`
- **Criterio de Aceptación (Promesa de Finalización):** Playwright assertion: `await expect(page.locator('td:has-text("Zacatecas")')).toBeVisible(); await expect(page.locator('.bg-red-500.rounded-full')).toBeVisible();` (verificando la existencia de semáforos de alerta).

### [x] TKT-008: Promedios de BOM y Segmentación de Inventario
- **Objetivo Estratégico:** Desglosar el inventario en tarjetas separadas para Botellas y Pastas, calculando el consumo promedio de componentes.
- **Reglas de Negocio (Context):** En `/dashboard/inventario`, separar los productos de `tipo === 'TERMINADO'` en dos KPIs: "Total Botellas" (SKUs que incluyan 'ml') y "Total Pastas" (SKUs que incluyan 'kg'). Añadir un botón táctico exclusivo para registrar "Merma" (Logística Inversa manual).
- **Archivos a Modificar:** `app/dashboard/inventario/page.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint`. Playwright assertion: `await expect(page.locator('text="Total Botellas"')).toBeVisible(); await expect(page.locator('button:has-text("Merma")')).toBeVisible();`

## EPIC 4: Logística Inversa e Inteligencia de Retención (Fase Delta) - [CERRADA]

### [x] TKT-009: Logística Inversa y Mermas (Double-Ledger estricto)
- **Objetivo Estratégico:** Dar vida al botón "Registrar Merma" pospuesto por YAGNI, permitiendo capturar mermas de producción y devoluciones de distribuidores con impacto contable dual.
- **Reglas de Negocio (Context):** Transacción doble (Cross-Ledger) mediante RPC en Supabase para asegurar ACID compliance. Inserta en `inventario_ledger` con tipo `MERMA` o `DEVOLUCION_FISICA`. Si es devolución, inyecta `ABONO_DEVOLUCION` en `finanzas_ledger`.
- **Estado:** Completado.

### [ ] TKT-010: Selector de Fechas Global Personalizado
- **Objetivo Estratégico:** Liquidar la deuda técnica del TopBar global, habilitando el rango de fechas libre (Doble Calendario) que se pospuso en la EPIC 2.
- **Reglas de Negocio (Context):** Modificar el `TopBar.tsx` para desplegar dos inputs de fecha (Start Date / End Date) cuando se seleccione "Personalizado". Formatear y guardar este rango en la cookie global `global_rango`.
- **Estado:** Congelado (Por principio YAGNI).

### [x] TKT-011: Valorización Dinámica de Bodega (Capital Inmovilizado SSR)
- **Objetivo Estratégico:** Erradicar el punto ciego financiero del inventario mostrando en tiempo real la cantidad de capital (MXN) inmovilizado en botellas y materias primas.
- **Reglas de Negocio (Context):** En el Dashboard de Inventario, iterar el stock actual calculado de cada producto y multiplicarlo por su `costo_unitario` extraído del catálogo. Soportar precisión `DECIMAL(10,4)` para fracciones de BOM (láminas de plata).
- **Estado:** Completado.

### [x] TKT-012: CRM Táctico: Semáforo de Abandono y Botón de Seguimiento Aislado
- **Objetivo Estratégico:** Proveer inteligencia comercial detectando distribuidores inactivos (para prevención de fuga) y facilitar el seguimiento táctico.
- **Reglas de Negocio (Context):** En el Dashboard de la Red, encender un semáforo de inactividad (Verde < 12 días, Amarillo 12-15 días, Rojo > 15 días). Actualizar el `ultimo_seguimiento` de la entidad mediante un botón táctico aislado en la base de datos sin contaminar el ledger financiero.
- **Estado:** Completado.

## EPIC 5: Estabilización de Double-Ledger y Quick Wins

### FASE 1: QUICK WINS
- [X] TKT-013: Botón de Retorno en Vista de Ticket (Añadir botón volver a dashboard/general en ticket/[id]).
- [X] TKT-023: Limpieza UI Red (Ocultar columnas innecesarias en tabla distribuidores y añadir campo Ubicación Maps en formulario nuevo).
- [X] TKT-026: Filtro "Histórico/Todo" (Añadir opción TODO en DateFilterContext para omitir límites de fecha en servidor).
- [X] TKT-028: Fix de Historial Ciego (Inyectar export const dynamic = 'force-dynamic' en vista distribuidor para romper caché).
- [X] TKT-027: Desglose Avanzado DST (Separar visualmente Total Ganado, Saldo Pendiente bruto y Jineteo neto en vista distribuidor).

### FASE 2: ALTO IMPACTO (CERO FRICCIÓN)
- [x] TKT-020: Borrado Autónomo con Candado Temporal (Permitir borrar movimientos propios solo si fecha_actual - created_at <= 48h).
- [X] TKT-019: Auditoría usuario_creador (Capturar ID en Server Actions e inyectarlo en registros contables).
- [X] TKT-021: Catálogo Estático Read-Only (Vista tabla de constantes de SKUs y precios, sin CRUD).
- [X] TKT-014: Subcategorías Estáticas (Expandir diccionarios/ENUMs para ruteo de subcategorías).

### FASE 3: CORE FINANCIERO
- [X] TKT-015: Selector de Cuenta en Captura Manual (Ruteo obligatorio: Efectivo, Personal, Fresnillo).
- [x] TKT-016: Transferencias Internas Cross-Account (Asiento doble para mover dinero sin afectar balance neto).
- [X] TKT-024 & TKT-025: Ajuste Matemático de Comisiones (Cálculo de riesgo DST sin comisión y sobre precio base neto).
- [X] TKT-018: KPIs de Saldos Actuales (Sumatoria histórica de liquidez por cuenta en el Dashboard).
- [x] TKT-029,Sincronización de Tipos (The Ghost Fix),Eliminar todos los // @ts-ignore en Server Actions regenerando types/database.ts desde el esquema actual de Supabase.
- [x] TKT-030,Refactor de Logística Inversa (RPC to Action),"Migrar el Stored Procedure registrar_logistica_inversa a una Server Action de Next.js para inyectar usuario_creador y evitar firmas ""Sistema""."
- [x] TKT-031,Whitelist Dinámica de UI,"Refactorizar TIPOS_RENDERIZABLES para que se alimente de los ENUMs de la base de datos, eliminando la invisibilidad de nuevos tipos de movimiento."
- [X] TKT-034: Sincronización de Deuda DST (Double-Ledger Parity). Alinear el cálculo de "Saldo Pendiente" y el historial del DST para que reflejen el monto neto sin impuestos (Base), erradicando el desfase con el ledger financiero.
- [X] TKT-035: Transparencia Fiscal UI (POS & Tickets). Ajustar la interfaz del POS y la vista del ticket para mostrar explícitamente el cálculo inverso (Neto vs Bruto) cuando el comprador es un intermediario libre de impuestos (DST).

## EPIC 6: Visibilidad Logística, Control Diario y Double-Ledger Avanzado

### FASE 1: QUICK WINS & REPARACIÓN CRÍTICA (Desbloqueo Operativo)
- [ ] TKT-036: Hotfix Merma Schema (`id_entidad_relacionada` error en `inventario_ledger`).
- [ ] TKT-037: Admin God-Mode (El Admin puede anular registros sin importar la ventana de tiempo).
- [ ] TKT-038: Aislamiento de Liquidez (Desvincular las tarjetas del Dashboard General de los filtros de fecha).
- [ ] TKT-039: Corrección Visual Ticket (Cambiar título a FRESNILLO / DESTILADO DE CHILE).
- [ ] TKT-040: Unlock POS Fresnillo (Permitir cuenta Fresnillo cuando el vendedor es DST).
- [ ] TKT-041: Restricciones Visuales Rol SOCIO (Muro de Cristal: Ver tabla red sin hipervínculos ni botones).
- [ ] TKT-042: CRUD Distribuidores (Habilitar edición de datos para LOC y DST).

### FASE 2: UI/UX REFACTOR & VISIBILIDAD (Impacto Visual)
- [ ] TKT-043: Fusión de Tablas Red (Unificar foráneos/locales usando etiquetas DST/LOC y ZAC/FOR. Renombrar "Acciones").
- [x] TKT-043.5: Fusión de Tablas Red y Filtros Globales (Unificada en una sola tabla cliente. Agregada barra de búsqueda por nombre/teléfono y filtro por roles).
- [ ] TKT-044: Semáforo de Días (Sustituir color estático por el contador numérico de "Días sin seguimiento").
- [ ] TKT-045: Restructuración de Tarjetas Inventario (Reemplazar tarjetas inútiles por Stock Interactivo de Producto Terminado).s
- [x] TKT-046: Ruteo Base del Distribuidor (Aislamiento Zero-Trust: Al loguearse un DST, se le redirige a su propia red, ocultando al Admin y otras redes. Se corrigió el Redirect Loop).

### FASE 3: CORE FINANCIERO Y LOGÍSTICO (Double-Ledger Avanzado)
- [x] TKT-048: Reingeniería Financiera Multi-Tenant
  - *Infraestructura:* Eliminado `CHECK CONSTRAINT` de Supabase. Creadas `cuentas_financieras` únicas (`CTA-[Nombre]`) para cada Entidad.
  - *Migración de Saldo (Legacy Bridge):* Lógica de consolidación histórica. DST ve la suma de sus movimientos + movimientos de locales hijos + respaldo en cuenta Admin.
- [x] TKT-049: Refactor POS Multi-Tenant (Enrutar nuevas ventas a la cuenta específica `CTA-` del vendedor en lugar de la caja única del Admin).
- [ ] TKT-050: Tarjetas de Perfil (Conectar "Total Ganado" al DateFilter global, agregar "Saldo de Locales hijos").
- [ ] TKT-054: Modo CONCESIÓN en POS (Generar salida de inventario y deuda, pero NO afectar el ledger de liquidez financiera).
- [ ] TKT-047: Catálogo Dinámico DST (Tabla de cascada de precios: Base, Comisión, Hijo, IEPS/IVA, Foráneo/Local).
- [ ] TKT-057: Corte de Inventario Físico y Emisión de Ticket ("Auditoría Local": Input de stock sobrante que calcula ventas, dicta el cobro exacto y genera recibo).
- [ ] TKT-058: Segregación Fiscal Contable (Desglosar ingresos netos e impuestos en finanzas_ledger en lugar de un solo monto global).

### FASE 4: GOBERNANZA E INFRAESTRUCTURA (Zero-Trust)
- [ ] TKT-051: Sistema de Anulación Contable (Cambiar Hard-Deletes a Soft-Deletes. Mantener registro histórico pero anular impacto matemático).
- [ ] TKT-055: Anulación UI para Distribuidores (Habilitar botones de anular para DSTs solo si `usuario_creador` = DST y < 24h).
- [ ] TKT-052: Paginación de Rendimiento (Limitar historiales a 15 rows + botón "Cargar Más").
- [ ] TKT-053: Nuevo Rol TRABAJADOR (Ventana de anulación de 15 min, bloqueo total a Finanzas, sin permisos de aprobación).