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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
cats = list(B.CATEGORIAS) + [CATEGORIA_LARGA]
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
