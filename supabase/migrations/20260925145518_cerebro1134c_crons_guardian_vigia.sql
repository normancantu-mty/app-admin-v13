select cron.unschedule(jobid) from cron.job where jobname in ('guardian-diario', 'vigia-bandeja');
select cron.schedule('guardian-diario', '30 4 * * *', $$select agente.guardian_diario()$$);
select cron.schedule('vigia-bandeja', '*/15 * * * *', $$select net.http_post(
  url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/vigia-bandeja',
  headers := jsonb_build_object('Content-Type', 'application/json',
    'x-vigia-clave', (select decrypted_secret from vault.decrypted_secrets where name = 'vigia_clave')),
  body := '{"accion":"revisar"}'::jsonb, timeout_milliseconds := 60000)$$);
