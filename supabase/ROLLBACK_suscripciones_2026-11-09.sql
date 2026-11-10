-- ============================================================================
-- ROLLBACK_suscripciones_2026-11-09.sql · reversa de
-- supabase/migrations/20261109213824_suscripciones.sql (sello con el que se aplico)
-- Escrito el 2026-11-09 por el Socio (ejecutor).
-- ============================================================================
-- Que deja: la base como estaba antes de la migracion, SALVO los egresos que ya
-- se hayan registrado como Suscripciones en finanzas_ledger: esos NO se tocan
-- (son dinero real; un ledger no se borra, se anula). Si hay alguno, las cuatro
-- subcategorias se DESACTIVAN en vez de borrarse, para que esos egresos sigan
-- apuntando a una pareja que existe.
--
-- Antes de correrla, mira cuantos egresos hay:
--   select count(*) from finanzas_ledger where categoria = 'Suscripciones';
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS public.suscripcion_meses;
DROP TABLE IF EXISTS public.suscripciones;

-- Sin egresos con esa categoria: se borran las cuatro parejas.
DELETE FROM public.categorias_movimiento c
 WHERE c.tipo = 'EGRESO' AND c.categoria = 'Suscripciones'
   AND NOT EXISTS (SELECT 1 FROM public.finanzas_ledger f WHERE f.categoria = 'Suscripciones');

-- Con egresos: se desactivan (el bot y el alta web dejan de ofrecerlas).
UPDATE public.categorias_movimiento
   SET activa = false
 WHERE tipo = 'EGRESO' AND categoria = 'Suscripciones';

COMMIT;

-- Comprobar:
--   select to_regclass('public.suscripciones'), to_regclass('public.suscripcion_meses');  -- null, null
--   select count(*) from categorias_movimiento where categoria = 'Suscripciones' and activa;  -- 0
