-- Fase 8, D79 (2026-09-22): VARIOS BORRADORES PENDIENTES POR PERSONA.
-- Norman: "muchas veces en un solo mensaje implica varios movimientos... te van a
-- esperar a mi respuesta con el boton". Cada hecho es su borrador y su boton VA.
-- El UNIQUE parcial bot_borradores_uno_pendiente lo hacia imposible (23505).
-- La ambiguedad que cuidaba (un "va" escrito con dos abiertos) la resuelve ahora
-- el bot: con 2+ pendientes el "va" escrito NO confirma, pide el boton de cada uno.
-- Las rutas */proponer siguen cancelando lo PENDIENTE por default; solo con
-- conservar_pendientes=true se suman.
-- NO toca ninguna fila. Reversible: recrear el UNIQUE (antes, cancelar sobrantes).
create index if not exists bot_borradores_pendientes_por_persona
  on public.bot_borradores (telegram_id, creado_en desc)
  where estado = 'PENDIENTE';
drop index if exists public.bot_borradores_uno_pendiente;
