-- fbig-vigia-humano (2026-09-28) — E2: cron cada minuto que llama vigia-bandeja accion "humanos".
-- Igual que el cron 'vigia-bandeja' (jobid 5): net.http_post con la clave del vault. Hasta que Norman despliegue la
-- vigia-bandeja nueva, la funcion vieja contesta 400 "accion desconocida": inocuo, no escribe nada.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: select cron.unschedule('humanos-meta');
-- APAGADO RAPIDO sin quitar el cron: update agente.cerebro_config set humano_fbig = 'apagado';

select cron.schedule('humanos-meta', '* * * * *', $c$select net.http_post(
  url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/vigia-bandeja',
  headers := jsonb_build_object('Content-Type', 'application/json',
    'x-vigia-clave', (select decrypted_secret from vault.decrypted_secrets where name = 'vigia_clave')),
  body := '{"accion":"humanos"}'::jsonb, timeout_milliseconds := 60000)$c$);
