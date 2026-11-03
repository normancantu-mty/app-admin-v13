# -*- coding: utf-8 -*-
"""Genera supabase/seed_local/50_datos_produccion.sql desde volcados JSON de produccion. SOLO LOCAL.

Escrito el 2026-11-03 por el agente de infraestructura (rama dev/panel-scroll-y-ajustes-admin).

Los volcados salen de SELECTs de solo lectura contra produccion (MCP de Supabase), con la forma
  select json_build_object('<esquema>.<tabla>', (select coalesce(json_agg(t),'[]') from <esquema>.<tabla> t), ...) as datos
La herramienta guarda el resultado como texto: {"result": "...<untrusted-data-X>\n[{\"datos\": {...}}]\n</untrusted-data-X>..."}.
Este script acepta ese envoltorio o un JSON plano {"esquema.tabla": [filas]}.

El SQL generado:
  - carga con session_replication_role = replica (sin triggers ni FKs durante la carga);
  - vacia antes cada tabla que carga (idempotente sobre la base local);
  - salta con WARNING la tabla que no existe en local (deriva de esquema prod vs migraciones);
  - inserta solo las columnas que existen en la tabla local y no son generadas (las que sobran se avisan);
  - crea en auth.users los auth_id de public.entidades con su email y la clave local --clave
    (NO copia hashes de produccion). 60_usuarios_prueba.sql corre despues.

Uso:
  python scripts/v2_seed_desde_mcp.py <volcado1.txt> [<volcado2.txt> ...] [--clave v2-local-prod]
Nunca se conecta a ninguna base: solo lee archivos y escribe el .sql (que esta en .gitignore).
"""
import json
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'supabase', 'seed_local', '50_datos_produccion.sql')
TAG = '$DATOS_v2x7Q$'


def leer(ruta):
    s = open(ruta, encoding='utf-8').read()
    try:
        o = json.loads(s)
    except ValueError:
        sys.exit('no es JSON: %s' % ruta)
    if isinstance(o, dict) and 'result' in o and isinstance(o['result'], str):
        m = re.search(r'<untrusted-data-[^>]+>\n(\[.*\])\n</untrusted-data-', o['result'], re.S)
        if not m:
            sys.exit('envoltorio MCP sin bloque de datos: %s' % ruta)
        filas = json.loads(m.group(1))
        o = filas[0]['datos']
    return o


def main():
    args = sys.argv[1:]
    clave = 'v2-local-prod'
    if '--clave' in args:
        i = args.index('--clave')
        clave = args[i + 1]
        del args[i:i + 2]
    if not args:
        sys.exit(__doc__)
    datos = {}
    for r in args:
        for k, v in leer(r).items():
            if k in datos:
                sys.exit('tabla repetida en dos volcados: %s' % k)
            datos[k] = v
    out = ['-- v2 LOCAL. GENERADO por scripts/v2_seed_desde_mcp.py; en .gitignore (datos de clientes).',
           '-- Copia de produccion por SELECT. Tablas: %d, filas: %d.' % (
               len(datos), sum(len(v) for v in datos.values())),
           "SET session_replication_role = replica;",
           """CREATE OR REPLACE FUNCTION pg_temp.cargar(p_nombre text, p_datos jsonb) RETURNS int
LANGUAGE plpgsql AS $f$
DECLARE cols text; sobran text; n int; p_tabla regclass := to_regclass(p_nombre);
BEGIN
  IF p_tabla IS NULL THEN
    RAISE WARNING 'NO EXISTE EN LOCAL (ninguna migracion la crea): % -- % filas sin cargar', p_nombre, jsonb_array_length(p_datos);
    RETURN -1;
  END IF;
  SELECT string_agg(quote_ident(a.attname), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a
  WHERE a.attrelid = p_tabla AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_datos) e WHERE e ? a.attname);
  SELECT string_agg(k, ',') INTO sobran FROM (
    SELECT DISTINCT jsonb_object_keys(e) k FROM jsonb_array_elements(p_datos) e) x
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = p_tabla AND a.attname = x.k
                    AND NOT a.attisdropped AND a.attgenerated = '');
  IF sobran IS NOT NULL THEN
    RAISE NOTICE '%: columnas de produccion que no se cargan (no existen o son generadas): %', p_tabla, sobran;
  END IF;
  EXECUTE format('DELETE FROM %s', p_tabla);
  IF jsonb_array_length(p_datos) = 0 THEN RETURN 0; END IF;
  EXECUTE format('INSERT INTO %s (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::%s, $1)',
                 p_tabla, cols, cols, p_tabla) USING p_datos;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;""",
           ]
    for k in sorted(datos):
        esq, tab = k.split('.', 1)
        txt = json.dumps(datos[k], ensure_ascii=False)
        if TAG in txt:
            sys.exit('la etiqueta %s aparece en los datos de %s' % (TAG, k))
        out.append("SELECT '%s' AS tabla, pg_temp.cargar('%s.%s', %s%s%s::jsonb) AS filas;" % (
            k, '"%s"' % esq, '"%s"' % tab, TAG, txt, TAG))
    out.append("SET session_replication_role = origin;")
    # auth.users locales para los auth_id de entidades (mismo UUID y email; clave local, nunca la de produccion).
    out.append("""DO $u$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT auth_id, email FROM public.entidades WHERE auth_id IS NOT NULL AND email IS NOT NULL LOOP
    INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    VALUES ('00000000-0000-0000-0000-000000000000', r.auth_id, 'authenticated', 'authenticated',
      r.email, extensions.crypt(%s, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{"email_verified":true}', now(), now(),
      '', '', '', '', '', '', '', '')
    ON CONFLICT (id) DO UPDATE SET encrypted_password = EXCLUDED.encrypted_password, email = EXCLUDED.email;
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    VALUES (r.auth_id::text, r.auth_id,
      jsonb_build_object('sub', r.auth_id::text, 'email', r.email, 'email_verified', true),
      'email', now(), now(), now())
    ON CONFLICT DO NOTHING;
  END LOOP;
END $u$;""" % ("'" + clave.replace("'", "''") + "'"))
    open(SALIDA, 'w', encoding='utf-8', newline='\n').write('\n'.join(out) + '\n')
    for k in sorted(datos):
        print('%-40s %6d' % (k, len(datos[k])))
    print('escrito', SALIDA, os.path.getsize(SALIDA), 'bytes')


if __name__ == '__main__':
    main()
