# -*- coding: utf-8 -*-
"""EL LOG DE PRUEBAS NO ENVENENA EL DE PRODUCCION. **D46 · D47 (Fase 6).**

─── EL DEFECTO, Y POR QUE NO ERA COSMETICO ─────────────────────────────────────

`bot/bot_gastos.py` instalaba `logging.FileHandler(RAIZ / "bot_gastos.log")` **al
importar el modulo y sin interruptor**. Cualquier prueba que hiciera
`import bot_gastos` escribia en el log de produccion.

Y eso tiene consecuencia mecanica, no estetica: `bot/decidir_reinicio.py:194`
calcula `edad_log_min` con el `mtime` de ese archivo, y `:113` reinicia el bot
cuando pasa de `TOPE_LOG_MIN = 20` minutos. **Correr la suite le reiniciaba el
reloj al detector de cuelgue.** El auditor lo comprobo causandolo el 2026-09-19:
a las 12:17:15 el `mtime` era suyo; el ultimo latido real del bot era de las
12:03:39. Un bot colgado durante una tanda de pruebas no se detectaba.

─── COMO SE MIDE, Y QUE NO SE HACE A PROPOSITO ─────────────────────────────────

Todo corre en SUBPROCESOS: importar el modulo en este mismo proceso ya instalo
su handler, asi que medirlo desde adentro no mediria nada.

**Y se mide por una MARCA unica, no por el `mtime`.** La primera version de esta
prueba comparaba el `mtime` de `bot/bot_gastos.log` antes y despues, y se puso
roja dentro de `npm run verificar` por una razon ajena al defecto: el bot de
verdad estaba corriendo y le escribio su latido al log en medio de la tanda. El
`mtime` de ese archivo es de un proceso vivo, no de quien lo mira. La marca --una
cadena que solo escribe esta corrida-- mide lo que de verdad importa y ademas es
mas estricta: un `mtime` se puede mover sin que se escriba una linea, y una
linea escrita no se puede esconder.

**Lo que esta prueba NO hace: importar el modulo sin `BOT_LOG` para ver si toca
`bot/bot_gastos.log`.** Ese seria el control negativo literal, y es justo el dano
que la prueba existe para impedir -- le moveria el `mtime` al detector de cuelgue
cada vez que corriera la suite. En su lugar el control negativo es doble y sale
igual de sharp:

  a) importar el modulo DOS veces contra un log temporal mueve el `mtime` de ese
     temporal -> o sea que importar SI toca el archivo al que apunta, y por lo
     tanto la ausencia de la marca en el de produccion significa algo;
  b) `ruta_del_log({})` --funcion pura, no abre nada-- devuelve la ruta de
     produccion -> o sea que el default no cambio y el bot de verdad sigue
     escribiendo donde escribia;
  c) una marca que SI se escribio se encuentra -> o sea que el buscador funciona
     y no esta devolviendo "no esta" por estar roto.

Corre con:  python bot/probar_log.py
"""
import os
import subprocess
import sys
import tempfile
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ_REPO = os.path.dirname(AQUI)
LOG_PRODUCCION = os.path.join(AQUI, "bot_gastos.log")

sys.path.insert(0, AQUI)

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


# La MARCA: una cadena que no puede aparecer en el log de produccion por
# casualidad. Es lo que convierte "el archivo no se movio" en "el archivo no
# recibio ESTA escritura", que es lo que de verdad se quiere saber.
MARCA = "probar_log_%d_%d" % (os.getpid(), int(time.time() * 1000))


def importar(destino, marca=MARCA):
    """Importa `bot_gastos` en un subproceso, con `BOT_LOG` puesto a `destino`.

    Se escribe una linea a proposito, **y con una marca unica**: un handler que
    se instala y nunca escribe no probaria que el archivo sea de verdad el
    destino, y una linea generica no permitiria distinguir lo que escribio esta
    prueba de lo que escribio el bot de verdad.
    """
    entorno = dict(os.environ)
    if destino is None:
        entorno.pop("BOT_LOG", None)
    else:
        entorno["BOT_LOG"] = destino
    return subprocess.run(
        [sys.executable, "-c",
         "import bot_gastos as B; B.log.info(%r); print(B.RUTA_LOG)" % marca],
        cwd=AQUI, env=entorno, capture_output=True, text=True, timeout=60)


def contiene(ruta, texto):
    if not os.path.exists(ruta):
        return False
    with open(ruta, encoding="utf-8", errors="replace") as f:
        return texto in f.read()


def marca(ruta):
    """El `mtime` de un archivo. **Solo se usa sobre el temporal**, nunca sobre
    el log de produccion: ese lo escribe el bot vivo y su `mtime` no es de
    quien lo mira. Ver el bloque de la seccion 1."""
    return os.stat(ruta).st_mtime if os.path.exists(ruta) else None


