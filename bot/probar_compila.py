# -*- coding: utf-8 -*-
"""El vigilante no reinicia hacia un bot que no compila. **D86 (Fase 8).**

`compila_bot.py` decide; `vigilar_bot.ps1` solo obedece. Aqui:
1. VERDE: el `bot/` de hoy compila.
2. ROJO (control negativo): una carpeta con un `.py` roto da el archivo y la
   linea, y el script sale 1 -- que es lo que el `.ps1` lee para NO reiniciar.
3. `compile()` no deja `__pycache__` (solo lee).

Corre con:  python bot/probar_compila.py      (sin red, sin modelo)
"""
import os
import shutil
import subprocess
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import compila_bot as C  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


caso("VERDE - el bot/ de hoy compila", C.errores_de_compilacion(C.rutas_del_bot(AQUI)), [])

carpeta = tempfile.mkdtemp(prefix="compila_")
try:
    with open(os.path.join(carpeta, "bueno.py"), "w", encoding="utf-8") as f:
        f.write("x = 1\n")
    caso("VERDE - carpeta sana", C.errores_de_compilacion(C.rutas_del_bot(carpeta)), [])
    r = subprocess.run([sys.executable, os.path.join(AQUI, "compila_bot.py"), carpeta],
                       capture_output=True, text=True)
    caso("VERDE - el script dice ok y sale 0", (r.returncode, r.stdout.strip()), (0, "ok"))

    with open(os.path.join(carpeta, "roto.py"), "w", encoding="utf-8") as f:
        f.write("def f(:\n    pass\n")
    errores = C.errores_de_compilacion(C.rutas_del_bot(carpeta))
    caso("ROJO  - el .py roto se nombra con su linea",
         [e.split(":")[0] + ":" + e.split(":")[1] for e in errores], ["roto.py:1"])
    r = subprocess.run([sys.executable, os.path.join(AQUI, "compila_bot.py"), carpeta],
                       capture_output=True, text=True)
    caso("ROJO  - el script sale 1 y dice NO COMPILA",
         (r.returncode, r.stdout.startswith("NO COMPILA roto.py:1")), (1, True))
    caso("solo lee: no deja __pycache__", os.path.exists(os.path.join(carpeta, "__pycache__")), False)
finally:
    shutil.rmtree(carpeta, ignore_errors=True)

fallos = 0
for nombre, obtenido, esperado in casos:
    ok = obtenido == esperado
    fallos += 0 if ok else 1
    print(("OK   " if ok else "FALLA") + " " + nombre
          + ("" if ok else "\n       obtenido: %r\n       esperado: %r" % (obtenido, esperado)))
print()
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (fallos, len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
