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

# La cadena EXACTA que arma `bot_gastos._en_pantalla` para una venta sellada.
VENTA_EN_PANTALLA = "una propuesta de una venta lista, esperando que digas que va o que no"

# (clave, texto, en_pantalla). La clave dice de que `D` viene y a que grupo
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
        clave, texto, en_pantalla = frase
        for espera in (0, 30, 120, 300):
            if espera:
                time.sleep(espera)
            ok, r = E.enrutar(texto, None, categorias, None, productos, en_pantalla)
            if ok:
                return clave, {"texto": texto, "en_pantalla": en_pantalla, "salida": r}
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
