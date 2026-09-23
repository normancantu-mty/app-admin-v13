# -*- coding: utf-8 -*-
"""ENVASAR ES LOTE Y "CUANTO SE HIZO" ES CONSULTA. **D81 · D83 (Fase 8).**

Con salidas REALES del modelo (`grabaciones_enrutador.json`, PROMPT de hoy):

1. D81 -- "hoy envasamos 24 de 750" es un lote SIN faltantes, y lo que el bot
   le manda a `/api/bot/lote/proponer` trae solo envasado (ni insumos, ni
   tandas, ni fermentacion). Eso es lo que la ruta lee como "agregar a un lote
   que ya existe" (`esAgregarALote`, `lib/bot-envasado.ts`).
   Y un lote NUEVO sin chile se abre igual (nada obligatorio); CONTROL: un gasto
   sin monto SI sigue pidiendo el monto (regla 11).
2. D83 -- "cuantas botellas se hicieron hoy / esta semana / del lote X" es la
   consulta `produccion` y el filtro (periodo o lote) sobrevive a `_normaliza`.
   CONTROL: "cuanto vendimos este mes" es `ventas`, y en `ventas` el filtro se
   tira aunque el modelo mande uno.

Corre con:  python bot/probar_envasado.py      (sin red, sin modelo)
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46: el log va a un temporal. ANTES del import; ver `probar_log.py`.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import enrutador as E  # noqa: E402
import grabar_enrutador as G  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


def solo_envasado(peticion):
    p = peticion["propuesta"]
    return (bool(peticion["envasado"]) and not peticion["insumos"] and not p.get("tandas")
            and not any(p.get(k) for k in ("dias_fermentacion", "horas_fermentacion", "fecha_inicio")))


# ═══ 1. D81 ══════════════════════════════════════════════════════════════════

for clave, codigo in (("d81_envasamos_24", None), ("d81_envasado_con_lote", "L-0915")):
    s = G.grabada(clave)
    caso(clave + ": es lote", s["intencion"], "lote")
    caso(clave + ": no le falta nada (envasar no pide chile)", s["faltantes"], [])
    pet = B._peticion_de_lote(s["campos"])
    caso(clave + ": la peticion trae SOLO envasado", solo_envasado(pet), True)
    caso(clave + ": el envasado lleva botellas y formato",
         all(e.get("botellas") and e.get("formato") for e in pet["envasado"]), True)
    caso(clave + ": codigo de lote", pet["propuesta"].get("codigo_lote"), codigo)

# D81, segunda mitad: "el lote se abre con todas sus variables opcionales".
s = G.grabada("d81_control_lote_nuevo_sin_chile")
caso("d81: lote nuevo sin chile se abre (no falta nada)", s["faltantes"], [])
caso("CONTROL d81: y su peticion NO es solo envasado (es un lote NUEVO, no agregar)",
     solo_envasado(B._peticion_de_lote(s["campos"])), False)
# CONTROL: la regla 11 sigue pidiendo lo indispensable de lo demas.
gasto = G.grabada("d80_gasto_incompleto_y_venta")["hechos"][0]
caso("CONTROL regla 11: un gasto sin monto SI pide el monto",
     (gasto["intencion"], "monto" in gasto["faltantes"]), ("gasto", True))

# ═══ 2. D83 ══════════════════════════════════════════════════════════════════

caso("produccion es una consulta que se contesta", "produccion" in E.CONSULTAS_QUE_CONTESTA, True)
for clave, filtro in (("d83_hoy", "hoy"), ("d83_semana", "semana"), ("d83_lote", "L-0915")):
    s = G.grabada(clave)
    caso(clave + ": consulta produccion", (s["intencion"], s["consulta"]), ("consulta", "produccion"))
    caso(clave + ": el filtro llega", s["filtro"], filtro)

s = G.grabada("d83_control_ventas")
caso("CONTROL d83: vender no es producir", s["consulta"], "ventas")
crudo = {"intencion": "consulta", "consulta": "ventas", "filtro": "mes", "respuesta": "x", "entendido": "x"}
caso("CONTROL d83: en ventas el filtro se tira", E._normaliza(crudo)["filtro"], None)
crudo["consulta"] = "produccion"
caso("y en produccion se conserva", E._normaliza(crudo)["filtro"], "mes")


# ─── Resultado ───────────────────────────────────────────────────────────────

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
