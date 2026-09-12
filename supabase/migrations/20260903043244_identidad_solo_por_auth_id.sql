-- ============================================================================
-- Quitarle a la identidad el camino del correo
-- ============================================================================
-- QUE HACIA. `mi_entidad_id()` empataba la sesion contra `entidades` por
-- `auth_id = auth.uid()` **O** por `lower(email) = lower(auth.jwt() ->> 'email')`.
-- Se dejaron las dos vias el 2026-09-02 porque la app resolvia identidad por
-- correo (`lib/auth-utils.ts:47`) y no todas las filas tenian `auth_id`.
--
-- POR QUE SE QUITA. Ese segundo camino es una via de escalada de privilegios:
-- `entidades.email` es una columna de datos, editable por el ADMIN desde la
-- pantalla de distribuidores. **Si la fila del ADMIN llegara a quedar con el
-- correo de un DST, ese DST se volveria ADMIN** — sin tocar `auth.users`, sin
-- password, sin nada: un typo en un formulario bastaria. `auth_id` no tiene ese
-- problema: apunta a `auth.users(id)`, no se teclea y solo se puede cambiar con
-- service role.
--
-- POR QUE YA SE PUEDE. Las 5 entidades con login tienen `auth_id` poblado y
-- coincidente con `auth.users` (comprobado 2026-09-02, ver el pie de archivo).
-- El camino del correo ya no resuelve a nadie que `auth_id` no resuelva.
--
-- El `ORDER BY ... LIMIT 1` que desempataba entre las dos vias tambien sobra:
-- `entidades_auth_id_key` es UNIQUE, asi que la busqueda devuelve una fila o
-- ninguna.
--
-- NO CAMBIA NINGUNA CIFRA. Ni una fila de datos se toca: es la definicion de
-- una funcion. 84 activas / 468 / 61 / $386,201 quedan intactas.
--
-- El espejo en TypeScript va en el mismo commit: `getCurrentUser()` pasa a
-- resolver por `auth_id`, con el correo solo como respaldo y con un aviso en
-- consola cuando lo use, para enterarnos si algun dia pasa.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   CREATE OR REPLACE FUNCTION public.mi_entidad_id() RETURNS uuid
--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
--     SELECT id FROM entidades
--     WHERE auth_id = auth.uid()
--        OR lower(email) = lower(auth.jwt() ->> 'email')
--     ORDER BY (auth_id IS NOT DISTINCT FROM auth.uid()) DESC
--     LIMIT 1
--   $$;
-- (definicion original en 20260902020000_funciones_auxiliares_rls.sql)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mi_entidad_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM entidades WHERE auth_id = auth.uid()
$$;

COMMENT ON FUNCTION public.mi_entidad_id() IS
  'Entidad del usuario de la sesion. UNICO empate: entidades.auth_id = auth.uid(). '
  'El empate por correo se quito el 2026-09-02: entidades.email es editable desde '
  'la app y un correo repetido en la fila equivocada convertia a un DST en ADMIN.';

-- ─── COMPROBACION QUE AUTORIZA EL CAMBIO (2026-09-02) ───────────────────────
--   SELECT e.nombre, e.rol, e.auth_id, u.email AS auth_email,
--          (e.auth_id IS NOT NULL AND lower(u.email) = lower(e.email)) AS empata
--     FROM entidades e LEFT JOIN auth.users u ON u.id = e.auth_id
--    WHERE e.email IS NOT NULL;
--
--   CEO Admin       | ADMIN | b913b2da-... | normancantu@gmail.com                | t
--   David Flores    | DST   | 9aca0f7d-... | david80ffo@gmail.com                 | t
--   Gilberto Franco | DST   | 5e33b4ae-... | gfranco+fresnillo@infrasolutionsllc.com | t
--   Luis Rodriguez  | DST   | 69ec80ec-... | luisr@gmail.com                      | t
--   Martin Reyes    | DST   | 347b2cb5-... | martinivanr@gmail.com                | t
--
-- 5 de 5 con auth_id y con el correo coincidente. Las 10 entidades LOC no
-- tienen correo ni login: nunca se resolvieron por ninguna de las dos vias.
