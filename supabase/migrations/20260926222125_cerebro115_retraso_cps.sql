-- cerebro-1.15 H (2026-09-26): retraso humano con la latencia descontada. retraso_cps = caracteres por segundo
-- (8 = 160 caracteres en 20 s, estimado); retraso_max_ms baja de 40000 a 25000 (tope del prompt; hoy nadie lo lee:
-- retraso_on sigue en false). abrir_turno ya pasa la fila entera (to_jsonb), no hay que tocarlo.
-- DESHACER: alter table agente.cerebro_config drop column retraso_cps; update agente.cerebro_config set retraso_max_ms = 40000 where id = 1;
alter table agente.cerebro_config add column if not exists retraso_cps numeric not null default 8;
update agente.cerebro_config set retraso_max_ms = 25000 where id = 1;
