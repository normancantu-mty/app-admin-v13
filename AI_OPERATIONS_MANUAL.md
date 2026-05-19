# AI_OPERATIONS_MANUAL.md

## 1. The Danger of Global Linting
**Never use `--auto-test` with global scope commands** (e.g., `npx eslint app/`). Running global linters triggers the "Whack-A-Mole" effect: the AI agent will detect legacy technical debt in untouched files, attempt to fix everything blindly, and quickly exhaust its safety limits (reflections), shutting down to prevent massive token drain. **Use the native `--lint` flag instead**. This restricts the AI's validation strictly to the files it modified during the current task, maintaining isolation and protecting your budget.

## 2. Forcing Context (The `type` Trick)
When Aider refuses or fails to load tracking files via command-line arguments, **bypass the restriction using terminal standard output**. Execute the command `type BACKLOG.md` directly within the Aider prompt. This forces the console to print the raw text into the chat, physically injecting the file's entire content into the agent's active RAM/context and allowing it to proceed without permission roadblocks.

## 3. The Search/Replace Limitation
Aider frequently fails with a `SearchReplaceNoExactMatch` error because it attempts to patch code using outdated or assumed file structures. If formatting, spacing, or imports differ by a single character, the patch will safely abort. **Strict Protocol:** Before allowing Aider to generate a `SEARCH/REPLACE` block, explicitly instruct it to **READ the exact current content of the target file**. Do not allow blind guessing; the agent must see the live code structure before attempting a rewrite.

## 4. The Next.js Server/Client Trap
Aider is prone to making fatal architectural errors in the Next.js App Router, specifically by **injecting client-side React hooks (`useState`, `useTransition`, `onClick`) directly into async Server Components like `page.tsx`**. This will instantly crash the Turbopack compiler. **Absolute Rule:** Force the agent to extract any interactive UI elements (tables, buttons, state) into separate, dedicated child components explicitly prefixed with the `'use client'` directive. Keep `page.tsx` as a pure server-side data fetcher.

## 5. The RAM Reset Rule
Never leave an Aider session running continuously across multiple tasks. Extended sessions suffer from "Context Rot," leading to token bloat, hallucinated variables, and forgotten system prompts. **Enforce the strict isolation protocol:** Open Aider -> Execute exactly one ticket -> Commit the changes -> Shut down the agent using `/exit` -> Restart Aider for the next task. This clears the active RAM and forces the agent to read the freshest "Liquid Memory" directly from the Git repository.

## 6. The Next.js 15 "Ghosting" (Cache Protection)
Next.js 15 (Turbopack) aggressively caches Server Components and API Routes. 
- **The Rule:** If a page or API depends on a session (Admin/Socio), you MUST export `const dynamic = 'force-dynamic'` at the top of the file. 
- **API Fetch:** Always use `{ cache: 'no-store' }` in client-side fetches to bypass the browser's "stale-while-revalidate" behavior during development.

## 7. Windows PowerShell Encoding
Aider fails to execute `git commit` via shell if the message contains quotes or special characters (like 'á', 'é'). 
- **The Protocol:** If a commit fails in the shell, do not ask Aider to fix it. Close Aider and execute the commit manually from the Windows terminal to ensure the code is saved.

## 8. El Fantasma del Caché Estático (Next.js 15)
En modo desarrollo (Turbopack), Next.js 15 cachea agresivamente las respuestas de las API Routes (`route.ts`). Si una petición falla inicialmente por falta de sesión (403), el framework guardará ese error en caché y lo seguirá devolviendo incluso cuando el usuario ya esté autenticado, provocando falsos bloqueos de seguridad. **Solución Estricta:** Inyectar la directiva `export const dynamic = 'force-dynamic'` en la línea 1 de cualquier ruta de API de lectura para obligar al servidor a saltarse la memoria caché y evaluar la autorización real en cada petición.

