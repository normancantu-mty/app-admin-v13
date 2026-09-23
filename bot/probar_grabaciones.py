# -*- coding: utf-8 -*-
"""EL PROMPT Y EL CODIGO QUE LO CONSUME, AMARRADOS. **D65 · D66 (Fase 7).**

─── EL DEFECTO ─────────────────────────────────────────────────────────────────

El productor (el PROMPT, prosa) y el consumidor (Python) vivian en dos lugares,
escritos por dos manos, y nada los amarraba: `probar_promesas.py` paso verde
toda la Fase 6 con la regla 19 ausente, porque le entregaba al codigo una
salida del modelo escrita a mano (auditoria Fase 6, §12.4).

─── QUE SE MIDE AQUI ───────────────────────────────────────────────────────────

1. **La caducidad.** Las grabaciones de `grabaciones_enrutador.json` se hicieron
   con el PROMPT de hoy (md5). Si alguien lo edita, esto se pone ROJO con
   "cambiaste el PROMPT: vuelve a grabar". Es lo que hace que borrar la regla
   19 ponga algo rojo.
2. **Cobertura.** Cada frase de `FRASES` tiene su grabacion.
3. **Productor -> consumidor, con salidas REALES:** lo que el modelo emitio en
   `campos.cliente` para las cinco frases de D50 lo reconoce
   `_dice_el_mismo`; el control con nombre ("aeropuerto") no.
4. **Una sola fuente (D65):** el PROMPT armado contiene cada valor de las tuplas
   que el codigo compara, y ninguna marca `<<...>>` sin llenar.
5. **CONTROL NEGATIVO, en el proceso:** un PROMPT con UNA frase de la regla 19
   de menos (o la regla entera) no pasa `cargar`.

Corre con:  python bot/probar_grabaciones.py      (sin red, sin modelo)
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


# ═══ 1. La caducidad ══════════════════════════════════════════════════════════

try:
    datos = G.cargar()
    caducada = None
except G.PromptCambiado as e:
    datos, caducada = None, str(e)
caso("las grabaciones son del PROMPT de hoy (si no: vuelve a grabar)", caducada, None)

if datos:
    frases = datos["frases"]

    # ═══ 2. Cobertura ═════════════════════════════════════════════════════════
    faltan = [f[0] for f in G.FRASES if f[0] not in frases]
    caso("cada frase de FRASES tiene su grabacion", faltan, [])
    caso("las grabaciones traen al menos las de D48, D49, D50, D64 y D67",
         sorted({"d48", "d49", "d50", "d64", "d67"} - {c.split("_")[0] for c in frases}), [])

    # ═══ 3. Productor -> consumidor, con salidas reales ═══════════════════════
    for clave in sorted(c for c in frases if c.startswith("d50_") and "control" not in c):
        salida = frases[clave]["salida"]
        cliente = (salida.get("campos") or {}).get("cliente")
        caso("D50 %s: el modelo real emitio %r y el bot lo reconoce como 'el mismo'"
             % (clave, cliente), B._dice_el_mismo(cliente), True)
    control = (frases["d50_control_con_nombre"]["salida"].get("campos") or {}).get("cliente")
    caso("D50 control: con nombre (%r) NO es 'el mismo'" % control,
         B._dice_el_mismo(control), False)

    # ═══ 3b. FASE 9: lo que el modelo real emite para D90, D99 y D100 ═════════
    def sal(clave):
        return frases[clave]["salida"]

    def cps(clave):
        return sal(clave).get("campos") or {}

    def piezas(campos):
        return sum(int(x.get("cantidad") or 0) for x in campos.get("productos") or [])

    caso("FASE 9: estan las grabaciones de D90, D99 y D100",
         sorted({"d90", "d99", "d100"} - {c.split("_")[0] for c in frases}), [])
    v = cps("d90_vendi_publico_2900")
    caso("D90 venta: publico en general, 5 piezas, monto 2900 (el servidor lo vuelve total_final)",
         (sal("d90_vendi_publico_2900")["intencion"], v.get("comprador"), v.get("monto"), piezas(v)),
         ("venta", "publico en general", 2900, 5))
    c = cps("d90_cotiza_publico_15")
    caso("D90 cotizacion: publico en general, 30 piezas, 15%",
         (sal("d90_cotiza_publico_15")["intencion"], c.get("cliente"),
          (c.get("descuento") or {}).get("porcentaje"), piezas(c)),
         ("cotizacion", "publico en general", 15, 30))
    caso("D99: 'a como le sale a aeropuerto?' es consulta precios de Aeropuerto",
         (sal("d99_precios_aeropuerto")["consulta"], str(sal("d99_precios_aeropuerto")["filtro"]).lower()),
         ("precios", "aeropuerto"))
    caso("D99: 'precios' solo es consulta precios sin filtro",
         (sal("d99_precios_solo")["consulta"], sal("d99_precios_solo")["filtro"]), ("precios", None))
    caso("D99 CONTROL: con cantidades es cotizacion, no consulta",
         sal("d99_control_cotizacion")["intencion"], "cotizacion")
    caso("D100: Kevin en grupo captura el gasto igual (300)",
         (sal("d100_grupo_kevin_gasto")["intencion"], cps("d100_grupo_kevin_gasto").get("monto")),
         ("gasto", 300))
    caso("D100: a Kevin no le contesta como si fuera Norman",
         "norman" in str(sal("d100_grupo_kevin_gasto").get("respuesta")).lower(), False)
    caso("D100: con historial rotulado 'Kevin', 'y la deuda?' sabe de quien",
         (sal("d100_grupo_historial_kevin")["consulta"],
          str(sal("d100_grupo_historial_kevin")["filtro"]).lower()), ("cartera", "aeropuerto"))

# ═══ 4. Una sola fuente ═══════════════════════════════════════════════════════

caso("el PROMPT armado no deja marcas sin llenar", "<<" in E.PROMPT, False)
for tupla, formato in ((E.INTENCIONES, "%s"), (E.CONSULTAS, "%s"),
                       (E.TIPOS_DE_HECHO, "%s"),
                       (E.NIVELES_DE_CONFIANZA, '"%s"'),
                       (E.FORMAS_DEL_MISMO, '**"%s"**'),
                       (E.AFIRMACIONES_EXPLICITAS, '"%s"')):
    ausentes = [v for v in tupla if (formato % v) not in E.PROMPT]
    caso("el PROMPT contiene cada valor de %s" % (tupla[:2],), ausentes, [])
for forma in E.FORMAS_DEL_MISMO:
    caso("regla 19 -> consumidor: %r empata en _dice_el_mismo" % forma,
         B._dice_el_mismo(forma), True)
# Y el armado falla ruidoso si le quitan una marca (no arranca mintiendo).
try:
    E._armar_prompt("sin marcas")
    armado = "armo sin marcas"
except RuntimeError:
    armado = "fallo"
caso("una plantilla sin sus marcas NO se arma", armado, "fallo")

# ═══ 5. CONTROL NEGATIVO: un PROMPT distinto no pasa ═════════════════════════

FRASE_DE_LA_19 = "**Tu no adivines el nombre: nunca pongas en \"cliente\" un nombre que Norman no"
caso("(la frase que se quita existe en el PROMPT)", FRASE_DE_LA_19 in E.PROMPT, True)
inicio = E.PROMPT.find("19. **SI SE REFIERE AL CLIENTE ANTERIOR")
fin = E.PROMPT.find("20. **")
caso("(la regla 19 existe en el PROMPT)", 0 < inicio < fin, True)
for nombre, mutado in (
        ("una frase de la regla 19 de menos", E.PROMPT.replace(FRASE_DE_LA_19, "", 1)),
        ("la regla 19 entera de menos", E.PROMPT[:inicio] + E.PROMPT[fin:]),
        ("un espacio de mas al final", E.PROMPT + " ")):
    try:
        G.cargar(mutado)
        resultado = "paso"
    except G.PromptCambiado as e:
        resultado = "vuelve a grabar" if "vuelve a grabar" in str(e) else str(e)
    caso("CONTROL: con %s, `cargar` dice 'vuelve a grabar'" % nombre,
         resultado, "vuelve a grabar")


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
