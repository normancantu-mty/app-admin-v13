# Conjunto de oro del cazador (WP-0)

148 casos en `casos.jsonl` (generados por `construir_casos.py`; se edita ese archivo y se regenera).
Escrito el 2026-10-17 por el ejecutor A del Socio.

## Formato de un caso
`id, categoria, persona (norman|kevin|trabajador), chat (grupo|privado), mensajes [1..4],
hechos_esperados [{tipo, campos}], pendientes_esperados [{descripcion, cuando}],
destinatario_esperado, es_charla, origen (real|sintetico)`.

Tipos de hecho: los que el bot ya conoce (`gasto, abono, venta, lote, cotizacion`) y los nuevos que
hoy cuentan como fallo (`aditivo, variable, nota, salida_vendedor, inventario_vendedor,
evento_salida, balance_evento, prestamo, devolucion_prestamo, efectivo_empresa, cobro_prometido`).
Fermentacion y envasado van como `lote` (el bot ya los cubre ahi).
Campos: clave normal = NUCLEO (comparacion estricta); clave `x_...` = EXTENDIDO (subcategoria,
evento, viaje, pagado_con...; solo cuenta en la comparacion completa).
Los pendientes cuentan como elementos esperados en la exhaustividad.

## Conteo por categoria (148)
kevin_completo 4 · kevin_variantes 4 · lote_a_medias 6 · fermentacion 5 · envasado 5 · aditivo 5 ·
variable_nueva 3 · nota 6 · viaje 9 · evento_salidas 6 · evento_gasto 3 · evento_compra 3 ·
evento_balance 3 · dinero 3 · prestamo 5 · efectivo 2 · cobro_prometido 3 · pendiente 5 ·
categoria 6 · multi_hecho 4 · correccion 4 · dirigido 4 · real 11 · consulta 2 · **charla 37 (25 %)**.
Origen: 20 reales (textos de `bot_gastos.log` y `bot_borradores`), 128 sinteticos.
Nota: `bot_gastos.log` guarda el texto crudo solo en las ~166 lineas `dijo:`; los mensajes de
Kevin/trabajadores casi no existen en el log, por eso el grueso es sintetico.

## Correr
```
python bot/oro/correr_oro.py                 # corre o reanuda (avance_<fecha>.jsonl)
python bot/oro/correr_oro.py --solo-evaluar  # re-puntua sin llamar al modelo
python bot/oro/correr_oro.py --workers 3 --fecha 2026-10-18
```
Capa medida: `enrutador.enrutar()` (claude -p --model sonnet) con `BOT_ENSAYO=1`; NO la tuberia
`manejar_texto`. Catalogo y deudores son los de ensayo (3 productos, sin deudores).
Limites de la medicion: el enrutador de hoy no emite destinatario ni pendientes (siempre 0).
Los mensajes multiples se encadenan con historial/borrador; "ajustar" fusiona sobre el ultimo hecho.

## Linea base 2026-10-17 (`resultados_2026-10-17.json`)
Precision estricta 0.685 · exhaustividad estricta 0.396 · falsos positivos en charla 0/37 (0.0).
Comparacion completa: precision 0.416, exhaustividad 0.240.
