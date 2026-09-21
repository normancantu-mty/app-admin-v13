# -*- coding: utf-8 -*-
"""El vigilante, medido. **Sin `readFileSync`: esto CORRE la decision.**

Por que existe, y no es hipotetico: el 2026-09-18 a las 10:44 arranco el proceso
del bot; el 2026-09-19 a las 09:49 se escribio la Fase 5 entera en
`bot_gastos.py`. Durante casi 24 horas el bot sirvio codigo viejo -- `/anular` no
dejaba ni una linea en el log porque para ESE proceso el comando no existia -- y
el vigilante, que corria cada 5 minutos, no dijo nada: el proceso estaba en la
lista y el log tenia lineas frescas. Sus dos condiciones eran verdaderas.

Corre con:  python bot/probar_vigilante.py

**Los controles NEGATIVOS son la mitad que importa.** El caso 5 exige que un
`.py` MAS VIEJO que el proceso NO reinicie, y el 9 que un latido rancio no
sirva de excusa para no reiniciar nunca. Una prueba que solo puede dar verde no
mide nada: un vigilante que reinicia siempre es igual de inutil que uno que no
reinicia nunca.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import decidir_reinicio as V  # noqa: E402

MIN = 60.0
AHORA = 1758300000.0          # un epoch cualquiera; el reloj es un argumento
ARRANQUE = AHORA - 26 * 60 * MIN   # el proceso lleva 26 horas arriba

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


def acciona(**hechos):
    """Corre la decision con valores por omision sanos y devuelve (accion, razon)."""
    base = dict(
        proceso_existe=True,
        arranque_proceso=ARRANQUE,
        codigo_mas_nuevo=ARRANQUE - 3 * 60 * MIN,   # codigo VIEJO por omision
        edad_log_min=2.0,
        borradores=0,
        latido_en=AHORA - 3 * MIN,
        espera_desde=None,
        ahora=AHORA,
    )
    base.update(hechos)
    return V.decidir(**base)


# --- 1 (VERDE): el caso del 2026-09-19. Proceso vivo, log fresco, codigo nuevo.
#     Esto es literalmente lo que paso y lo que el vigilante dejaba pasar.
accion, razon, _ = acciona(codigo_mas_nuevo=AHORA - 2 * 60 * MIN)
caso("VERDE - codigo mas nuevo que el proceso -> REINICIA", accion, "reiniciar", razon)

# --- 1.bis: y la razon lleva LAS DOS FECHAS, que es lo que pide D21.
caso("VERDE - la razon publica ambas fechas",
     V.fecha(AHORA - 2 * 60 * MIN) in razon and V.fecha(ARRANQUE) in razon, True,
     razon)

# --- 2 (VERDE): el proceso no existe. La condicion vieja sigue viva.
accion, razon, _ = acciona(proceso_existe=False)
caso("VERDE - sin proceso -> REINICIA", accion, "reiniciar", razon)

# --- 3 (VERDE): E-25, el cuelgue. Proceso en la lista, log de hace 41 min.
accion, razon, _ = acciona(edad_log_min=41.0)
caso("VERDE - log de 41 min -> REINICIA (colgado)", accion, "reiniciar", razon)

# --- 4 (VERDE, D23): codigo nuevo PERO hay una conversacion a medias.
#     No se tira: se espera y se anota.
accion, razon, espera = acciona(codigo_mas_nuevo=AHORA - 2 * 60 * MIN, borradores=1)
caso("VERDE - codigo nuevo con 1 borrador -> ESPERA", accion, "esperar", razon)
caso("VERDE - la espera arranca su reloj", espera, AHORA, "espera_desde=%r" % espera)

# --- 5 (CONTROL NEGATIVO, D24): EL QUE DA VALOR.
#     Un `.py` mas viejo que el proceso NO puede reiniciar. Si esto diera
#     "reiniciar", todos los verdes de arriba serian humo: querria decir que el
#     vigilante reinicia pase lo que pase, cada 5 minutos, para siempre.
accion, razon, espera = acciona()          # codigo de 3 horas ANTES del arranque
caso("ROJO  - codigo mas viejo que el proceso -> NO REINICIA", accion, "nada", razon)
caso("ROJO  - ...y ni siquiera espera", accion != "esperar", True, accion)
caso("ROJO  - ...y limpia el reloj de espera", espera, None, "espera_desde=%r" % espera)

# --- 5.bis (CONTROL NEGATIVO): con TODO en orden, la respuesta es no hacer nada.
#     Es el caso que corre 288 veces al dia. Si aqui hubiera un reinicio, el bot
#     nunca estaria mas de 5 minutos arriba.
accion, _, _ = acciona(edad_log_min=0.2, borradores=3)
caso("ROJO  - todo en orden (hasta con borradores) -> NADA", accion, "nada", "")

# --- 6 (CONTROL NEGATIVO): empate exacto. El codigo es del MISMO segundo que el
#     arranque -- es lo normal justo despues de un reinicio del propio vigilante.
#     Un `>=` en vez de `>` aqui produce un bucle de reinicios infinito.
accion, _, _ = acciona(codigo_mas_nuevo=ARRANQUE)
caso("ROJO  - codigo del mismo segundo que el arranque -> NADA", accion, "nada", "")

# --- 7 (VERDE): el cuelgue NO espera a los borradores. Un bot colgado no va a
#     terminar esa conversacion, y el conteo sale de un latido de hace 40 min.
accion, razon, _ = acciona(edad_log_min=41.0, borradores=2,
                           latido_en=AHORA - 41 * MIN)
caso("VERDE - colgado CON borradores -> REINICIA igual", accion, "reiniciar", razon)

# --- 8 (VERDE): la espera esta acotada. A los 40 min el borrador ya caduco
#     (`VIDA_DEL_BORRADOR` = 30 min) y seguir esperando solo perpetua el codigo
#     viejo. Sin este caso, un borrador olvidado congela el bot para siempre.
accion, razon, _ = acciona(codigo_mas_nuevo=AHORA - 2 * 60 * MIN, borradores=1,
                           espera_desde=AHORA - 40 * MIN)
caso("VERDE - 40 min esperando -> REINICIA (gracia vencida)", accion, "reiniciar", razon)

# --- 9 (CONTROL NEGATIVO): un latido RANCIO no cuenta como borradores.
#     Creerle a un latido de hace dos horas es como se construye un vigilante
#     que no reinicia nunca: el numero viejo siempre dice que hay conversacion.
accion, razon, _ = acciona(codigo_mas_nuevo=AHORA - 2 * 60 * MIN, borradores=5,
                           latido_en=AHORA - 120 * MIN, edad_log_min=3.0)
caso("ROJO  - latido de 2 h con 5 borradores -> REINICIA igual", accion, "reiniciar", razon)

# --- 10: el lector del log. Se prueba con un log de verdad, con trafico
#     despues del latido -- que es el caso real: el ultimo renglon del log casi
#     nunca es el latido.
LOG = "\n".join([
    "2026-09-19 11:18:39,279 INFO latido: vivo, 0 borrador(es) en memoria",
    "2026-09-19 11:33:39,277 INFO latido: vivo, 2 borrador(es) en memoria",
    "2026-09-19 11:35:02,001 INFO enrutado como venta (confianza alta)",
    "2026-09-19 11:35:03,110 INFO propuesta: venta 3 renglones",
])
n, cuando = V.ultimo_latido(LOG)
caso("VERDE - lee el ULTIMO latido, no el ultimo renglon", n, 2, "borradores=%r" % n)
caso("VERDE - y su hora", cuando is not None
     and V.fecha(cuando) == "2026-09-19 11:33:39", True, V.fecha(cuando))

# --- 10.bis: el formato NUEVO del latido (D22), con arranque y codigo pegados.
LOG_NUEVO = ("2026-09-19 11:48:39,281 INFO latido: vivo, 1 borrador(es) en memoria"
             " | arranque 2026-09-19 10:44:02 | codigo 2026-09-19 09:49:11")
n2, _ = V.ultimo_latido(LOG_NUEVO)
caso("VERDE - lee tambien el latido nuevo de D22", n2, 1, "borradores=%r" % n2)

# --- 10.ter (CONTROL NEGATIVO): un log SIN latidos no puede inventar un conteo.
n3, cuando3 = V.ultimo_latido("2026-09-19 11:35:02,001 INFO arrancando bot")
caso("ROJO  - log sin latidos -> 0 y sin hora", (n3, cuando3), (0, None), "")

# --- 11: los hechos que se leen del DISCO, contra un directorio de verdad.
#     Es la parte que antes vivia en PowerShell y que nadie podia probar.
import shutil     # noqa: E402
import tempfile   # noqa: E402

carpeta = tempfile.mkdtemp(prefix="vigilante_")
try:
    viejo = os.path.join(carpeta, "viejo.py")
    nuevo = os.path.join(carpeta, "nuevo.py")
    ruido = os.path.join(carpeta, "notas.txt")     # no es .py: no debe contar
    bitacora = os.path.join(carpeta, "bot_gastos.log")
    for ruta, texto in ((viejo, "a=1"), (nuevo, "b=2"), (ruido, "x"),
                        (bitacora, LOG + "\n")):
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(texto)
    # Fechas puestas a mano: 10 h, 2 h y --el .txt-- 1 minuto de antiguedad.
    os.utime(viejo, (AHORA - 10 * 60 * MIN, AHORA - 10 * 60 * MIN))
    os.utime(nuevo, (AHORA - 2 * 60 * MIN, AHORA - 2 * 60 * MIN))
    os.utime(ruido, (AHORA - 1 * MIN, AHORA - 1 * MIN))
    os.utime(bitacora, (AHORA - 4 * MIN, AHORA - 4 * MIN))

    codigo, edad_log, borradores, latido_en = V.hechos_de(carpeta, bitacora, AHORA)
    caso("VERDE - toma el .py MAS NUEVO", codigo, AHORA - 2 * 60 * MIN,
         "codigo=%s" % V.fecha(codigo))
    caso("ROJO  - un .txt mas nuevo NO cuenta como codigo",
         codigo != AHORA - 1 * MIN, True, "")
    caso("VERDE - mide la edad del log", round(edad_log), 4.0, "%.1f min" % edad_log)
    caso("VERDE - saca los borradores del log real", borradores, 2, "")

    # Y sin log: ni edad ni borradores inventados.
    os.remove(bitacora)
    _, edad2, borr2, latido2 = V.hechos_de(carpeta, bitacora, AHORA)
    caso("ROJO  - sin log -> nada inventado", (edad2, borr2, latido2), (None, 0, None), "")
finally:
    shutil.rmtree(carpeta, ignore_errors=True)

print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-52s  %s" % ("PASA" if bien else "FALLA", nombre, detalle))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