# ═══════════ 1. CON `BOT_LOG`, EL DE PRODUCCION NO SE TOCA ═══════════════════

hay_produccion = os.path.exists(LOG_PRODUCCION)

temporal = os.path.join(tempfile.mkdtemp(prefix="probar_log_"), "bot.log")
r = importar(temporal)

caso("VERDE - el modulo importa con `BOT_LOG` puesto", r.returncode, 0,
     (r.stderr or "")[-300:])
caso("VERDE - y `RUTA_LOG` apunta al temporal",
     os.path.normcase(r.stdout.strip()), os.path.normcase(temporal), r.stdout.strip())
caso("VERDE - el temporal existe y tiene la marca de esta corrida",
     contiene(temporal, MARCA), True, MARCA)

# **La asercion que importa.**
#
# ─── POR QUE SE MIDE LA MARCA Y NO EL `mtime` (2026-09-19, medido) ──────────
# Esta prueba nacio comparando el `mtime` de `bot/bot_gastos.log` antes y
# despues. Se puso roja dentro de `npm run verificar` por una razon que no tiene
# nada que ver con el defecto: **el bot de verdad estaba corriendo y le escribio
# su latido al log en medio de la tanda** (los dos valores diferian en 300.66
# segundos exactos -- el ciclo del vigilante, no una escritura de la prueba).
#
# O sea que el `mtime` de ese archivo **no es de esta prueba**: es de un proceso
# vivo que tiene todo el derecho de escribirlo. Medirlo era medir a otro.
#
# La marca unica mide lo que de verdad importa y no se puede confundir: si el
# import hubiera escrito en el log de produccion, **esta cadena estaria ahi**.
# Y es MAS estricta que el `mtime`, no menos: un `mtime` puede moverse sin que
# se escriba una linea, y una linea escrita no se puede esconder.
caso("VERDE - importar con `BOT_LOG` NO escribe en bot/bot_gastos.log",
     contiene(LOG_PRODUCCION, MARCA), False,
     "no existe el log de produccion" if not hay_produccion else MARCA)


# ═══════════ 2. CONTROL NEGATIVO (a): importar SI toca su log ════════════════
#
# Sin esto, la asercion de arriba pasaria igual si `import bot_gastos` no
# escribiera en NINGUN archivo -- que es el mismo modo de fallo de una prueba
# que da verde sin ejercitar nada.

antes_temporal = marca(temporal)
time.sleep(0.05)
r2 = importar(temporal)
caso("ROJO  - importar OTRA VEZ si mueve el mtime del log al que apunta",
     r2.returncode == 0 and marca(temporal) != antes_temporal, True,
     "%r -> %r" % (antes_temporal, marca(temporal)))

# Y que el de produccion siga sin recibir nada despues de los dos imports.
caso("VERDE - despues de DOS imports, produccion sigue sin la marca",
     contiene(LOG_PRODUCCION, MARCA), False, "")

# ── CONTROL NEGATIVO (c): la busqueda de la marca SI encuentra ──────────────
#
# Sin esto, las dos aserciones de arriba pasarian igual si `contiene` estuviera
# rota y devolviera `False` siempre -- que es el mismo modo de fallo de una
# prueba que da verde sin ejercitar nada. Se usa una marca DISTINTA, escrita en
# el temporal, para comprobar que la funcion encuentra lo que hay.
OTRA = MARCA + "_control"
r3 = importar(temporal, OTRA)
caso("ROJO  - `contiene` SI encuentra una marca que de verdad se escribio",
     r3.returncode == 0 and contiene(temporal, OTRA), True, OTRA)
caso("ROJO  - ...y esa otra marca tampoco llego a produccion",
     contiene(LOG_PRODUCCION, OTRA), False, "")


# ═══════════ 3. CONTROL NEGATIVO (b): el default no cambio ═══════════════════
#
# Funcion pura: no abre ningun archivo, asi que se puede preguntar por el
# destino de produccion sin escribir en el. Es la mitad que garantiza que el
# bot de verdad -- que corre SIN `BOT_LOG` -- sigue logueando donde siempre.

os.environ["BOT_LOG"] = temporal
import bot_gastos as B  # noqa: E402

caso("ROJO  - sin la variable, la ruta resuelta ES la de produccion",
     os.path.normcase(str(B.ruta_del_log({}))),
     os.path.normcase(LOG_PRODUCCION), "")
caso("VERDE - con la variable, resuelve a lo que diga la variable",
     str(B.ruta_del_log({"BOT_LOG": temporal})), temporal, "")
caso("ROJO  - una variable vacia NO cuenta como redireccion",
     os.path.normcase(str(B.ruta_del_log({"BOT_LOG": "   "}))),
     os.path.normcase(LOG_PRODUCCION), "")


print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-62s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
