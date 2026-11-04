# -*- coding: utf-8 -*-
"""Corre TODAS las pruebas `bot/probar_*.py` y dice cuantas salieron rojas.

Nacio de la auditoria del 2026-11-04: un informe citaba "correr_pruebas.py:
ROJOS 0 de 31" y el archivo no existia en la rama. Un conteo que nadie puede
volver a correr no es evidencia.

Cada prueba corre en SU proceso (varias cargan `bot_gastos` con estado global),
con `ERP_API_URL` apuntando a un puerto muerto: ninguna prueba de esta lista
puede tocar el ERP real aunque alguien tenga el `.env` puesto.

Uso:
    python bot/correr_pruebas.py            # todas
    python bot/correr_pruebas.py clasif     # solo las que contengan "clasif"

Sale 0 solo si no hubo rojos Y si encontro al menos una prueba.

Una prueba que sale 0 diciendo SALTADA no probo nada, y no cuenta como ok: va aparte
y con su nombre. `ok*` corrio, pero se salto un tramo (lo dice su salida).
"""
import concurrent.futures
import glob
import os
import re
import subprocess
import sys
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
TOPE_S = 600
TRABAJADORES = 6


def correr(ruta):
    entorno = dict(os.environ)
    entorno["PYTHONIOENCODING"] = "utf-8"
    entorno["ERP_API_URL"] = "http://127.0.0.1:9"
    inicio = time.time()
    try:
        p = subprocess.run([sys.executable, ruta], cwd=os.path.dirname(AQUI), env=entorno,
                           capture_output=True, timeout=TOPE_S)
        codigo, salida = p.returncode, (p.stdout + p.stderr).decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        codigo, salida = "TOPE", ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", "replace")
    return os.path.basename(ruta), codigo, salida, time.time() - inicio


def estado(codigo, salida):
    """Que fue de una prueba. **Pura.** Salir 0 no basta para decir ok."""
    if codigo != 0:
        return "ROJO"
    if re.search(r"^RESULTADO: SALTADA", salida, re.M):
        return "SALTADA"
    return "ok*" if "SALTADA" in salida else "ok"


def resumen(filas):
    """El conteo final de `[(nombre, estado)]`. **Pura.** El total son las que corrieron."""
    de = lambda e: [n for n, x in filas if x == e]  # noqa: E731
    saltadas, tramo = de("SALTADA"), de("ok*")
    lineas = ["ROJOS %d de %d corridas" % (len(de("ROJO")), len(filas) - len(saltadas))]
    if saltadas:
        lineas.append("SALTADAS %d (no probaron nada): %s" % (len(saltadas), ", ".join(saltadas)))
    if tramo:
        lineas.append("CON TRAMO SALTADO %d (el resto corrio): %s" % (len(tramo), ", ".join(tramo)))
    return "\n".join(lineas)


def main():
    filtro = sys.argv[1] if len(sys.argv) > 1 else ""
    rutas = sorted(r for r in glob.glob(os.path.join(AQUI, "probar_*.py"))
                   if filtro in os.path.basename(r))
    if not rutas:
        print("ROJOS: ninguna prueba casa con %r" % filtro)
        return 1
    rojos, filas = [], []
    with concurrent.futures.ThreadPoolExecutor(TRABAJADORES) as ex:
        for nombre, codigo, salida, seg in ex.map(correr, rutas):
            cual = estado(codigo, salida)
            filas.append((nombre, cual))
            print("%-7s %-34s %5.1fs" % (cual, nombre, seg))
            if cual in ("SALTADA", "ok*"):
                print("        " + next(x for x in salida.splitlines() if "SALTADA" in x).strip())
            if codigo != 0:
                rojos.append((nombre, codigo, salida))
    for nombre, codigo, salida in rojos:
        print("\n--- %s (salida %s), ultimas lineas ---" % (nombre, codigo))
        print("\n".join(salida.strip().splitlines()[-15:]))
    print("\n" + resumen(filas))
    return 1 if rojos else 0


if __name__ == "__main__":
    sys.exit(main())
