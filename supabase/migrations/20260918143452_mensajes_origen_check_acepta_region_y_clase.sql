-- El canario de region (origen@us-west-1) y la clase de adjunto (cliente:imagen)
-- que escribe la v1.8.0 violaban el check viejo, que exigia el literal exacto.
-- Todo insert de mensajes fallaba con 23514 y sinTumbar() lo silenciaba.
-- Se valida el PREFIJO, que es lo que de verdad es un dominio cerrado.
alter table agente.mensajes drop constraint mensajes_origen_check;
alter table agente.mensajes add constraint mensajes_origen_check
  check (split_part(split_part(origen, '@', 1), ':', 1)
         = any (array['modelo','reglas','puente','cliente']));
