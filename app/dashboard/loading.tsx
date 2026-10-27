/**
 * EL ESQUELETO DE CADA PESTAÑA DEL TABLERO.
 *
 * Las paginas de `/dashboard` son dinamicas (`force-dynamic` en el layout): sin
 * un `loading.tsx`, Next no puede prerrenderizar nada de la ruta destino y el
 * clic se queda congelado hasta que el servidor termina TODAS sus consultas
 * (2-3 s medidos a ojo, 2026-10-27). Con este archivo el cambio de pestaña es
 * inmediato: el menu y la barra de arriba se quedan, y en el hueco del
 * contenido se pinta esto mientras llegan los datos.
 *
 * Solo dibuja. No consulta nada ni decide permisos: la puerta sigue en
 * `proxy.ts` y en `app/dashboard/layout.tsx`.
 */
export default function DashboardLoading() {
  return (
    <div className="p-4 md:p-8" aria-busy="true" aria-label="Cargando">
      <div className="space-y-8 animate-pulse">
        <div className="h-8 w-64 rounded bg-gray-200 dark:bg-gray-800" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-lg border border-gray-100 bg-gray-200/80 dark:border-gray-800 dark:bg-gray-800/80"
            />
          ))}
        </div>
        <div className="h-72 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900" />
      </div>
    </div>
  )
}
