# -*- coding: utf-8 -*-
"""Cazador F0 - WP-7a: el LOTE POR PLANTILLA.

Escrito el 2026-10-17 por el ejecutor B del Socio.

La plantilla es DATOS (`bot/plantillas/lote.yaml`); aqui solo vive la mecanica:

  1. "hoy empezamos lote" / "dame la plantilla del lote" (o el enrutador dice
     `lote` sin ningun dato) -> se manda la plantilla completa, numerada.
  2. Cada respuesta se lee SIN modelo (regex de la plantilla): sueltas
     ("40 kilos, 8 dias"), numeradas ("1. 40  2. 8") o un numero solo cuando
     se pregunto una sola cosa.
  3. Falta un obligatorio -> se pregunta SOLO lo que falta, en tandas de <=4,
     numeradas. "No se / luego" lo deja vacio y lo anota.
  4. Completo -> la peticion de siempre a `/api/bot/lote/proponer` (la misma
     que arma `_peticion_de_lote`), con `propuesta.notas` = lo que no tuvo campo.
     De ahi en adelante es el camino de siempre: borrador, sello, VA.

Un rango fuera de lo normal AVISA y no bloquea (los topes duros siguen en el
servidor: `lib/bot-lotes.ts`).

Lo que NO hace, a proposito: no escribe nada (solo propone), no adivina si "a 24
grados" es temperatura o alcohol (va a notas), y no se come un mensaje que no
entiende: si no reconoce nada, lo deja pasar al enrutador y la sesion sigue.
"""
import io
import os
import re
import time
import unicodedata

try:
    import yaml
except ImportError:  # pragma: no cover - el bot vivo lo tiene (requirements.txt)
    yaml = None

RUTA_PLANTILLA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plantillas", "lote.yaml")

