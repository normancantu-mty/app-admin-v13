# -*- coding: utf-8 -*-
"""GRABACIONES REALES DEL OCR, para que `probar_fotos.py` no llame al modelo.

Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).

Pasa las imagenes de `ticket_sintetico.py` por el modelo DE VERDAD y guarda lo
que contesto en `grabaciones_ocr.json`, junto al modelo y la huella del prompt
(regla L5): si cambia el prompt, el esquema o el modelo, `probar_fotos.py` sale
en rojo hasta que se vuelva a grabar.

    python bot/grabar_ocr.py        # usa la cuenta de Claude Code: cuesta centavos

2026-11-08: si se le pasa la ruta de una foto de cotizacion (argumento o
COTIZACION_FOTO), graba tambien el caso "cotizacion_95691". La imagen NO se
versiona; lo grabado pasa por `sin_datos_bancarios` antes de guardarse.
"""
import hashlib
import io
import json
import os
import re
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import ocr_ticket as O  # noqa: E402
import ticket_sintetico as T  # noqa: E402

RUTA = os.path.join(AQUI, "grabaciones_ocr.json")
CATALOGO = os.path.join(AQUI, "fixtures", "catalogo_egreso_2026-11-03.json")


def huella():
    base = O.MODELO + O.PROMPT + json.dumps(O.ESQUEMA, sort_keys=True)
    return hashlib.md5(base.encode("utf-8")).hexdigest()


def catalogo():
    with io.open(CATALOGO, encoding="utf-8") as f:
        return json.load(f)


_CUENTA_LARGA = re.compile(r"\d[\d \-]{14,}\d")
_PALABRA_BANCO = re.compile(r"clabe|cuenta bancaria|n[uo]m(ero)?\.? de cuenta|no\.? de cuenta|convenio de pago", re.I)


def sin_datos_bancarios(obj):
    """Quita de lo grabado todo numero largo (CLABE, cuenta, tarjeta) y todo
    texto que hable de datos bancarios. Recursivo; no toca numeros JSON."""
    if isinstance(obj, dict):
        return {k: sin_datos_bancarios(v) for k, v in obj.items()}
    if isinstance(obj, list):
        fuera = [sin_datos_bancarios(v) for v in obj]
        return [v for v in fuera if v is not None]
    if isinstance(obj, str):
        if _PALABRA_BANCO.search(obj):
            return None
        return _CUENTA_LARGA.sub("[quitado]", obj)
    return obj


def cargar():
    with io.open(RUTA, encoding="utf-8") as f:
        return json.load(f)


def main():
    cat = catalogo()
    carpeta = tempfile.mkdtemp(prefix="grabar_ocr_")
    casos = {
        "limpio": (T.pintar(os.path.join(carpeta, "a.jpg")), ""),
        "inyeccion": (T.pintar(os.path.join(carpeta, "b.jpg"), inyeccion=True), "gasolina"),
        "no_ticket": (T.pintar_no_ticket(os.path.join(carpeta, "c.jpg")), ""),
    }
    foto = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("COTIZACION_FOTO", "")).strip()
    if foto:
        if not os.path.isfile(foto):
            print("no existe la foto", foto)
            sys.exit(1)
        casos["cotizacion_95691"] = (foto, "")
    salida = {"modelo": O.MODELO, "huella": huella(), "casos": {}}
    for nombre, (ruta, texto) in casos.items():
        with open(ruta, "rb") as f:
            ok, obj = O.leer_crudo(f.read(), "image/jpeg", texto, cat)
        print(nombre, ok, json.dumps(obj, ensure_ascii=True)[:300])
        if not ok:
            sys.exit(1)
        salida["casos"][nombre] = sin_datos_bancarios(obj)
    with io.open(RUTA, "w", encoding="utf-8", newline="\n") as f:
        json.dump(salida, f, ensure_ascii=False, indent=1)
    print("grabado", RUTA)


if __name__ == "__main__":
    main()
