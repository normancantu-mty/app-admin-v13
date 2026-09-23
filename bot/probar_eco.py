# -*- coding: utf-8 -*-
"""FASE 9 (D91) — LA GUARDA DEL ECO, PROBADA CON ENTRADAS QUE LA OBLIGAN A ACTUAR.

La auditoria de la Fase 8 lo midio: con `es_eco` apagado (`return False`),
`probar_hechos.py` seguia 46/46. Su control se apoyaba en que el MODELO ya no
repetia la venta; la guarda del CODIGO nunca se ejercitaba. Aqui las listas de
hechos se arman A MANO, con el eco dentro, y se le pasan directo a
`normaliza_hechos` (`enrutador.py`). No hay modelo, ni grabacion, ni md5.

Mutaciones que DEBEN ponerlo rojo (corridas en la copia, ver `_avance_fase9`):
  - `es_eco` -> `return False`: el eco sale como segunda venta.
  - `MAX_HECHOS = 1`: 6 hechos -> 1, no 5 (rojo por CONTENIDO, no por el md5).

Corre con:  python bot/probar_eco.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import enrutador as E  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


def hecho(intencion, **campos):
    return {"intencion": intencion, "campos": campos, "faltantes": [], "pregunta": None,
            "confianza": "alta"}


VENTA = hecho("venta", productos=[{"producto": "750", "cantidad": 1}], monto=599,
              comprador="publico")
# El eco del 2026-09-19: la misma venta dicha con otras palabras, con un campo
# que la primera no traia y SIN ninguno que la contradiga.
VENTA_ECO = hecho("venta", productos=[{"producto": "750", "cantidad": 1}],
                  condicion_pago="CONTADO")
GASTO = hecho("gasto", monto=45, descripcion="envio a domicilio")

hechos, de_mas = E.normaliza_hechos([VENTA, VENTA_ECO, GASTO])
caso("[venta, venta-eco, gasto] -> [venta, gasto]",
     [h["intencion"] for h in hechos], ["venta", "gasto"])
caso("...y la venta fundida conserva lo de las dos mitades",
     (hechos[0]["campos"].get("monto"), hechos[0]["campos"].get("condicion_pago")),
     (599, "CONTADO"))
caso("...de_mas = 0", de_mas, 0)

# CONTROL: dos ventas DISTINTAS (a Juan y a Pedro) son dos.
JUAN = hecho("venta", productos=[{"producto": "750", "cantidad": 1}], monto=599,
             comprador="Juan")
PEDRO = hecho("venta", productos=[{"producto": "750", "cantidad": 1}], monto=599,
              comprador="Pedro")
hechos, _ = E.normaliza_hechos([JUAN, PEDRO])
caso("CONTROL: dos ventas distintas -> dos", len(hechos), 2)

# CONTROL: la misma cantidad, otro producto, no es eco.
CHICA = hecho("venta", productos=[{"producto": "250", "cantidad": 1}])
hechos, _ = E.normaliza_hechos([VENTA, CHICA])
caso("CONTROL: otro producto no es eco -> dos", len(hechos), 2)

# El tope, por CONTENIDO: 6 gastos distintos -> 5 y de_mas = 1.
seis = [hecho("gasto", monto=100 + i, descripcion="gasto %d" % i) for i in range(6)]
hechos, de_mas = E.normaliza_hechos(seis)
caso("6 hechos distintos -> 5", len(hechos), 5)
caso("...de_mas = 1", de_mas, 1)
caso("...y son los 5 PRIMEROS, en orden",
     [h["campos"]["monto"] for h in hechos], [100, 101, 102, 103, 104])

# es_eco directo.
caso("es_eco(venta, venta-eco) es True", E.es_eco(VENTA, VENTA_ECO), True)
caso("CONTROL: es_eco(venta, gasto) es False", E.es_eco(VENTA, GASTO), False)
caso("CONTROL: es_eco(Juan, Pedro) es False", E.es_eco(JUAN, PEDRO), False)

todo_bien = True
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    todo_bien = todo_bien and bien
    print("  [%s] %-62s %s" % ("PASA" if bien else "FALLA", nombre,
                               "" if bien else "obtuve %r, esperaba %r" % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
