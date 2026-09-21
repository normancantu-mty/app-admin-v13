"""Centinela del tope de 64 bytes de `callback_data` de Telegram.

Por que existe, y no es hipotetico: el 2026-09-12 11:22:15 el bot reventó con
`telegram.error.BadRequest: Button_data_invalid` al armar el teclado de
categorias (`bot_gastos.log`, desde `bot_gastos.py:312`). El usuario no ve un
error -- ve que el bot NO CONTESTA. Un limite de protocolo que solo se nota en
produccion necesita una prueba que corra en frio.

No llama a Telegram ni a la red: arma los teclados y mide los bytes.
Corre con:  python bot/probar_callback_data.py

Los controles NEGATIVOS son la mitad que importa: si la prueba solo puede dar
verde, no mide nada. El caso 5 exige que la formula VIEJA siga fallando -- si
alguien la reintroduce, esta prueba lo caza.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46 (Fase 6): **el log va a un temporal, y esta linea tiene que ir ANTES del
# import.** `bot_gastos` instala su `FileHandler` al importarse; sin esto, correr
# esta prueba escribe en `bot/bot_gastos.log` y le reinicia el reloj al detector
# de cuelgue de `decidir_reinicio.py`, que mide por el `mtime` de ese archivo.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

TOPE = 64

# Un uuid4 real es de 36 caracteres. Es lo que trae un borrador_id.
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"

# Peor caso realista: el servidor devuelve categorias creadas con el uso, y
# nadie le puso un limite de largo a ese texto.
CATEGORIA_LARGA = "Salida socios y gastos de representacion del trimestre"


def _datos(teclado):
    salida = []
    for fila in teclado.inline_keyboard:
        for boton in fila:
            salida.append(boton.callback_data)
    return salida


def _mide(nombre, teclado):
    """Devuelve (ok, peor_dato, peor_largo)."""
    peor, largo = "", 0
    for d in _datos(teclado):
        n = len(d.encode("utf-8"))
        if n > largo:
            peor, largo = d, n
    return largo <= TOPE, peor, largo


casos = []

# --- 1 (VERDE): categorias, con un nombre largo de verdad.
cats = list(B.CATEGORIAS_SEMILLA) + [CATEGORIA_LARGA]
ok, peor, largo = _mide("categorias", B._teclado_categorias(cats))
casos.append(("VERDE - categorias con nombre de 53 chars", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

# --- 2 (VERDE): cuentas por indice.
cuentas = [dict(id=UUID, nombre="Cuenta " + CATEGORIA_LARGA) for _ in range(3)]
ok, peor, largo = _mide("cuentas", B._teclado_cuentas(cuentas))
casos.append(("VERDE - cuentas por indice", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

# --- 3 (VERDE): deudores por indice.
deudores = [dict(id_entidad=UUID, nombre=CATEGORIA_LARGA, rol="DST") for _ in range(3)]
ok, peor, largo = _mide("deudores", B._teclado_deudores(deudores))
casos.append(("VERDE - deudores por indice", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

# --- 4 (VERDE): los teclados de confirmar, que SI llevan el uuid.
#     Aqui el uuid cabe porque el prefijo es corto; la prueba fija ese margen.
ok, peor, largo = _mide("confirmar", B._teclado_confirmar(UUID))
casos.append(("VERDE - confirmar gasto (lleva uuid)", ok, True,
              "peor=%r %d bytes" % (peor, largo)))
ok2, peor2, largo2 = _mide("confirmar_abono", B._teclado_confirmar_abono(UUID))
casos.append(("VERDE - confirmar abono (lleva uuid)", ok2, True,
              "peor=%r %d bytes" % (peor2, largo2)))

# --- 4.bis (VERDE): los teclados de la FASE 5 (anular y corregir).
#     El de movimientos es el que mas riesgo tiene: la etiqueta lleva la fecha,
#     el monto Y el concepto, y el concepto lo escribio una persona sin limite.
#     Por eso el `callback_data` va por INDICE y la etiqueta se queda en el
#     TEXTO del boton, que no tiene tope de 64 bytes.
movimientos = [
    dict(tabla="finanzas", id=UUID, etiqueta="19 sep · $1,234.00 · " + CATEGORIA_LARGA,
         detalle="da igual", valores=None, arrastra_venta=False)
    for _ in range(8)
]
ok, peor, largo = _mide("movimientos", B._teclado_movimientos(movimientos))
casos.append(("VERDE - movimientos a anular por indice", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

ok, peor, largo = _mide("confirmar_anulacion", B._teclado_confirmar_anulacion(UUID))
casos.append(("VERDE - confirmar anulacion (lleva uuid)", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

ok, peor, largo = _mide("campos_corregibles", B._teclado_campos_corregibles())
casos.append(("VERDE - que campo se corrige", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

# --- 4.quater (VERDE): los teclados de los PASOS 5 y 6 (alta y conversion).
#     El de conversion es el peor caso nuevo: la etiqueta junta folio, fecha,
#     total Y el nombre del comprador, que no tiene tope de largo. Por eso el
#     `callback_data` es "setcnv:<indice>" y todo lo demas se queda en el TEXTO.
zonas = [dict(valor="Zacatecas", etiqueta="Zacatecas"),
         dict(valor="Foraneo", etiqueta="Foraneo")]
ok, peor, largo = _mide("alta_zonas", B._teclado_alta(zonas))
casos.append(("VERDE - zona/rol del alta por indice", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

cotizaciones = [
    dict(id=UUID, etiqueta="COT-0007 · 2026-09-19 · $12,345.00",
         detalle=CATEGORIA_LARGA, estado="VIGENTE")
    for _ in range(8)
]
ok, peor, largo = _mide("conversion", B._teclado_conversion(cotizaciones))
casos.append(("VERDE - cotizaciones a convertir por indice", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

ok, peor, largo = _mide("confirmar_alta", B._teclado_confirmar_alta(UUID))
casos.append(("VERDE - confirmar alta (lleva uuid)", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

ok, peor, largo = _mide("confirmar_conversion", B._teclado_confirmar_conversion(UUID))
casos.append(("VERDE - confirmar conversion (lleva uuid)", ok, True,
              "peor=%r %d bytes" % (peor, largo)))

# --- 4.quinquies (CONTROL NEGATIVO): la zona NO puede viajar en el dato.
#     Es la tentacion concreta de D9 -- "total, son dos palabras cortas" -- y con
#     un uuid de borrador delante ya no cabe. Ademas un texto en el
#     `callback_data` es un texto que alguien puede escribir a mano, y ese texto
#     va directo contra el CHECK de `entidades.zona`.
tentacion_zona = "setalta:" + UUID + ":Zacatecas:" + CATEGORIA_LARGA
casos.append(("ROJO  - setalta:<uuid>:<zona>:<nombre>",
              len(tentacion_zona.encode("utf-8")) > TOPE, True,
              "%d bytes > %d" % (len(tentacion_zona.encode("utf-8")), TOPE)))

# --- 4.ter (CONTROL NEGATIVO): la etiqueta NO puede acabar en el callback_data.
#     Si alguien "simplifica" mandando el texto del movimiento en el dato del
#     boton, revienta con el mismo Button_data_invalid de septiembre. Esta linea
#     mide esa tentacion concreta, no una hipotetica.
tentacion = "setanu:" + movimientos[0]["etiqueta"]
casos.append(("ROJO  - setanu:<etiqueta del movimiento>",
              len(tentacion.encode("utf-8")) > TOPE, True,
              "%d bytes > %d" % (len(tentacion.encode("utf-8")), TOPE)))

# --- 5 (CONTROL NEGATIVO): la formula VIEJA tiene que seguir reventando.
#     Si esto diera verde, la prueba de arriba no probaria nada: querria decir
#     que el tope no muerde ni siquiera en el caso que ya reventó en produccion.
viejo = "setcat:" + UUID + ":" + CATEGORIA_LARGA
casos.append(("ROJO  - formula vieja setcat:<uuid>:<nombre>",
              len(viejo.encode("utf-8")) > TOPE, True,
              "%d bytes > %d" % (len(viejo.encode("utf-8")), TOPE)))

# --- 6 (CONTROL NEGATIVO): y el medidor tiene que saber decir que NO.
teclado_malo = B.InlineKeyboardMarkup(
    [[B.InlineKeyboardButton("x", callback_data="z" * 65)]])
ok, peor, largo = _mide("sintetico", teclado_malo)
casos.append(("ROJO  - teclado sintetico de 65 bytes", ok, False,
              "%d bytes" % largo))

print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    marca = "PASA" if obtenido == esperado else "FALLA"
    if obtenido != esperado:
        todo_bien = False
    print("  [%s] %-44s  %s" % (marca, nombre, detalle))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
