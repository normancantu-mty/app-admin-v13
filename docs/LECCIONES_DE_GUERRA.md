# LECCIONES_DE_GUERRA.md

## 1. EL INCIDENTE DEL MURO DE NIEBLA (Auth/Caché)
Durante la validación del TKT-002 y TKT-003, nos topamos con un bloqueo donde la sesión con el rol `ADMIN` no lograba visualizar los botones de mutación ni las casillas de selección en el dashboard de Finanzas. La lección estratégica aquí no fue un fallo de código, sino una trampa de infraestructura: Next.js 15 y su compilador Turbopack cachean estáticamente las páginas de los Server Components de forma agresiva. Al compilarse la página sin un usuario activo, el framework "congeló" visualmente el estado de la sesión en un falso 403 (sin permisos), entregando esa "foto vieja" repetidamente. 

Para aislar si el fallo era de la interfaz gráfica o de la lógica de autenticación, aplicamos una técnica de diagnóstico por "Fuerza Bruta". Volamos los candados manualmente inyectando `const canMutate = true;` y `const isAdmin = true;` directamente en el código. Este experimento forzó el renderizado de la UI, demostrando que la máquina sí había construido los componentes y aislando el problema puramente en la capa de estado.

## 2. LA TRAMPA DE LAS COOKIES EN TURBOPACK
Al intentar aprobar un movimiento en el panel de Finanzas, descubrimos el "Fantasma de las Cookies". Documentamos que, en el entorno de desarrollo local (Turbopack), los Server Components (`page.tsx`) y los Route Handlers (`route.ts` en la API) no siempre comparten el mismo contexto de cookies. Aunque la página reconocía al `ADMIN`, las peticiones `fetch` del cliente no adjuntaban la cookie de sesión de Supabase hacia la API, resultando en rechazos de seguridad (403).

Frente a este obstáculo, tomamos la decisión de aplicar un "Bypass de Lectura" en la API. Optamos tácticamente por la velocidad operativa sobre la pureza arquitectónica, quitando el candado de sesión únicamente para el método `GET` y manteniendo la seguridad de titanio en el método de escritura `POST`/`PATCH`. 

## 3. ALUCINACIONES DE INFRAESTRUCTURA (TKT-001)
El incidente de fuerza bruta reveló una mina terrestre oculta: el servidor colapsó silenciosamente con un `ReferenceError`. Al ejecutar el TKT-001, Aider alucinó e inyectó la línea `const currentUser = useCurrentUser()` dentro de `PendingApprovalsPanel.tsx`, un hook de cliente que jamás fue importado ni creado. Como la variable `isAdmin` estaba oculta por defecto, el panel no se renderizaba y el error se mantuvo en las sombras hasta que forzamos el acceso.

**Lección de Arquitectura:** En entornos de Server Components, no podemos confiar en que la IA gestione el estado global inventando hooks. La arquitectura debe forzar el paso de la autorización estrictamente como Server Props booleanos desde el servidor principal (ej. `isAdmin={isAdmin}`) hacia los componentes hijos, erradicando la dependencia de estados de cliente vulnerables a alucinaciones.

## 4. EL COSTO DE LA AGILIDAD
El saldo de esta sesión redefine la ingeniería de software moderna: logramos resolver tres tickets de alta complejidad arquitectónica (TKT-001, TKT-002 y TKT-003) operando un motor Double-Ledger en menos de 4 horas. Todo este despliegue táctico, que a una agencia tradicional le tomaría más de una semana, tuvo un costo operativo de API de apenas $0.40 USD.

## 5. EL PIVOTE DEL ESTADO GLOBAL (URL vs Cookies)
Intentamos construir el "Ojo de Dios" (filtro global de fechas) inyectando el estado directamente en los `searchParams` de la URL. En teoría, era un enfoque limpio para el SSR, pero la realidad operativa nos demostró lo contrario: al navegar por los enlaces fijos del menú lateral (`Layout`), Next.js destruía los parámetros de la URL, reseteando el filtro a su valor por defecto ("Este Mes") en cada salto entre módulos. 

