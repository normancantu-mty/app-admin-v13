# Base de datos de desarrollo LOCAL

Escrito el 2026-10-27 por el Socio (ejecutor). Objetivo: dejar de desarrollar contra produccion
(`gnnqxtsdrbvmlkhfemjw`). Todo lo de aqui corre en Docker, en tu maquina, contra 127.0.0.1.

## Que hay

| Pieza | URL / puerto |
|---|---|
| API (REST, auth, storage) | http://127.0.0.1:54321 |
| Postgres 17 | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio | http://127.0.0.1:54323 |
| Mailpit (correos de auth) | http://127.0.0.1:54324 |
| App en desarrollo | http://localhost:3001 (`npx next dev -p 3001`) |

El puerto 3000 NO se usa: ahi corre el `next dev` del repo principal que sirve al bot de Telegram
contra PRODUCCION.

## Por que las migraciones estan desactivadas

`supabase/migrations` no trae el esquema base: la primera migracion (`20260512210725_...`) hace
`ALTER TABLE public.finanzas_ledger`, tabla que ninguna migracion crea. `supabase start` falla con
`relation "public.finanzas_ledger" does not exist`. Por eso `supabase/config.toml` tiene
`[db.migrations] enabled = false` y `[db.seed] enabled = false`, y el esquema y los datos se cargan
del respaldo diario.

## Levantar desde cero

Desde la raiz de este worktree, con Docker Desktop arriba:

```bash
npx supabase start          # baja imagenes la 1a vez; arranca la base VACIA (solo esquemas de Supabase)
R=../app-admin/supabase/_respaldos      # respaldos: SOLO LECTURA
F=2026-10-26                            # o el respaldo mas reciente
docker exec -i supabase_db_app-admin-dev psql -U postgres -d postgres < $R/${F}_schema.sql
docker exec -i supabase_db_app-admin-dev psql -U postgres -d postgres < $R/${F}_datos.sql
```

El volcado de datos empieza con `session_replication_role = replica`: los triggers no corren
durante la carga. Trae `auth.users` (las contrasenas reales funcionan en local).

`.env.development.local` (ignorado por git por la regla `.env*`) tiene SOLO las llaves locales:

```bash
npx supabase status -o env    # API_URL, ANON_KEY, SERVICE_ROLE_KEY
```

Variables: `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_URL` = http://127.0.0.1:54321,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` = ANON_KEY, `SUPABASE_SERVICE_ROLE_KEY` = SERVICE_ROLE_KEY.
Son las llaves demo fijas del CLI; no sirven contra produccion. **Nunca copies aqui el `.env` de
produccion.** Este worktree no tiene `.env` ni `.env.local`: Next solo carga
`.env.development.local` (lo dice al arrancar: `Environments: .env.development.local`).

Comprobar a donde apunta la app sin levantarla:

```bash
node -e "require('@next/env').loadEnvConfig(process.cwd(),true);console.log(process.env.NEXT_PUBLIC_SUPABASE_URL)"
```

## Recargar datos (base sucia o respaldo nuevo)

```bash
npx supabase db reset       # SIN --linked: borra y recrea la base LOCAL, vacia
# y luego los dos psql de arriba
```

## Apagar

```bash
npx supabase stop           # conserva los datos en el volumen de Docker
npx supabase stop --no-backup   # ademas borra los datos locales
```

## Lo que NO hay en local (a proposito)

- `vault.secrets`: vacio. Las funciones que avisan por Telegram (`agente.avisar`,
  `agente.avisar_grupo`, `agente.latido`, `agente.vigia_puente`) y las que llaman a la edge function
  de produccion (`agente.guardian_diario`, `agente.insistir_datos`) leen su token/clave del vault;
  sin secreto, no llegan a ningun lado. **No cargues secretos de produccion al vault local**: esas
  funciones hacen `net.http_post` a api.telegram.org y a `gnnqxtsdrbvmlkhfemjw.supabase.co`.
- `cron.job`: vacio (prod tiene 15). En local no corre ninguna tarea programada.
- `supabase_migrations.schema_migrations`: no existe. Para probar una migracion nueva, aplicala a
  mano con `docker exec -i supabase_db_app-admin-dev psql -U postgres -d postgres < archivo.sql`.
- Binarios de storage: solo estan los metadatos de `storage.objects`.
- `ERP_AGENTE_TOKEN`, `BOT_API_TOKEN`: sin definir; las rutas que los piden responden como sin
  autorizacion.

## Nunca

`supabase link`, `supabase db push`, `supabase db reset --linked`, ni ningun comando con
`--linked` o con la URL de produccion desde este worktree.

## ADVERTENCIA pendiente de decision

Los **previews de Vercel** (`app-admin-v13`) siguen usando las llaves de PRODUCCION, incluida
`SUPABASE_SERVICE_ROLE_KEY`. Una rama desplegada como preview escribe en la base real. Esta base
local NO cambia eso; queda pendiente de decision (no se tocaron variables de Vercel).
