select cron.unschedule(jobid) from cron.job where jobname = 'latido-telegram';
select cron.schedule('latido-telegram', '*/5 * * * *', $cron$select net.http_post(
  url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/telegram-entrada?accion=latido',
  headers := jsonb_build_object('Content-Type', 'application/json',
    'x-vigia-clave', (select decrypted_secret from vault.decrypted_secrets where name = 'vigia_clave')),
  body := '{}'::jsonb, timeout_milliseconds := 30000)$cron$);
