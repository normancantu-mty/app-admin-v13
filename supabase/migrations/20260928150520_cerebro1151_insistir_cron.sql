-- cerebro-1.15.1 (2026-09-28) — N10: el cron de insistir, cada minuto. Va aparte de la funcion a proposito (E-394): la
-- funcion se corrio a mano (0 y 1 candidatos con datos de prueba) antes de agendarla.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: select cron.unschedule('insistir-datos');

select cron.schedule('insistir-datos', '* * * * *', 'select agente.insistir_datos()');
