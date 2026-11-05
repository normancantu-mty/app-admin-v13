# -*- coding: utf-8 -*-
"""GRABACIONES REALES DEL OCR, para que `probar_fotos.py` no llame al modelo.

Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).

Pasa las imagenes de `ticket_sintetico.py` por el modelo DE VERDAD y guarda lo
que contesto en `grabaciones_ocr.json`, junto al modelo y la huella del prompt
(regla L5): si cambia el prompt, el esquema o el modelo, `probar_fotos.py` sale
en rojo hasta que se vuelva a grabar.

    python bot/grabar_ocr.py        # usa la cuenta de Claude Code: cuesta centavos
"""
import hashlib
import io
import json
import os
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
    salida = {"modelo": O.MODELO, "huella": huella(), "casos": {}}
    for nombre, (ruta, texto) in casos.items():
        with open(ruta, "rb") as f:
            ok, obj = O.leer_crudo(f.read(), "image/jpeg", texto, cat)
        print(nombre, ok, json.dumps(obj, ensure_ascii=True)[:300])
        if not ok:
            sys.exit(1)
        salida["casos"][nombre] = obj
    with io.open(RUTA, "w", encoding="utf-8", newline="\n") as f:
        json.dump(salida, f, ensure_ascii=False, indent=1)
    print("grabado", RUTA)


if __name__ == "__main__":
    main()
