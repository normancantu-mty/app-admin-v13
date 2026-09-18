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

## Bitacora de promociones — la prueba de que el procedimiento de arriba funciona

| Propuesta | Aplicada | Quedo sellada como | Comprobado |
|---|---|---|---|
| `erp16_entidad_obligatoria_en_inventario.sql` | 2026-09-14, con el "va" de Norman en el chat | `20260915000928_erp16_entidad_obligatoria_en_inventario` | md5 del archivo = md5 de `statements` en la base (`4521e3cf...`). Control positivo: INSERT sin destino rechazado con **23514**. Control negativo: el mismo INSERT **con** destino si entra. Los dos dentro de un bloque que termina en `raise exception`, asi que no quedo ni una fila de prueba (`usuario_creador='prueba-erp16'` -> 0 filas). |

**Ojo con el desfase de fecha, y no es un error:** la propuesta se escribio el **14** y quedo
sellada con version del **15**. `apply_migration` sella con SU hora UTC, que a esa hora de Mexico
ya es el dia siguiente. Por eso el archivo se nombra DESPUES de aplicar y nunca antes.

## Lo que hay hoy en esta carpeta, y de que depende cada cosa

Escrito el 2026-09-17 por el Socio, al dejar tres propuestas nuevas.

| Archivo | Que hace | Depende de |
|---|---|---|
| `erp15_devolucion_fisica_en_el_check_de_tipos.sql` | Agrega 3 tipos al CHECK de `inventario_ledger` | nada |
| `erp71_el_intento_bloqueado_deja_rastro.sql` | Un intento de escritura BLOQUEADO deja rastro fuera de la transaccion que se aborta | nada. Conviene aplicar `erp57` antes o el contador nace tocable por `anon` |
| `erp57_las_tablas_nuevas_no_nacen_abiertas_a_anon.sql` | Cierra el *default privilege* de `postgres` en `public` para `anon` | nada. **Va primero** |
| `erp11_venta_atomica_funcion_de_postgres.sql` | La venta del POS en UNA transaccion. **No la llama nadie todavia** | nada para aplicarla; el corte del codigo va despues y esta escrito en el punto 6 del propio archivo |

**Orden recomendado: `erp57` -> `erp71` -> `erp11`.** El motivo del primero esta
medido dentro de `erp57`: mientras el default siga abierto, cada funcion y cada
secuencia nueva nace con permiso para `anon` y hay que revocarlo a mano, una por
una. Las tres propuestas de esta tanda traen su `REVOKE` escrito justamente por eso.

**Ninguna de las tres se aplico.** Cada una lleva dentro su control positivo, su
control negativo y su rollback.
