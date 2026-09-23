# -*- coding: utf-8 -*-
"""GRABACIONES REALES DEL MODELO, CON FECHA DE CADUCIDAD. **D66 (Fase 7).**

─── EL DEFECTO QUE CIERRA (auditoria Fase 6, §12.4) ─────────────────────────────

`probar_promesas.py` le entregaba al codigo `{"cliente": "el mismo cliente"}`
con el enrutador doblado. **El modelo real no emitia eso** hasta que se agrego la
regla 19 al PROMPT el 2026-09-21: la prueba paso verde toda la Fase 6 con `D50`
roto, y seguiria verde si alguien borrara la regla 19. Una prueba que dobla al
modelo con una salida que el modelo real nunca produce no prueba nada.

─── LO QUE HACE ────────────────────────────────────────────────────────────────

`python bot/grabar_enrutador.py` corre el modelo REAL (`enrutar`, o sea
`claude -p --model sonnet`) sobre `FRASES` y guarda, por frase, la salida ya
normalizada -- la misma que recibe `bot_gastos.py` -- en
`bot/grabaciones_enrutador.json`, **con el md5 del PROMPT con que se grabo**.

Las pruebas no escriben la salida del modelo a mano: la piden con
`grabada(clave)`. Si el PROMPT cambio desde la grabacion, `grabada` FALLA con
"cambiaste el PROMPT: vuelve a grabar", y `probar_grabaciones.py` pone roja la
suite (`npm run verificar` corre todos los `probar_*.py`).

**Regrabar NO corre dentro de la suite** (lento, no determinista y cuesta
llamadas). La comprobacion del md5 si.

Costo: una llamada al modelo por frase (`len(FRASES)`), cinco a la vez.

Uso:  python bot/grabar_enrutador.py [--solo-faltantes]   (necesita BOT_API_TOKEN y el ERP
                                                  local arriba, para el catalogo)
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
sys.path.insert(0, str(RAIZ))

import enrutador as E  # noqa: E402

ARCHIVO = RAIZ / "grabaciones_enrutador.json"

# Fase 8 (D74): lo que esta en pantalla lleva el CONTENIDO. Los dos mensajes
# son los que devolvio el servidor real (ruta `proponer` en ensayo, 2026-09-22),
# y las cadenas son las EXACTAS que arma `bot_gastos._en_pantalla` con ellos:
# `probar_hechos.py` lo comprueba (productor y consumidor, misma cadena).
MENSAJE_VENTA = (
    "Esto es lo que voy a escribir. Revisalo:\n\nVENTA CONTADO\nVENDE:      CEO Admin\n"
    "COMPRA:     Aeropuerto\n\n   1 x Destilado Plata 750ml a $480.00  (lista $599.00) = $480.00\n\n"
    "TOTAL:      $480.00   (1 pieza)\nEl dinero entra a \"Efectivo\".\n\n"
    "Contesta VA para escribirlo, o dime que cambio.")
MENSAJE_GASTO = (
    "Esto es lo que voy a escribir. Revisalo:\n\nMONTO:      $45.00\nCATEGORIA:  Logistica_Envios\n"
    "CONCEPTO:   envio a domicilio\nFECHA:      22/09/2026\nCUENTA:     Efectivo (se asienta aqui)\n\n"
    "(la cuenta no la elige el modelo: sale de tu alta en CEO Admin, y si esta mal la cambias con el boton)\n\n"
    "Contesta VA para escribirlo, o dime que cambio.")


def en_pantalla_de(tipo, mensaje):
    """La linea de `_en_pantalla` para UNA propuesta viva (misma regla)."""
    como = {"venta": "una venta", "gasto": "un gasto", "abono": "un abono"}[tipo]
    return "propuesta de " + como + " esperando su VA: " + " ".join(mensaje.split())[:320]


VENTA_EN_PANTALLA = en_pantalla_de("venta", MENSAJE_VENTA)
GASTO_EN_PANTALLA = en_pantalla_de("gasto", MENSAJE_GASTO)
VENTA_Y_GASTO_EN_PANTALLA = VENTA_EN_PANTALLA + "\n" + GASTO_EN_PANTALLA

# D73: historiales (hace_min, dijo, contesto), como los arma el bot.
HIST_CARTERA_AEROPUERTO = [
    (2.0, "cuanto me debe aeropuerto",
     "CARTERA — $10,170.00 por cobrar, 1 deudor(es) $10,170.00 Aeropuerto (LOC) — "
     "49.1% pagado, 3 d sin abonar"),
]
HIST_VENTA_599 = [
    (12.0, "Se vendio una botella grande de 599 pesos, el envio fue 45 pesos",
     "Esto es lo que voy a escribir. Revisalo: VENTA CONTADO 1 x Destilado Plata 750ml "
     "a $599.00 = $599.00 TOTAL: $599.00"),
    (11.0, "va", "Listo. Quedo escrita."),
]
EL_MENSAJE_2026_09_19 = (
    "Se acaba de vender una botella grande de 599 pesos, lo enviamos a domicilio y "
    "nosotros absorbimos el costo del envio y de envio fueron 45 pesos.")

# (clave, texto, en_pantalla[, extra]). La clave dice de que `D` viene y a que grupo
# pertenece; las pruebas filtran por prefijo.
FRASES = [
    # ── D50: "el mismo cliente" (auditoria Fase 6, §8.1: las cinco) ──────────
    ("d50_1_mismo_cliente", "cotizame para el mismo cliente 35 grandes, 43 chicas y 25 mini", None),
    ("d50_2_olvidalo_textual", "Olvidalo, ahora cotizame por favor para el mismo cliente 35 grandes, 43 chicas y 25 mini.", None),
    ("d50_3_al_mismo", "ahora al mismo 20 grandes y 10 mini", None),
    ("d50_4_mismo_distribuidor", "para el mismo distribuidor 5 grandes", None),
    ("d50_5_al_anterior", "cotizale otra vez al anterior 12 de 750", None),
    # Control: con nombre, "cliente" es el nombre, no una forma corta.
    ("d50_control_con_nombre", "cotizale 12 de 750 a aeropuerto", None),
    # ── D48: la promesa ─────────────────────────────────────────────────────
    ("d48_envio_como_gasto", "tienes pensado Aplicar el envio como un gasto?", VENTA_EN_PANTALLA),
    ("d48_y_el_envio", "y el envio?", None),
    # ── D49: el segundo hecho ───────────────────────────────────────────────
    ("d49_venta_y_envio", "Se vendio una botella grande de 599 pesos, el envio fue 45 pesos", None),
    ("d49_un_solo_hecho", "vendi una botella de 750", None),
    ("d49_venta_con_precio", "vendi una de 750 en 599", None),
    # ── D64: la confianza de `confirmar`, con una venta en pantalla ─────────
    ("d64_explicito_si_escribelo", "si escribelo", VENTA_EN_PANTALLA),
    ("d64_explicito_va_escribelo", "va escribelo", VENTA_EN_PANTALLA),
    ("d64_explicito_dale_escribela", "dale, escribela", VENTA_EN_PANTALLA),
    ("d64_explicito_si_va", "si va", VENTA_EN_PANTALLA),
    ("d64_explicito_si_confirmalo", "si, confirmalo", VENTA_EN_PANTALLA),
    ("d64_ambiguo_ok_pues", "ok pues", VENTA_EN_PANTALLA),
    ("d64_ambiguo_ahi_va", "ahi va", VENTA_EN_PANTALLA),
    ("d64_ambiguo_sale", "sale", VENTA_EN_PANTALLA),
    ("d64_ambiguo_mmm_va", "mmm va", VENTA_EN_PANTALLA),
    ("d64_ambiguo_y_eso", "y eso?", VENTA_EN_PANTALLA),
    ("d64_ambiguo_va_pues_pregunta", "va pues?", VENTA_EN_PANTALLA),
    ("d64_ambiguo_ps_va", "ps va", VENTA_EN_PANTALLA),
    ("d64_noconfirma_olvidalo", "olvidalo", VENTA_EN_PANTALLA),
    ("d64_noconfirma_stock", "cuanto stock tengo?", VENTA_EN_PANTALLA),
    ("d64_noconfirma_gracias", "gracias", VENTA_EN_PANTALLA),
    ("d64_noconfirma_gasolina", "gaste 200 pesos en gasolina", VENTA_EN_PANTALLA),
    ("d64_noconfirma_hola", "hola", VENTA_EN_PANTALLA),
    # ── D67: un monto objetivo que no sirve (que emite el modelo de verdad) ──
    ("d67_objetivo_negativo", "ahora una de menos 500 pesos con la misma proporcion", None),
    ("d67_objetivo_cero", "ahora una que salga en 0 pesos, con la misma proporcion", None),
    ("d67_objetivo_sin_numero", "ahora una por lo que alcance, con la misma proporcion", None),
    # ── FASE 8. Cuarta posicion opcional: {"historial": [...]} ──────────────
    # D73/D75: "y la deuda?" despues de preguntar por Aeropuerto.
    ("d73_y_la_deuda", "y la deuda?", None, {"historial": HIST_CARTERA_AEROPUERTO}),
    # D73 control de contaminacion: una venta de $599 en el historial y ahora
    # "vendi una chica": la venta nueva NO lleva $599.
    ("d73_control_vendi_una_chica", "vendi una chica", None, {"historial": HIST_VENTA_599}),
    # D73 control: sin historial, "y la deuda?" no sabe de quien.
    ("d73_control_sin_historial", "y la deuda?", None),
    # D74/D75: una correccion se SUMA a lo que esta en pantalla.
    ("d74_fue_a_concesion", "fue venta a concesion", VENTA_EN_PANTALLA),
    ("d74_a_nombre_de_delirio", "no, a nombre de Delirio", VENTA_EN_PANTALLA),
    ("d74_gasto_eran_50", "eran 50, no 45", GASTO_EN_PANTALLA),
    ("d74_dos_en_pantalla_concesion", "la venta fue a concesion", VENTA_Y_GASTO_EN_PANTALLA),
    # D74 control: un hecho NUEVO con una venta en pantalla no es ajustar.
    ("d74_control_otra_venta", "vendi otras 2 de 750 a publico", VENTA_EN_PANTALLA),
    # D76: la cartera de UN deudor; control, la cartera entera.
    ("d76_cuanto_me_debe_aeropuerto", "cuanto me debe aeropuerto", None),
    ("d76_control_quien_me_debe", "quien me debe", None),
    # D78/D80: varios hechos en un mensaje.
    ("d80_mensaje_2026_09_19", EL_MENSAJE_2026_09_19, None),
    ("d80_venta_y_abono", "vendi 2 chicas a aeropuerto y me abono 1000", None),
    ("d80_gasto_incompleto_y_venta", "gaste en gasolina y vendi 2 de 750 a publico", None),
    ("d80_seis_gastos", "gaste 10 en papel, 20 en cinta, 30 en gasolina, 40 en luz, "
                        "50 en agua y 60 en renta", None),
    # D80 control: el eco de la venta (la misma dicha dos veces) es UNA venta.
    ("d80_control_eco", "vendi una de 750 a publico, si, una botella de 750 fue la que vendi", None),
    # ── D81: envasar es lote, y no le falta el chile ────────────────────────
    ("d81_envasamos_24", "hoy envasamos 24 de 750", None),
    ("d81_envasado_con_lote", "del lote L-0915 salieron 40 de 250", None),
    # D81 control: un lote NUEVO sin chile si pide el chile (regla 11 intacta).
    ("d81_control_lote_nuevo_sin_chile", "empezamos un lote nuevo, 8 dias de fermentacion", None),
    # ── D83: cuantas botellas se hicieron ───────────────────────────────────
    ("d83_hoy", "cuantas botellas se hicieron hoy?", None),
    ("d83_semana", "cuanto envasamos esta semana?", None),
    ("d83_lote", "cuantas salieron del lote L-0915?", None),
    # D83 control: vender no es producir.
    ("d83_control_ventas", "cuanto vendimos este mes?", None),
]


def md5_del_prompt(prompt=None):
    return hashlib.md5((E.PROMPT if prompt is None else prompt).encode("utf-8")).hexdigest()


class PromptCambiado(AssertionError):
    pass


def cargar(prompt=None):
    """Las grabaciones, SOLO si se grabaron con este PROMPT. Si no, falla."""
    datos = json.loads(io.open(ARCHIVO, encoding="utf-8").read())
    actual = md5_del_prompt(prompt)
    if datos.get("md5_prompt") != actual:
        raise PromptCambiado(
            "cambiaste el PROMPT: vuelve a grabar (python bot/grabar_enrutador.py). "
            "Grabado con %s, el de hoy es %s." % (datos.get("md5_prompt"), actual))
    return datos


def grabada(clave):
    """La salida REAL del modelo para `clave`, tal como la recibe el bot."""
    frases = cargar()["frases"]
    if clave not in frases:
        raise KeyError("no hay grabacion para %r: agregala a FRASES y vuelve a grabar" % clave)
    return dict(frases[clave]["salida"])


def _productos():
    """El catalogo real, de la ruta de solo lectura. Con `x-bot-ensayo: 1`."""
    token = os.environ.get("BOT_API_TOKEN", "")
    api = os.environ.get("BOT_API_URL", "http://localhost:3000")
    pet = urllib.request.Request(
        api + "/api/bot/catalogo", data=json.dumps({"telegram_id": int(os.environ.get("GRABAR_CHAT", "6571822622"))}).encode("utf-8"),
        method="POST", headers={"Content-Type": "application/json", "x-bot-token": token,
                                "x-bot-ensayo": "1"})
    with urllib.request.urlopen(pet, timeout=30) as r:
        cuerpo = json.loads(r.read().decode("utf-8"))
    productos = cuerpo.get("productos") or []
    if not productos:
        raise RuntimeError("el catalogo vino vacio: sin el, las grabaciones no son las del bot")
    return productos


def grabar(solo_faltantes=False):
    """Graba FRASES. Con `solo_faltantes`, conserva las que ya hay (si son del
    PROMPT de hoy) y graba solo las nuevas: agregar una frase no obliga a
    regrabar las otras."""
    previas = cargar()["frases"] if solo_faltantes else dict()
    pendientes = [f for f in FRASES if f[0] not in previas]
    productos = _productos()
    categorias = list(E.CATEGORIAS_SEMILLA)

    def una(frase):
        clave, texto, en_pantalla = frase[:3]
        historial = (frase[3] if len(frase) > 3 else {}).get("historial")
        for espera in (0, 30, 120, 300):
            if espera:
                time.sleep(espera)
            ok, r = E.enrutar(texto, None, categorias, None, productos, en_pantalla,
                              historial=historial)
            if ok:
                grabacion = {"texto": texto, "en_pantalla": en_pantalla, "salida": r}
                if historial:
                    grabacion["historial"] = historial
                return clave, grabacion
        raise RuntimeError("el modelo no contesto para %r: %s" % (clave, r))

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=5) as ex:
        frases = dict(previas)
        frases.update(dict(ex.map(una, pendientes)))
    datos = {
        "md5_prompt": md5_del_prompt(),
        "modelo": "claude -p --model sonnet (enrutador._claude)",
        "grabado_en": time.strftime("%Y-%m-%d %H:%M:%S"),
        "llamadas": len(pendientes),
        "segundos": round(time.time() - t0, 1),
        "contexto": "catalogo de productos real (/api/bot/catalogo), CATEGORIAS_SEMILLA, "
                    "sin deudores, sin borrador a medias",
        "frases": frases,
    }
    io.open(ARCHIVO, "w", encoding="utf-8", newline="\n").write(
        json.dumps(datos, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    print("grabadas %d frases en %.0f s, PROMPT %s" % (len(frases), datos["segundos"], datos["md5_prompt"]))


if __name__ == "__main__":
    grabar(solo_faltantes="--solo-faltantes" in sys.argv)
