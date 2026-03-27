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

### [ ] TKT-004: Contexto Global de Fechas (Layout Wrapper)
- **Objetivo Estratégico:** Implementar un selector de fechas de nivel superior (Top Bar) que envuelva la aplicación e inyecte el rango de tiempo seleccionado a todos los dashboards.
- **Reglas de Negocio (Context):** Crear un React Context (`DateFilterContext`) con opciones: "Hoy", "Este Mes", "Trimestre", "Personalizado". El `TopBar` actualizará este estado.
- **Archivos a Modificar:** `app/dashboard/layout.tsx`, `components/providers/DateFilterProvider.tsx`, `components/ui/TopBar.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint`. Playwright assertion: Seleccionar "Este Mes" en el Header asegura que la URL o el estado global se actualiza, `expect(await page.locator('#date-filter-display').innerText()).toContain('Este Mes');`.

### [ ] TKT-005: Recálculo Dinámico de Analíticas (Dashboard Utils)
- **Objetivo Estratégico:** Conectar el filtro de fechas global con las funciones matemáticas del servidor para recalcular ingresos, egresos y deudas al vuelo.
- **Reglas de Negocio (Context):** Las funciones `getMovimientos()`, `getTransaccionesTickets()` y `calcularKPIs()` en `lib/dashboard-utils.ts` deben aceptar opcionalmente `fechaInicio` y `fechaFin`. Las consultas a Supabase usarán `.gte('fecha_movimiento', fechaInicio).lte('fecha_movimiento', fechaFin)`.
- **Archivos a Modificar:** `lib/dashboard-utils.ts`, `app/dashboard/general/page.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint && npx tsc`. La aplicación compila sin errores de Server Components y las sumatorias cambian al modificar las fechas.

## EPIC 3: Módulo Analítico Avanzado (Gráficas y KPIs Extendidos)

### [ ] TKT-006: Gráficas de Pastel y Categorización Financiera
- **Objetivo Estratégico:** Proveer desglose visual de ingresos y egresos por categoría dentro de la pestaña de Finanzas.
- **Reglas de Negocio (Context):** Renderizar gráficas (usando Recharts ligero o barras Tailwind) bajo las tarjetas de KPI en `/dashboard/finanzas`. Extraer agrupaciones del `finanzas_ledger` por `categoria` (Renta, Nómina, Insumos, Fuga Fiscal IVA/IEPS). Omitir la "Utilidad Neta" compleja por ahora para evitar fricción cognitiva.
- **Archivos a Modificar:** `app/dashboard/finanzas/page.tsx`, `components/dashboard/CategoryPieChart.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** Playwright assertion: `await expect(page.locator('[data-testid="category-pie-chart"]')).toBeVisible();` comprobando que las categorías maestras se renderizan en el DOM.

### [ ] TKT-007: Ranking de Distribuidores Geográfico y Envejecimiento de Deuda
- **Objetivo Estratégico:** Separar la red por zona geográfica (Zacatecas vs Foráneo) y aplicar el semáforo de envejecimiento de deuda a los Locales y Distribuidores.
- **Reglas de Negocio (Context):** En `/dashboard/distribuidores`, crear dos secciones de tabla: "Directos" e "Indirectos". Agregar columna de estado agrupado por `zona`. El semáforo de deuda evalúa `fecha_actual - fecha_ultimo_abono_completado` (0-7d Verde, 8-15d Amarillo, 16+d Rojo). Agregar botón de URL para `ubicacion_maps`.
- **Archivos a Modificar:** `app/dashboard/distribuidores/page.tsx`, `lib/network-utils.ts`
- **Criterio de Aceptación (Promesa de Finalización):** Playwright assertion: `await expect(page.locator('td:has-text("Zacatecas")')).toBeVisible(); await expect(page.locator('.bg-red-500.rounded-full')).toBeVisible();` (verificando la existencia de semáforos de alerta).

### [ ] TKT-008: Promedios de BOM y Segmentación de Inventario
- **Objetivo Estratégico:** Desglosar el inventario en tarjetas separadas para Botellas y Pastas, calculando el consumo promedio de componentes.
- **Reglas de Negocio (Context):** En `/dashboard/inventario`, separar los productos de `tipo === 'TERMINADO'` en dos KPIs: "Total Botellas" (SKUs que incluyan 'ml') y "Total Pastas" (SKUs que incluyan 'kg'). Añadir un botón táctico exclusivo para registrar "Merma" (Logística Inversa manual).
- **Archivos a Modificar:** `app/dashboard/inventario/page.tsx`
- **Criterio de Aceptación (Promesa de Finalización):** `npm run lint`. Playwright assertion: `await expect(page.locator('text="Total Botellas"')).toBeVisible(); await expect(page.locator('button:has-text("Merma")')).toBeVisible();`
