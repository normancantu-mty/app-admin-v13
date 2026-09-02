-- Fase 0 / paso 2 — Cerrar la escritura anonima.
--
-- Hasta hoy el rol `anon` (la llave que Next.js inlinea en el bundle publico via
-- NEXT_PUBLIC_SUPABASE_ANON_KEY) tenia SELECT, INSERT, UPDATE, DELETE y TRUNCATE
-- sobre las 9 tablas de `public`, con RLS apagado y cero politicas. Cualquiera que
-- abriera la app podia vaciar la base sin login y sin dejar rastro.
--
-- Un usuario con sesion NO pasa por `anon`: PostgREST ejecuta como `authenticated`
-- cuando llega el JWT. Por eso esta revocacion no rompe ningun formulario logueado,
-- incluidos los tres que escriben directo desde el navegador (abono, devolucion,
-- compra de insumos).
--
-- SELECT se deja INTACTO a proposito: hay Server Components que importan el cliente
-- de navegador (lib/supabase.ts) y consultan sin sesion. Eso se arregla en el prompt 2.
-- El rol `authenticated` no se toca aqui.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;

-- Que las tablas futuras nazcan igual de cerradas para `anon`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;

-- `registrar_logistica_inversa` es SECURITY DEFINER: ejecutable por `anon` era un
-- bypass de todo lo anterior via /rest/v1/rpc/.
REVOKE EXECUTE ON FUNCTION public.registrar_logistica_inversa(uuid, numeric, text, uuid, uuid, numeric, text) FROM anon;
