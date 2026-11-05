# -*- coding: utf-8 -*-
"""Donde vive la FOTO de cada ticket, y a que movimiento esta ligada. 2026-11-03.

Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).

Primero en disco, en `bot/comprobantes/` (ignorado por git). Cada foto es un archivo `<clave>.<ext>` y TODO lo que le pasa queda en
`indice.jsonl`, una linea por evento, solo se agrega:

    foto      llego la foto (quien, de que chat, sha256, texto que la acompano)
    ocr       lo que se leyo (campos de gasto + campos de factura)
    borrador  se propuso un gasto con ella (borrador_id; `de_vuelo` si no se leyo
              con ese gasto, sino que estaba esperando uno)
    despegado se quito de ese borrador (boton "Quitar la foto")
    ligado    el clic de Norman escribio el gasto: id_movimiento de finanzas_ledger
    espera    dio VA quien no escribe solo: falta el Aprobar de Norman
    rechazado Norman no lo aprobo
    subido    ya esta en Supabase (bucket `tickets_gasto`, tabla `comprobantes_gasto`)
    fallo_subida  no subio: se cuenta para que no tape la cola

Se lee doblando los eventos (`registros`). Un archivo que solo crece no se
corrompe a medias como un JSON que se reescribe, y sobrevive al reinicio del bot
(el Aprobar de Norman puede llegar despues de un reinicio).

La migracion `..._comprobantes_gasto.sql` ya esta aplicada: cada foto ligada se
comprime (`comprimir`) y se sube por `/api/bot/comprobante/subir` al bucket
privado `tickets_gasto`; `bot/subir_comprobantes.py` sube las que faltaron.
`COMPROBANTES_EN_SUPABASE=0` lo apaga. El disco se queda como respaldo.
"""
import datetime as dt
import hashlib
import io
import json
import os
import re
import threading
import unicodedata
from pathlib import Path

import enrutador

RAIZ = Path(__file__).resolve().parent
CARPETA = Path(os.environ.get("BOT_COMPROBANTES") or (RAIZ / "comprobantes"))
INDICE = "indice.jsonl"
_candado = threading.Lock()

EXTENSION = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
# Lo que se sube a Supabase (plan gratis): JPEG, lado largo <= 1600 px, <= 200 KB.
# El original se queda en disco como respaldo.
LADO_MAXIMO = 1600
TOPE_SUBIDA = 200 * 1024


