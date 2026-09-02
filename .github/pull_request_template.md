## Que cambio

<!-- Una o dos frases, en lenguaje de negocio. Que hace distinto el sistema despues de esto. -->

## Cifras de control verificadas

Este ERP no guarda saldos: los reproduce del historico. Un error de calculo no rompe nada
visible — solo cambia los numeros. Por eso se verifican a mano contra Supabase.

- [ ] `finanzas_ledger` = **118** filas
- [ ] `inventario_ledger` = **468** filas
- [ ] Tickets `ACTIVO` = **61**
- [ ] Ventas activas acumuladas = **$386,201**
- [ ] No aplica — este cambio no toca dinero, inventario ni agregaciones

<!-- Si alguna cifra cambio A PROPOSITO, di cual y por que. Si cambio sin querer, no lo mandes. -->

## Base de datos

- [ ] No toca la base
- [ ] Agrega migracion en `supabase/migrations/` (creada con `supabase migration new`)
- [ ] Tiene rollback escrito y probado

## Seguridad (RLS)

- [ ] No toca ninguna politica de RLS
- [ ] Toca politicas de RLS — cuales y que rol cambia de alcance:

<!-- Recuerda: 9 tablas, 49 politicas, todas `TO authenticated`.
     ADMIN ve y escribe todo · SOCIO ve todo y no escribe · DST ve lo suyo y sus hijos ·
     LOC ve solo lo suyo. Si un rol empieza a ver mas, dilo aqui explicitamente. -->

## Comprobaciones

- [ ] `npx tsc --noEmit` pasa
- [ ] `npm test` pasa
- [ ] `npm run build` pasa
- [ ] Ningun secreto quedo escrito en el repo (llaves, URLs con credenciales, `.env`)
