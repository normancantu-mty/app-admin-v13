# -*- coding: utf-8 -*-
"""COMISIONES CON DECIMALES (17.5 / 12.5) -- el tramo de Python. 2026-11-27.

Norman, de voz, el 27-nov, sobre los distribuidores de Gilberto: «dejalos asi
como con puntos... que sea la excepcion». 17.5% cuando vende el distribuidor y
12.5% cuando vende un local suyo.

QUE MIDE: que la respuesta escrita a "que comision se lleva..." salga de
`_comision_de_texto` con punto decimal, sin "%" y SIN redondear -- coma o punto.
La conversion a fraccion, el redondeo a dos decimales de porcentaje y los avisos
viven en el servidor (`lib/bot-entidad.ts`, `tests/comision-decimal.spec.ts`).

CONTROL NEGATIVO: el codigo viejo (`texto.replace("%", "").strip()`) deja
"17,5" con coma, que el servidor viejo leia como NaN ("No lo lei como un
porcentaje") y la alta se moria en el chat. La prueba lo comprueba contra la
expresion vieja para que no se pueda "arreglar" quitando el caso.

Corre con:  python bot/probar_comision_decimal.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

FALLAS = []


def esperar(nombre, obtenido, esperado):
    ok = obtenido == esperado
    print(("ok   " if ok else "ROJO ") + nombre + " -> " + repr(obtenido) + ("" if ok else " (esperaba %r)" % esperado))
    if not ok:
        FALLAS.append(nombre)


def viejo(texto):
    return texto.replace("%", "").strip()


CASOS = [
    ("17.5", "17.5"),
    ("17,5", "17.5"),
    ("17,5 %", "17.5"),
    ("12.5%", "12.5"),
    ("12,5 por ciento", "12.5"),
    ("25", "25"),
    (" 20 % ", "20"),
    ("0.175", "0.175"),
    # No es numero: se manda tal cual, el servidor vuelve a preguntar.
    ("veinte", "veinte"),
]

for entrada, esperado in CASOS:
    esperar("comision %r" % entrada, B._comision_de_texto(entrada), esperado)

# Que el valor salga numerico de verdad para los casos de Gilberto.
for entrada, numero in (("17,5", 17.5), ("12,5", 12.5), ("17.5 %", 17.5)):
    esperar("float(%r)" % entrada, float(B._comision_de_texto(entrada)), numero)

# CONTROL NEGATIVO: el codigo viejo dejaba la coma, y float() revienta.
try:
    float(viejo("17,5"))
    esperar("CONTROL NEGATIVO: lo viejo NO entendia '17,5'", "lo entendio", "ValueError")
except ValueError:
    esperar("CONTROL NEGATIVO: lo viejo NO entendia '17,5'", "ValueError", "ValueError")

# Y que el manejador del alta use el ayudante y no la expresion vieja.
fuente = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot_gastos.py"), encoding="utf-8").read()
esperar("el alta usa _comision_de_texto", "comisiones[campo_alta] = _comision_de_texto(texto)" in fuente, True)
esperar("ya no queda la expresion vieja", 'comisiones[campo_alta] = texto.replace("%", "").strip()' in fuente, False)

print("RESULTADO: " + ("ok" if not FALLAS else "ROJO %d: %s" % (len(FALLAS), ", ".join(FALLAS))))
sys.exit(1 if FALLAS else 0)