**La Solución:** Ejecutamos un pivote arquitectónico agresivo hacia las Cookies de persistencia global. Al grabar el rango de fechas como un "tatuaje" en el navegador (`document.cookie` en el cliente) y leerlo nativamente desde el servidor (`cookies()`), logramos que el estado global sobreviviera a la navegación, aislando el "Ojo de Dios" de la volatilidad de las rutas.

## 6. LA TRAMPA DE NEXT.JS 15 (Promesas Asíncronas)
La migración a Next.js 15 esconde minas terrestres en su nueva física de servidor. Descubrimos a base de fallos que `searchParams` y `cookies()` ya no son funciones síncronas; ahora son estrictamente Promesas. Olvidar desempaquetarlas con un `await` provoca que el servidor ignore los cambios y devuelva datos congelados en caché.

A la par, sufrimos un *Client Boundary Error* devastador. En nuestro afán de leer la cookie de estado, ordenamos a la IA importar `next/headers` directamente en el `layout.tsx`. El compilador de Turbopack explotó porque el layout ya estaba contaminado con interactividad de cliente (`useState`), y las funciones de cabecera de Next.js son incompatibles con directivas *'use client'*. **Lección grabada a fuego:** Mantén la pureza del servidor; los componentes interactivos no deben tocar herramientas de SSR.

## 7. LA REGLA DE LOS 3 STRIKES DE AIDER
Fuimos testigos de la "Alucinación por Falta de Contexto" y el límite físico del motor de Aider. Al intentar reescribir la función `getMovimientos`, la máquina intentó aplicar bloques `SEARCH/REPLACE` a ciegas, adivinando la sintaxis original de nuestro archivo. Al fallar por un simple espacio o nombre de variable (`SearchReplaceNoExactMatch`), intentó adivinar otras dos veces hasta que el disyuntor de seguridad interno cortó la energía con un colapso rotundo: *"Only 3 reflections allowed, stopping"*.

**La Táctica Ganadora:** Queda estrictamente prohibido que la máquina intente hacer reemplazos a ciegas. La nueva directiva exige aplicar un Protocolo de Lectura Estricta: siempre debemos obligar a la IA a imprimir y leer el bloque de código actual para entender la estructura exacta en su memoria temporal antes de autorizarle emitir un comando de reescritura (`REPLACE`). Cero adivinanzas.

8. La Trampa de cookies() en Next.js 15 (Promesas Asíncronas) En la arquitectura de Next.js 15, la utilidad cookies() cambió físicamente y ahora es estrictamente una Promesa
. Olvidar desempaquetarla con un await (ej. const cookieStore = await cookies();) antes de pasársela al cliente de autenticación provocará que el servidor intente leer un paquete de datos cerrado. Esto rompe la sesión silenciosamente, devolviendo siempre al usuario como undefined (o INVITADO) y bloqueando el acceso a rutas protegidas
.
9. El Puente Obligatorio de Supabase SSR Queda prohibido intentar leer sesiones en Server Components usando una instancia global pre-configurada del cliente de Supabase (@supabase/supabase-js)
. Operar así deja al servidor "ciego", incapaz de inyectar las cookies recién leídas en sus cabeceras
. Es una obligación absoluta migrar a @supabase/ssr e importar createServerClient, instanciando un cliente nuevo por cada petición al que se le pasa explícitamente el "Cookie Store" resuelto
.
10. Colapso de Turbopack por Exportaciones Duplicadas en API Routes El compilador Turbopack es implacable y no perdona redundancias
. Durante la inyección de código, si un agente de IA se confunde y repite una directiva (como escribir export const dynamic = 'force-dynamic' en la línea 1 y luego en la 3), el servidor colapsará de inmediato con un Build Error fatal (the name dynamic is defined multiple times)
. La solución requiere la extirpación manual o un borrado exacto de la línea sobrante para devolverle la estabilidad al 
**16. Falla Silenciosa en Logística Inversa (RPC Constraints)**
*   **Incidente:** El stock no disminuía al registrar mermas pese a mostrar éxito visual en la interfaz.
*   **Diagnóstico First-Principles:** La función RPC de Supabase intentó insertar un valor negativo (`-ABS(p_cantidad)`) en el ledger. En una arquitectura Double-Ledger, la tabla de Postgres posee restricciones matemáticas estrictas (`CHECK cantidad >= 0`) que abortaron la transacción. Al estar la petición envuelta en un bloque `try/catch` en la Server Action, el servidor de Next.js se "tragó" el error del rollback de la base de datos sin reportarlo en la terminal, engañando al cliente.
*   **Resolución Zero-Trust:** Se reprogramó el RPC en SQL para insertar siempre valores absolutos (`ABS()`), delegando la lógica de suma o resta exclusivamente a la capa de lectura/cálculo del frontend. Además, se inyectó telemetría estricta (`console.error("🚨 [ERROR CRÍTICO SUPABASE RPC]:", error)`) dentro del `catch` de la Server Action para obligar al servidor a exponer las fallas de Supabase sin censura.

