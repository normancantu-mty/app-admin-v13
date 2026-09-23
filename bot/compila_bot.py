# -*- coding: utf-8 -*-
"""¿COMPILA el bot? El vigilante lo pregunta ANTES de matar el proceso. **D86 (Fase 8).**

El vigilante reinicia el bot cuando algun `bot/*.py` es mas nuevo que el
proceso (D21). Si ese `.py` nuevo tiene un error de sintaxis, el reinicio mata
un bot que funcionaba y arranca uno que muere en el `import`: Norman se queda
sin bot hasta que alguien lea el log. Con esto el vigilante NO reinicia, deja
vivo el bot viejo y lo dice en `vigilante.log`.

Usa `compile()` y no `py_compile`: no escribe `__pycache__`, solo lee. Un
error de sintaxis en un modulo que el bot ni importa tambien frena el
reinicio -- a proposito: es mas barato mirar un aviso de mas que perder el bot.

Uso:  python bot/compila_bot.py        -> imprime "ok" y sale 0, o
                                          "NO COMPILA <archivo>:<linea>: <error>" y sale 1
"""
import os
import sys


def errores_de_compilacion(rutas):
    """Lista de "archivo:linea: error" de los `.py` que no compilan. Pura sobre el disco: solo lee."""
    errores = []
    for ruta in sorted(rutas):
        try:
            with open(ruta, "rb") as f:
                compile(f.read(), ruta, "exec")
        except SyntaxError as e:
            errores.append("%s:%s: %s" % (os.path.basename(ruta), e.lineno, e.msg))
        except (OSError, ValueError) as e:
            errores.append("%s: %s" % (os.path.basename(ruta), e))
    return errores


def rutas_del_bot(carpeta):
    return [os.path.join(carpeta, n) for n in os.listdir(carpeta) if n.endswith(".py")]


if __name__ == "__main__":
    carpeta = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    errores = errores_de_compilacion(rutas_del_bot(carpeta))
    if errores:
        print("NO COMPILA " + "; ".join(errores))
        sys.exit(1)
    print("ok")