## 9. La Trampa del `alert()` Bloqueante
Durante la carga inicial de datos (ej. un `fetch` al montar un componente), utilizar `alert()` para el manejo de errores es una práctica destructiva que bloquea el hilo principal del navegador y congela la interfaz del usuario. **Solución Estricta:** Para errores de carga en segundo plano, forzar a la IA a utilizar `console.error()`. En el entorno de Next.js, esto mostrará un *overlay* seguro y no bloqueante que nosotros podemos cerrar. Se debe reservar el uso de `alert()` ÚNICAMENTE para acciones manuales directas (ej. cuando el usuario hace clic activamente en "Aprobar/Rechazar").

## 10. Fricción de PowerShell y Caracteres Especiales
Al ejecutar comandos de shell de Git a través de Aider en Windows PowerShell (como `git commit -m "..."`), el uso de acentos o caracteres especiales en el mensaje (ej. "Implementación", "aprobación", "dinámica") rompe el *pathspec* de Git. Windows y la terminal interpretan erróneamente los caracteres acentuados separando las palabras como si fueran rutas de archivos inexistentes, abortando el commit. **Solución Estricta:** Exigir que los mensajes de commit instruidos a la IA para comandos de consola en Windows omitan acentos y caracteres especiales, o bien, permitir que Aider utilice su motor de commits interno nativo en lugar de forzar llamadas al shell de Git.

## 11. La Regla de Oro: Props vs. Hooks (Server Components)
Aider tiene tendencia a alucinar e inyectar hooks de cliente inventados (ej. `useCurrentUser()`) directamente dentro de Server Components, lo cual causa un `ReferenceError` fatal y tumba la compilación en Next.js. **Solución Estricta:** Prohibir a la IA inventar hooks para leer sesiones de forma aislada. La arquitectura exige extraer el estado del usuario en el componente de servidor superior (`page.tsx`) usando las utilidades reales, y pasar los permisos estrictamente como **Server Props** booleanos (ej. `isSubAdmin={...}`, `isAdmin={...}`) a los componentes hijos.

**12. Gestión Estricta de Cookies Híbridas (Client vs. Server Components)**
*   Para aislar y persistir el estado global sin romper el framework, la manipulación de cookies debe respetar las fronteras de renderizado. 
*   En **Client Components**, escribe y actualiza el estado directamente en el navegador utilizando `document.cookie`.
*   En **Server Components**, lee el estado de forma nativa utilizando la utilidad `cookies()` de `next/headers`. 
*   **Regla de Oro:** Jamás permitas que la IA importe herramientas de SSR como `next/headers` dentro de un archivo (como un `layout.tsx`) que contenga directivas `'use client'` o hooks de interactividad (`useState`), ya que esto provocará un *Client Boundary Error* fatal en Turbopack.

**13. Resolución Obligatoria de Promesas (Trampa de Next.js 15)**
*   La arquitectura de Next.js 15 cambió la física del servidor: las APIs dinámicas como `searchParams` y `cookies()` dejaron de ser funciones síncronas y ahora son estrictamente **Promesas**.
*   Es una **obligación absoluta** desempaquetar estas promesas utilizando `await` (ej. `const params = await searchParams;`) antes de intentar acceder a sus propiedades. 
*   Omitir el `await` no siempre generará un error visible de inmediato, pero congelará el renderizado del servidor, provocando que la aplicación ignore los cambios de URL y devuelva datos estáticos cacheados.

**14. Directiva Anti-Adivinación (Protocolo de Lectura Estricta para Aider)**
*   Queda **estrictamente prohibido** que el agente Aider intente generar bloques `SEARCH/REPLACE` a ciegas, basándose en suposiciones de cómo cree que está escrito el código.
*   Intentar adivinar espacios, indentaciones o nombres de variables causará el error `SearchReplaceNoExactMatch`. Repetir este error consumirá el límite de seguridad interno del agente (3 reflexiones), apagando el sistema abruptamente.
*   **Regla de Oro:** Antes de emitir cualquier comando de reescritura (`REPLACE`), debes obligar a la máquina a imprimir y leer el contenido exacto del bloque de código físico actual para cargarlo en su memoria temporal. Cero adivinanzas.