**17. Colapso Fatal por Client Boundary Error (`next/headers`)**
*   **Incidente:** Caída del compilador con el mensaje `Module not found: Can't resolve 'next/headers'`.
*   **Diagnóstico First-Principles:** Una utilidad de autenticación (`lib/auth-utils.ts`) importaba `cookies` desde `next/headers`, lo cual es una herramienta exclusiva de servidor (SSR). Al mismo tiempo, un Client Component interactivo del frontend (`app/dashboard/finanzas/nuevo/page.tsx` marcado con `'use client'`) importó dicha utilidad. Turbopack evaluó el árbol de dependencias completo y explotó porque el código que viaja al navegador del usuario es físicamente incompatible con módulos nativos de Node.js.
*   **Resolución Zero-Trust:** Aislamiento estricto de entornos. Se aplicó un desacoplamiento forzoso donde las herramientas de servidor (que manipulan cookies y headers) jamás deben cohabitar en el mismo archivo con herramientas de cliente (que usan estado o interactividad), blindando la frontera del renderizado.

**18. Rechazo Transaccional por Contaminación de Payload**
*   **Incidente:** La base de datos rechaza transacciones del POS arrojando errores de esquema (`Could not find 'tiene_marbete'`) y violaciones de seguridad (`violates check constraint`).
*   **Diagnóstico First-Principles:** El frontend cometió dos crímenes de "Separation of Concerns": 1) Contaminación de Payload: Inyectaba el objeto físico del carrito (incluyendo atributos logísticos como `tiene_marbete`) directamente a la tabla `finanzas_ledger`, la cual solo procesa dinero. 2) Desincronización de Diccionario: Enviaba strings genéricos (`EGRESO`) a una columna con un `CHECK` constraint que exige llaves contables exactas y en mayúsculas (`GASTO_OPERATIVO`, `INGRESO_VENTA`).
*   **Resolución Zero-Trust:** Sanitización de datos obligatoria en la Server Action. Se forzó al código a purgar el payload antes de guardarlo, enrutando los atributos físicos exclusivamente a `inventario_ledger` y los monetarios a `finanzas_ledger`. Se extrajo la regla SQL nativa de Postgres para mapear el frontend milimétricamente con el diccionario contable permitido.

**19. El Fantasma de la UI (Ceguera de Filtros)**
*   **Incidente:** Los movimientos logísticos se guardaban con éxito en la base de datos pero eran invisibles en la tabla de "Últimos Movimientos".
*   **Diagnóstico First-Principles:** Aunque el cálculo matemático de stock se actualizó correctamente en el servidor, el componente visual que renderizaba la tabla tenía un filtro de lectura (lista blanca) desincronizado. Este filtro solo permitía renderizar los strings 'ENTRADA_COMPRA' o 'SALIDA_VENTA', volviendo ciega a la interfaz ante los nuevos ENUMs ('MERMA', 'DEVOLUCION_FISICA') que ya existían en el backend.
*   **Resolución Zero-Trust:** Sincronización visual absoluta. Se corrigieron y ampliaron los filtros de consulta del frontend para abarcar la totalidad de los ENUMs transaccionales capaces de ser generados por la base de datos, garantizando que el DOM refleje la verdad del ledger sin omisiones.