def comprimir(datos, lado=LADO_MAXIMO, tope=TOPE_SUBIDA):
    """(jpeg, ancho, alto) con lado largo <= `lado` y <= `tope` bytes. Baja la
    calidad y, si no alcanza, la resolucion. Lanza ValueError si no cabe."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(datos)) as original:
        base = ImageOps.exif_transpose(original).convert("RGB")
    for medida in (lado, 1280, 1024, 800, 640):
        img = base.copy()
        img.thumbnail((medida, medida), Image.LANCZOS)  # nunca agranda
        for calidad in (85, 75, 65, 55, 45, 35):
            salida = io.BytesIO()
            img.save(salida, "JPEG", quality=calidad, optimize=True)
            if salida.tell() <= tope:
                return salida.getvalue(), img.width, img.height
    raise ValueError("no cupo en %d bytes" % tope)


def carpeta():
    CARPETA.mkdir(parents=True, exist_ok=True)
    return CARPETA


def _anotar(evento):
    evento = dict(evento, en=dt.datetime.now().isoformat(timespec="seconds"))
    linea = json.dumps(evento, ensure_ascii=False) + "\n"
    with _candado:
        with io.open(carpeta() / INDICE, "a", encoding="utf-8") as f:
            f.write(linea)
    return evento


def eventos():
    ruta = CARPETA / INDICE
    if not ruta.is_file():
        return []
    salida = []
    with io.open(ruta, encoding="utf-8") as f:
        for linea in f:
            try:
                e = json.loads(linea)
            except ValueError:
                continue
            if isinstance(e, dict) and e.get("clave"):
                salida.append(e)
    return salida


def guardar_foto(datos, mime, telegram_id, chat_id, texto=None, file_unique_id=None):
    """Guarda la foto antes de leerla: un ticket no se pierde porque el modelo
    falle. Devuelve la clave.

    NO es lo primero del turno: antes van las puertas (grupo callado, quien es,
    descarga, tope de peso) y la revision de duplicado. Quien no paso una puerta
    no deja foto: con el ERP caido y sin identidad en cache no se guarda, y el
    mismo ticket ya escrito o ya propuesto tampoco."""
    sha = huella(datos)
    clave = dt.datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + sha[:10]
    archivo = clave + EXTENSION.get(mime, ".jpg")
    with open(carpeta() / archivo, "wb") as f:
        f.write(datos)
    _anotar({"evento": "foto", "clave": clave, "archivo": archivo, "sha256": sha,
             "mime": mime, "bytes": len(datos), "telegram_id": int(telegram_id),
             "chat_id": int(chat_id), "texto": (texto or None),
             "file_unique_id": file_unique_id})
    return clave


def anotar_ocr(clave, ticket):
    _anotar({"evento": "ocr", "clave": clave, "ticket": ticket})


def anotar_error(clave, error):
    _anotar({"evento": "error", "clave": clave,
             "error": enrutador._sin_secretos(error)[:300]})


def anotar_borrador(clave, borrador_id, de_vuelo=False):
    _anotar({"evento": "borrador", "clave": clave, "borrador_id": str(borrador_id),
             "de_vuelo": bool(de_vuelo)})


def despegar(clave, borrador_id):
    _anotar({"evento": "despegado", "clave": clave, "borrador_id": str(borrador_id)})


def anotar_espera(borrador_id):
    """Ese borrador espera el Aprobar de Norman. Va al indice y no a la RAM: esa
    espera no caduca (`lib/bot-aprobacion.ts`) y sobrevive a un reinicio."""
    for clave in fotos_de_borrador(borrador_id):
        _anotar({"evento": "espera", "clave": clave, "borrador_id": str(borrador_id)})


def anotar_rechazo(borrador_id):
    for clave in fotos_de_borrador(borrador_id):
        _anotar({"evento": "rechazado", "clave": clave, "borrador_id": str(borrador_id)})


def anotar_fallo_subida(clave, error):
    _anotar({"evento": "fallo_subida", "clave": clave,
             "error": enrutador._sin_secretos(error)[:300]})


def anotar_subido(clave, ruta_storage):
    _anotar({"evento": "subido", "clave": clave, "ruta_storage": ruta_storage})


def registros():
    """{clave: registro} con todo lo que le paso a cada foto, en orden de llegada."""
    salida = {}
    for e in eventos():
        r = salida.setdefault(e["clave"], {"clave": e["clave"], "borradores": []})
        ev = e.get("evento")
        if ev == "foto":
            r.update({k: e.get(k) for k in ("archivo", "sha256", "mime", "telegram_id",
                                              "chat_id", "texto", "en", "file_unique_id")})
        elif ev == "ocr":
            r["ticket"] = e.get("ticket")
        elif ev == "borrador":
            r["borradores"].append(e.get("borrador_id"))
            if e.get("de_vuelo"):
                r.setdefault("de_vuelo", []).append(e.get("borrador_id"))
        elif ev == "despegado":
            r["borradores"] = [b for b in r["borradores"] if b != e.get("borrador_id")]
        elif ev == "ligado":
            r["id_movimiento"] = e.get("id_movimiento")
            r["ligado_en"] = e.get("en")
        elif ev == "subido":
            r["ruta_storage"] = e.get("ruta_storage")
        elif ev == "fallo_subida":
            r["fallos_subida"] = r.get("fallos_subida", 0) + 1
            r["error_subida"] = e.get("error")
        elif ev == "espera":
            r["espera"] = e.get("borrador_id")
        elif ev == "rechazado":
            r.pop("espera", None)
        elif ev == "error":
            r["error"] = e.get("error")
    return salida


def huella(datos):
    return hashlib.sha256(datos).hexdigest()


def previas(sha256, file_unique_id=None):
    """Las veces que ya llego esta misma foto, la mas nueva primero. Telegram da
    el mismo `file_unique_id` a un reenvio; el sha256 reconoce el mismo archivo."""
    return [r for r in reversed(list(registros().values())) if r.get("sha256") == sha256
            or (file_unique_id and r.get("file_unique_id") == file_unique_id)]


def fotos_de_borrador(borrador_id):
    """Las claves de las fotos de ese borrador, en orden de llegada. Pueden ser
    varias: un ticket largo llega en dos fotos."""
    return [c for c, r in registros().items() if str(borrador_id) in r["borradores"]]


def de_borrador(borrador_id):
    """La clave de la primera foto de ese borrador, o None."""
    fotos = fotos_de_borrador(borrador_id)
    return fotos[0] if fotos else None


def foto_de_vuelo(borrador_id):
    """La clave de la foto que llego en vuelo a ese borrador, o None."""
    for clave, r in registros().items():
        if str(borrador_id) in r["borradores"] and str(borrador_id) in r.get("de_vuelo", ()):
            return clave
    return None


def ligar(borrador_id, id_movimiento):
    """El gasto ya se escribio: las fotos de su borrador quedan ligadas al
    movimiento. Devuelve sus claves ([] si ese borrador no traia foto)."""
    if not borrador_id or not id_movimiento:
        return []
    fotos = fotos_de_borrador(borrador_id)
    for clave in fotos:
        _anotar({"evento": "ligado", "clave": clave, "borrador_id": str(borrador_id),
                 "id_movimiento": str(id_movimiento)})
    return fotos


def ruta_de(registro):
    return CARPETA / registro["archivo"] if registro.get("archivo") else None


def cuerpo_para_subir(clave):
    """Lo que viaja a `/api/bot/comprobante/subir`, o None si la foto no esta
    ligada (sin movimiento no hay a que pegarla) o el archivo no esta."""
    import base64
    r = registros().get(clave)
    if not r or not r.get("id_movimiento") or not r.get("archivo"):
        return None
    try:
        with open(ruta_de(r), "rb") as f:
            datos = f.read()
    except OSError:
        return None
    jpeg, ancho, alto = comprimir(datos)
    return {"telegram_id": r.get("telegram_id"), "id_movimiento": r["id_movimiento"],
            "borrador_id": (r.get("borradores") or [None])[-1], "mime": "image/jpeg",
            "ancho": ancho, "alto": alto,
            "sha256": hashlib.sha256(jpeg).hexdigest(),
            "imagen_b64": base64.b64encode(jpeg).decode("ascii"),
            "ticket": r.get("ticket")}


def pendientes_de_subir():
    """Las claves ligadas a un movimiento que todavia no estan en Supabase, las
    que menos han fallado primero: quien recorta la lista no se queda con puras
    fotos rotas, y las rotas no salen de ella."""
    faltan = [(c, r) for c, r in registros().items()
              if r.get("id_movimiento") and not r.get("ruta_storage")]
    return [c for c, r in sorted(faltan, key=lambda x: x[1].get("fallos_subida", 0))]


# ---------------------------------------------------------------------------
# "Muestrame el ticket del gasto de gasolina". **Sin modelo**: se busca por
# palabras y numeros contra lo que se leyo de cada ticket.
# ---------------------------------------------------------------------------
_VACIAS = set("""el la los las de del un una unos unas y o a al en por para con que
me mi mis lo le les se su sus este esta ese esa eso esto ticket tickets foto fotos
comprobante comprobantes gasto gastos muestrame muestra mostrar mandame manda mandar
ensename ensena pasame pasa dame ver quiero reenviame reenvia
envia enviame del ultimo ultima porfa porfavor favor hoy mostrarme ensenarme mandarme
pasarme enviarme reenviarme mostrar ensenar enviar reenviar puedes podrias muestras ensenas
mandas pasas envias reenvias dejame gracias plis please oye hey bot""".split())


def plano(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def terminos(texto):
    """Las palabras que sirven para buscar. **Pura.**"""
    crudo = re.findall(r"[a-z0-9][a-z0-9.\-/]*", plano(texto))
    return [t.strip(".-/") for t in crudo if t.strip(".-/") and t.strip(".-/") not in _VACIAS]


def _pajar(r):
    t = r.get("ticket") or {}
    f = t.get("factura") or {}
    piezas = [t.get("proveedor"), t.get("descripcion"), t.get("categoria"), t.get("fecha"),
              f.get("razon_social"), f.get("folio"), f.get("rfc_emisor"), f.get("forma_pago"),
              r.get("texto"), r.get("id_movimiento")]
    numeros = []
    for n in (t.get("monto"), f.get("total")):
        if isinstance(n, (int, float)):
            numeros += ["%d" % n if float(n).is_integer() else "%.2f" % n, "%.2f" % n]
    return plano(" ".join(str(p) for p in piezas if p)), set(numeros)


def buscar(texto, solo_ligados=False):
    """Los registros que mejor casan con `texto`, del mas reciente al mas viejo,
    con su puntaje. Sin terminos: todos (el mas reciente primero)."""
    regs = [r for r in registros().values() if r.get("archivo")
            and (r.get("id_movimiento") or not solo_ligados)]
    regs.sort(key=lambda r: r.get("en") or "", reverse=True)
    ts = terminos(texto)
    if not ts:
        return [(0, r) for r in regs], ts
    salida = []
    for r in regs:
        pajar, numeros = _pajar(r)
        puntos = 0
        for t in ts:
            if t in numeros or t.replace(",", "") in numeros:
                puntos += 2
            elif len(t) >= 3 and t in pajar:
                puntos += 1
        if puntos:
            salida.append((puntos, r))
    salida.sort(key=lambda par: par[0], reverse=True)  # estable: empate -> mas reciente
    return salida, ts
