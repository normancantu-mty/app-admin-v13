-- ============================================================================
-- v2 LOCAL: usuarios de prueba (SOLO LOCAL; contrasenas de juguete, nunca en la nube)
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- Corre despues de 50_datos_produccion.sql (que suelta los auth_id de produccion).
-- La app resuelve la identidad por entidades.auth_id (RLS, mi_entidad_id) y algunas
-- rutas por entidades.email = auth.users.email: por eso el admin usa el correo que
-- ya tiene la entidad CEO Admin.
--
--   admin  : normancantu@gmail.com   / v2-local-admin  -> CEO Admin (e0000000-...-0001)
--   dst    : dst.prueba@v2.local     / v2-local-dst    -> "DST Prueba v2 (local)" (se crea aqui)
-- ============================================================================

-- Entidad de prueba para el distribuidor (no existe en produccion).
INSERT INTO public.entidades (id, nombre, rol, zona, email, es_distribuidor)
VALUES ('d5000000-0000-4000-a000-000000000001', 'DST Prueba v2 (local)', 'DST', 'Zacatecas',
        'dst.prueba@v2.local', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.cuentas_financieras (id, id_entidad, nombre, tipo_fiscalidad)
VALUES ('d5000000-0000-4000-a000-0000000000c1', 'd5000000-0000-4000-a000-000000000001',
        'Efectivo (DST Prueba v2 (local))', 'LIBRE')
ON CONFLICT (id) DO NOTHING;

DO $u$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('a0000000-0000-4000-a000-0000000000a1'::uuid, 'normancantu@gmail.com', 'v2-local-admin',
       'e0000000-0000-0000-0000-000000000001'::uuid),
      ('a0000000-0000-4000-a000-0000000000d5'::uuid, 'dst.prueba@v2.local', 'v2-local-dst',
       'd5000000-0000-4000-a000-000000000001'::uuid)
    ) v(uid, correo, clave, entidad)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.entidades WHERE id = r.entidad) THEN
      RAISE NOTICE 'sin entidad % (falta 50_datos_produccion.sql): usuario % no se liga', r.entidad, r.correo;
      CONTINUE;
    END IF;

    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    VALUES ('00000000-0000-0000-0000-000000000000', r.uid, 'authenticated', 'authenticated',
      r.correo, extensions.crypt(r.clave, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '', '', '', '', '')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at)
    VALUES (r.uid::text, r.uid,
      jsonb_build_object('sub', r.uid::text, 'email', r.correo, 'email_verified', true),
      'email', now(), now(), now())
    ON CONFLICT DO NOTHING;

    UPDATE public.entidades SET auth_id = r.uid, email = r.correo WHERE id = r.entidad;
  END LOOP;
END
$u$;
