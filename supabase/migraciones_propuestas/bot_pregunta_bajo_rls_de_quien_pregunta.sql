-- PROPUESTA, NO APLICADA. Escrito el 2026-11-07 por el ejecutor del Socio
-- (bot con paridad de la web, Fase 2). Ver LEEME.md de esta carpeta: se aplica
-- solo si Norman lo dice, con apply_migration, y el archivo se mueve despues.
--
-- QUE RESUELVE
--   `/api/bot/pregunta` ya es fisicamente de solo lectura (su fetch solo deja
--   salir GET/HEAD, `lib/bot-solo-lectura.ts`) y aplica `lib/bot-permisos.ts`.
--   Pero usa la llave de servicio: NO pasa por RLS. El encargo pedia "bajo la
--   identidad/rol de quien pregunta, nunca service key". Hoy eso es imposible:
--   las politicas son `TO authenticated` y leen `auth.uid()` via
--   `mi_entidad_id()` / `mi_rol()` (tabla `accesos`), y una persona del bot no
--   tiene usuario de auth.
--
-- EL CAMINO MAS CORTO (sin tocar ninguna politica):
--   1. Ligar cada identidad del bot a un usuario de auth que ya tenga su fila
--      en `accesos` (o crearle uno sin contrasena). Esta migracion solo agrega
--      la columna; LLENARLA es una decision de Norman (quien ve que).
--   2. En la ruta, en vez de `clienteDeSoloLectura()` con la llave de servicio:
--      un cliente con la llave ANON y un JWT de vida corta (60 s) firmado en el
--      servidor con `role = 'authenticated'` y `sub = bot_identidades.auth_id`.
--      Asi `auth.uid()` es la persona y RLS hace el resto. El candado GET-only
--      se queda encima.
--   NO COMPROBADO: si el proyecto ya migro a llaves de firma asimetricas, firmar
--   un JWT propio con el secreto HS256 puede no estar disponible; la alternativa
--   es `auth.admin.generateLink` + canje, mas lento. Medirlo antes de elegir.
--
-- MIENTRAS NO SE APLIQUE: la ruta sigue con la llave de servicio y el alcance lo
-- pone `permisoDeConsulta` (hoy: dinero de cuentas, ventas y tickets solo para
-- ADMIN). Es la misma situacion que `/api/bot/consulta` desde AG-04.

alter table public.bot_identidades
  add column if not exists auth_id uuid references auth.users (id);

comment on column public.bot_identidades.auth_id is
  'Usuario de auth con el que el bot LEE en nombre de esta persona (RLS). NULL = el bot no lee bajo RLS por ella.';