NUMEROS = {"un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6}
MAX_PREGUNTAS = 4
_DINERO = re.compile(r"\$|\bpesos?\b|\bpag\w*|\bvend\w*|\bcobr\w*|\babon\w*|\bgast\w*|\bfactur\w*")

_sesiones = {}
_plantilla = None


def cargar(ruta=RUTA_PLANTILLA):
    """Lee la plantilla. Se cachea; `cargar(ruta)` explicito la recarga."""
    global _plantilla
    if yaml is None:
        raise RuntimeError("falta PyYAML (pip install pyyaml) para leer " + ruta)
    with io.open(ruta, encoding="utf-8") as f:
        _plantilla = yaml.safe_load(f)
    return _plantilla


def plantilla():
    return _plantilla if _plantilla is not None else cargar()


def _plano(texto):
    t = unicodedata.normalize("NFKD", str(texto or "").lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def _num(s):
    s = str(s).strip().lower()
    if s in NUMEROS:
        return NUMEROS[s]
    try:
        v = float(s.replace(",", "."))
    except ValueError:
        return None
    return int(v) if v == int(v) else v


def _campo(nombre):
    for c in plantilla()["campos"]:
        if c["nombre"] == nombre:
            return c
    return None


# ── la sesion ───────────────────────────────────────────────────────────────

def activa(chat):
    s = _sesiones.get(chat)
    if not s:
        return False
    if time.time() - s["nacido_en"] > 60 * float(plantilla().get("vida_minutos", 30)):
        _sesiones.pop(chat, None)
        return False
    return True


def olvidar(chat):
    _sesiones.pop(chat, None)


def sesion(chat):
    return _sesiones.get(chat) if activa(chat) else None


def es_disparador(texto):
    t = _plano(texto)
    return any(re.search(p, t) for p in plantilla().get("disparadores") or [])


# ── leer un mensaje ─────────────────────────────────────────────────────────

def leer(texto, preguntadas=()):
    """Lo que el mensaje dice, segun la plantilla. Sin modelo.

    Devuelve dict: campos, notas, omitir (bool), consumio (bool), resto (str),
    dinero (bool: el mensaje habla de dinero -> no es de la plantilla).
    """
    p = plantilla()
    t = _plano(texto)
    campos, notas, tramos = {}, [], []

    def tomar(m):
        tramos.append(m.span())

    # 1. Numeradas: "1. 40  2. 8" / "1) 40, 2) 8". Solo si el mensaje EMPIEZA asi.
    if preguntadas and re.match(r"^\s*1\s*[.)\-:]", t):
        piezas = re.split(r"(?:^|[\s,;])([1-9])\s*[.)\-:]\s*", t)
        # piezas = ['', '1', 'resp1', '2', 'resp2', ...]
        for i in range(1, len(piezas) - 1, 2):
            idx = int(piezas[i]) - 1
            if 0 <= idx < len(preguntadas):
                valor = _valor_suelto(preguntadas[idx], piezas[i + 1].strip(" ,;."))
                if valor is not None:
                    campos[preguntadas[idx]] = valor
        if campos:
            return {"campos": campos, "notas": notas, "omitir": False, "consumio": True,
                    "resto": "", "dinero": False}

    # 2. Un numero solo, cuando se pregunto UNA cosa numerica.
    solo = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*$", t)
    if solo and len(preguntadas) == 1 and (_campo(preguntadas[0]) or {}).get("tipo") == "numero":
        campos[preguntadas[0]] = _num(solo.group(1))
        return {"campos": campos, "notas": notas, "omitir": False, "consumio": True,
                "resto": "", "dinero": False}

    # 3. Sueltas, por los patrones de cada campo.
    for c in p["campos"]:
        for patron in c.get("patrones") or []:
            for m in re.finditer(patron, t):
                tomar(m)
                if c["tipo"] == "numero":
                    campos.setdefault(c["nombre"], _num(m.group(1)))
                elif c["tipo"] == "tandas":
                    n, litros = _num(m.group(1)), _num(m.group(2))
                    if n and litros:
                        campos.setdefault("tandas", [])
                        campos["tandas"].extend({"litros": litros, "grado": None} for _ in range(int(n)))
                elif c["tipo"] == "texto":
                    campos.setdefault(c["nombre"], m.group(1))
    for e in p.get("extras") or []:
        for patron in e.get("patrones") or []:
            for m in re.finditer(patron, t):
                tomar(m)
                if e["tipo"] == "codigo":
                    cod = m.group(1).upper()
                    if not cod.startswith("L-"):
                        cod = "L-" + cod[1:]
                    campos.setdefault("codigo_lote", cod)
                elif e["tipo"] == "a_notas":
                    notas.append(e.get("nota", "{0}").format(m.group(1).strip()))

    omitir = any(re.search(o, t) for o in p.get("omitir") or [])
    for o in p.get("omitir") or []:
        for m in re.finditer(o, t):
            tomar(m)
    disparo = es_disparador(t)
    for d in p.get("disparadores") or []:
        for m in re.finditer(d, t):
            tomar(m)

    # 4. Lo que sobra: si son 2+ palabras que no son relleno, es una observacion.
    resto = list(t)
    for a, b in tramos:
        for i in range(a, b):
            resto[i] = " "
    relleno = set((p.get("relleno") or "").split())
    sobra = [w for w in re.findall(r"[a-z0-9]+", "".join(resto)) if w not in relleno and not w.isdigit()]
    resto_txt = " ".join(sobra)
    dinero = bool(_DINERO.search(t))
    consumio = bool(campos or notas or omitir or disparo)
    return {"campos": campos, "notas": notas, "omitir": omitir, "consumio": consumio,
            "resto": resto_txt if len(sobra) >= 2 else "", "dinero": dinero}


def _valor_suelto(nombre, texto):
    c = _campo(nombre) or {}
    if c.get("tipo") == "numero":
        m = re.search(r"(\d+(?:[.,]\d+)?)", texto)
        return _num(m.group(1)) if m else None
    if c.get("tipo") == "tandas":
        m = re.search(r"(\d+|un|uno|una|dos|tres|cuatro|cinco|seis)\D+?(\d+(?:[.,]\d+)?)", texto)
        if not m:
            return None
        n, litros = _num(m.group(1)), _num(m.group(2))
        return [{"litros": litros, "grado": None} for _ in range(int(n))] if n and litros else None
    return texto.strip() or None


# ── preguntar ───────────────────────────────────────────────────────────────

def faltan(s):
    return [c["nombre"] for c in plantilla()["campos"]
            if c.get("obligatorio") and c["nombre"] not in s["campos"] and c["nombre"] not in s["omitidos"]]


def texto_plantilla():
    p = plantilla()
    lineas = [p.get("intro", "Lote nuevo:")]
    for i, c in enumerate(p["campos"][:MAX_PREGUNTAS], 1):
        lineas.append("%d. %s" % (i, c["etiqueta"]))
    if p.get("cierre"):
        lineas.append(p["cierre"])
    return "\n".join(lineas)


def texto_faltan(nombres):
    lote = nombres[:MAX_PREGUNTAS]
    lineas = ["Me falta:"] + ["%d. %s" % (i, _campo(n)["pregunta"]) for i, n in enumerate(lote, 1)]
    return "\n".join(lineas), lote


def avisos_de_rango(campos):
    avisos = []
    for c in plantilla()["campos"]:
        rango = c.get("rango")
        v = campos.get(c["nombre"])
        if not rango or v in (None, ""):
            continue
        valores = [t.get("litros") for t in v] if c["tipo"] == "tandas" else [v]
        for x in valores:
            if isinstance(x, (int, float)) and not (rango[0] <= x <= rango[1]):
                avisos.append("Ojo: %s %s se sale de lo normal (%s a %s). Lo dejo asi; si es error, corrigelo."
                              % (x, c.get("unidad", "litros" if c["tipo"] == "tandas" else ""),
                                 rango[0], rango[1]))
    return avisos


def _anotar(s, leido):
    for k, v in leido["campos"].items():
        if k == "tandas" and s["campos"].get("tandas"):
            continue  # la primera tanda dicha manda; otra lista ira por correccion
        s["campos"][k] = v
    s["notas"].extend(n for n in leido["notas"] if n not in s["notas"])
    if leido.get("resto"):
        s["notas"].append(leido["resto"])
    if leido["omitir"]:
        for n in s["preguntadas"] or faltan(s):
            if n not in leido["campos"] and n not in s["campos"]:
                s["omitidos"].add(n)
    # Se pregunta UNA vez: lo que se pidio en "Me falta" y no vino en la
    # respuesta se deja vacio y se anota como pendiente (no se vuelve a pedir).
    # La plantilla completa no cuenta como pregunta: es el formulario.
    if s.get("modo") == "faltan":
        for n in s["preguntadas"]:
            if n not in s["campos"]:
                s["omitidos"].add(n)


def notas_de(s):
    notas = list(s["notas"])
    tipo = s["campos"].get("tipo_chile")
    if tipo:
        notas.insert(0, "tipo de chile: " + str(tipo))
    for n in sorted(s["omitidos"]):
        notas.append("%s: pendiente (dijeron que luego)" % _campo(n)["etiqueta"].lower())
    return "; ".join(notas)[:500]


def campos_para_peticion(s):
    """Los campos tal como los entiende `_peticion_de_lote` del bot."""
    c = {k: v for k, v in s["campos"].items() if k in ("kg_chile", "dias_fermentacion", "tandas", "codigo_lote")}
    return c


def empezar(chat, campos=None, notas=None):
    _sesiones[chat] = {"campos": dict(campos or {}), "notas": list(notas or []), "omitidos": set(),
                       "preguntadas": [c["nombre"] for c in plantilla()["campos"][:MAX_PREGUNTAS]],
                       "modo": "plantilla", "nacido_en": time.time()}
    return _sesiones[chat]


# ── el turno ────────────────────────────────────────────────────────────────

async def atender(update, chat, texto, proponer_lote, peticion_de, desde_enrutador=None):
    """Atiende el mensaje si es de la plantilla. Devuelve True si lo atendio.

    `proponer_lote(update, chat, peticion)` y `peticion_de(campos)` son las del
    bot (`_proponer_lote`, `_peticion_de_lote`): se inyectan para no importar
    `bot_gastos` desde aqui.
    `desde_enrutador`: los campos que el enrutador saco de un `lote` sin datos
    suficientes; abre la sesion aunque el texto no traiga disparador.
    """
    s = sesion(chat)
    leido = leer(texto, s["preguntadas"] if s else ())
    if leido["dinero"] and desde_enrutador is None:
        return False  # habla de dinero: lo decide el enrutador, la sesion sigue viva
    if s is None:
        if desde_enrutador is None and not es_disparador(texto):
            return False
        if desde_enrutador is None and leido.get("resto"):
            return False  # trae mas cosas de las que la plantilla entiende: al enrutador
        s = empezar(chat, desde_enrutador or {})
        nueva = True
    else:
        if not leido["consumio"]:
            return False
        nueva = False
    _anotar(s, leido)

    avisos = avisos_de_rango(leido["campos"])
    if nueva and not s["campos"]:
        s["preguntadas"] = [c["nombre"] for c in plantilla()["campos"][:MAX_PREGUNTAS]]
        await update.effective_message.reply_text("\n".join(avisos + [texto_plantilla()]))
        return True
    pendientes = faltan(s)
    if pendientes:
        pregunta, s["preguntadas"] = texto_faltan(pendientes)
        s["modo"] = "faltan"
        s["nacido_en"] = time.time()
        await update.effective_message.reply_text("\n".join(avisos + [pregunta]))
        return True

    peticion = peticion_de(campos_para_peticion(s))
    notas = notas_de(s)
    if notas:
        peticion["propuesta"]["notas"] = notas
    olvidar(chat)
    if avisos:
        await update.effective_message.reply_text("\n".join(avisos))
    await proponer_lote(update, chat, peticion)
    return True
