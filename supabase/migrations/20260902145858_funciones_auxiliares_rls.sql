-- ============================================================================
-- Paso 6 · Funciones auxiliares para las politicas de RLS
-- ============================================================================
-- SECURITY DEFINER con search_path fijo. Son propiedad de `postgres`, que es
-- dueno de las 9 tablas y tiene BYPASSRLS: por eso leer `entidades` desde
-- dentro de estas funciones NO vuelve a disparar las politicas de `entidades`
-- y no hay recursion infinita.
--
-- La identidad se resuelve por DOS vias a proposito: `auth_id` (lo correcto) y
-- el correo (que es como la app resuelve identidad hoy, lib/auth-utils.ts:47).
-- No quiero que la seguridad dependa de que las dos coincidan.
-- ============================================================================

-- Entidad del usuario de la sesion actual. NULL si no hay sesion.
CREATE OR REPLACE FUNCTION public.mi_entidad_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM entidades
  WHERE auth_id = auth.uid()
     OR lower(email) = lower(auth.jwt() ->> 'email')
  -- Desempate determinista: si por lo que sea un correo y un auth_id apuntaran
  -- a filas distintas, gana el auth_id. Sin este ORDER BY, LIMIT 1 elegiria al azar.
  ORDER BY (auth_id IS NOT DISTINCT FROM auth.uid()) DESC
  LIMIT 1
$$;

-- Rol de la sesion actual: ADMIN | SOCIO | DST | LOC | SUB-ADMIN. NULL si no hay sesion.
CREATE OR REPLACE FUNCTION public.mi_rol() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rol FROM entidades WHERE id = public.mi_entidad_id()
$$;

-- La entidad propia MAS sus locales hijos. Se leen las dos columnas de padre
-- (`id_padre` y `id_nodo_padre`) porque el puente legacy sigue vivo.
-- Devuelve vacio si no hay sesion.
CREATE OR REPLACE FUNCTION public.mis_entidades() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM entidades
  WHERE id = public.mi_entidad_id()
     OR id_padre = public.mi_entidad_id()
     OR id_nodo_padre = public.mi_entidad_id()
$$;

-- Postgres concede EXECUTE a PUBLIC por defecto en cada CREATE FUNCTION
-- (lo aprendimos en el prompt 1). Hay que quitarlo explicitamente.
REVOKE EXECUTE ON FUNCTION public.mi_entidad_id()  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mi_rol()         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mis_entidades()  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.mi_entidad_id()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mi_rol()          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mis_entidades()   TO authenticated, service_role;
