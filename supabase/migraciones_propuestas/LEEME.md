# `supabase/migraciones_propuestas/` — SQL escrito, todavia NO aplicado

**Por que esta carpeta existe, y por que NO son archivos de `supabase/migrations/`.**

`tests/salud-del-sistema.spec.ts` (ERP-73) exige que la lista de archivos de
`supabase/migrations/` y la lista de migraciones selladas en la base sean
**identicas, en los dos sentidos**. Un `.sql` ahi que la base no reconozca pone
la prueba en rojo y **detiene el push**. La prueba lo dice con todas sus letras:

> *"apply_migration sella con SU hora UTC, no con la del nombre del archivo.
> **El archivo se nombra DESPUES de aplicar.**"*

O sea: en este repo, un archivo dentro de `supabase/migrations/` **es** una
migracion aplicada. No hay lugar ahi para una propuesta.

Y hace falta un lugar para propuestas, porque la regla vigente de Norman es que
**una migracion restrictiva se escribe pero no se aplica**: quien decide cuando
apretar un candado sobre datos que ya existen es el, no el agente.

## Como se aplica una de estas

1. Norman lo dice.
2. Se aplica **con `apply_migration` del MCP de Supabase**. **NUNCA
   `supabase db push`** (ERP-73: diez migraciones ya vivas se aplicaron por
   fuera y el registro no se entero).
3. **Despues** de aplicar, el archivo se mueve a `supabase/migrations/` con
   EXACTAMENTE el nombre con que quedo sellado -version UTC del sello, no la
   del nombre de aqui-, y se corre `npm run verificar` para que la prueba de
   sincronia lo confirme.
