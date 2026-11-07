# -*- coding: utf-8 -*-
"""Cazador F0 - WP-7a: el LOTE POR PLANTILLA.

Escrito el 2026-10-17 por el ejecutor B del Socio.
Lote v2: reescrito el 2026-10-19 por el ejecutor del Socio (lote v2).

La plantilla es DATOS (`bot/plantillas/lote.yaml`); aqui solo vive la mecanica:

  1. "hoy empezamos lote" / "empecemos" / "dame la plantilla del lote" (o el
     enrutador dice `lote` sin ningun dato) -> se manda la plantilla completa,
     encabezada por el codigo que le toca (L-DD-MM.N, formato del YAML).
  2. Cada respuesta se lee SIN modelo (regex de la plantilla): sueltas
     ("40 kilos de chile, brix chile 12"), numeradas ("1. 40 guajillo  2. 12")
     o un numero solo cuando se pregunto una sola cosa.
  3. Falta un obligatorio -> se pregunta SOLO lo que falta, en tandas de <=4,
     numeradas, UNA vez. "No se / luego" lo deja vacio y lo anota.
  4. Completo -> UN mensaje con todo lo capturado + la fecha de hoy y los
     botones Confirmar / Corregir. **Nada sale al servidor antes de Confirmar.**
     Confirmar (en `bot_gastos`) arma la peticion de siempre a
     `/api/bot/lote/proponer` y la confirma en el mismo paso.

Un rango fuera de lo normal AVISA y no bloquea (los topes duros siguen en el
servidor: `lib/bot-lotes.ts`).

Lo que NO hace, a proposito: no escribe nada, no adivina si "a 24 grados" es
temperatura o alcohol (va a notas), y no se come un mensaje que no entiende: si
no reconoce nada, lo deja pasar al enrutador y la sesion sigue.
"""
import asyncio
import datetime as dt
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
_SI = re.compile(r"^\W*(confirm\w*|si|va|correcto|esta\s+bien|asi\s+esta\s+bien|dale|listo)\W*$")
_CORREGIR = re.compile(r"^\W*(corrig\w*|correccion|cambia\w*|esta\s+mal)\W*$")

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


# Fase 7 (2026-11-07): la unidad DICHA en el tramo ("8 kg", "800 g"). Un
# campo de masa guarda su valor en SU `unidad` (YAML); si lo dijeron en la otra,
# se pasa, porque lo DIJERON (no se adivina: un numero solo queda tal cual).
_KILOS = re.compile(r"\d\s*(kilos?|kgs?|kilogramos?)\b")
_GRAMOS = re.compile(r"\d\s*(g|gr|grs|gramos?)\b")


def a_unidad_del_campo(c, valor, tramo):
    """**Pura.** `valor` dicho en `tramo` -> en la `unidad` del campo `c`."""
    if not isinstance(valor, (int, float)) or (c or {}).get("unidad") not in ("g", "kg"):
        return valor
    t = _plano(tramo)
    dicha = "kg" if _KILOS.search(t) else "g" if _GRAMOS.search(t) else None
    if dicha is None or dicha == c["unidad"]:
        return valor
    v = valor * 1000 if dicha == "kg" else valor / 1000.0
    v = round(v, 6)
    return int(v) if v == int(v) else v


def _campo(nombre):
    for c in plantilla()["campos"]:
        if c["nombre"] == nombre:
            return c
    return None


def preguntas():
    """Las preguntas numeradas de la plantilla: [{etiqueta, campos:[...]}]."""
    p = plantilla()
    if p.get("preguntas"):
        return list(p["preguntas"])[:MAX_PREGUNTAS]
    return [{"etiqueta": c["etiqueta"], "campos": [c["nombre"]]} for c in p["campos"][:MAX_PREGUNTAS]]


def hoy_local(ahora=None):
    """La fecha de hoy en la planta (UTC-6 fijo, del YAML). `ahora` se inyecta."""
    horas = float(((plantilla().get("ubicacion") or {}).get("utc_offset_horas")) or -6)
    zona = dt.timezone(dt.timedelta(hours=horas))
    ahora = ahora or dt.datetime.now(dt.timezone.utc)
    if ahora.tzinfo is None:
        ahora = ahora.replace(tzinfo=dt.timezone.utc)
    return ahora.astimezone(zona).date()


def fecha_para_persona(d):
    return "%02d/%02d/%04d" % (d.day, d.month, d.year)


# ── el codigo del lote ──────────────────────────────────────────────────────

def _regex_del_formato(formato, fecha):
    """El formato del YAML, con la fecha puesta y `{n}` como grupo numerico."""
    valores = {"dd": "%02d" % fecha.day, "mm": "%02d" % fecha.month,
               "aaaa": "%04d" % fecha.year, "aa": "%02d" % (fecha.year % 100)}
    partes = re.split(r"(\{[a-z]+\})", formato)
    out = []
    for parte in partes:
        m = re.match(r"^\{([a-z]+)\}$", parte)
        if m and m.group(1) == "n":
            out.append(r"(\d+)")
        elif m and m.group(1) in valores:
            out.append(re.escape(valores[m.group(1)]))
        else:
            out.append(re.escape(parte))
    return re.compile("^" + "".join(out) + "$", re.I)


def codigo_siguiente(codigos, fecha, formato=None):
    """El codigo que le toca al siguiente lote de `fecha`: N = 1 + el mayor N
    que ya exista con el mismo prefijo (no "cuantos hay": si se borro el .1, el
    .2 no se reusa). El formato sale del YAML (`formato_codigo`)."""
    formato = formato or plantilla().get("formato_codigo") or "L-{dd}-{mm}.{n}"
    patron = _regex_del_formato(formato, fecha)
    mayor = 0
    for c in codigos or []:
        m = patron.match(str(c or "").strip())
        if m:
            mayor = max(mayor, int(m.group(1)))
    valores = {"dd": "%02d" % fecha.day, "mm": "%02d" % fecha.month, "aaaa": "%04d" % fecha.year,
               "aa": "%02d" % (fecha.year % 100), "n": str(mayor + 1)}
    return re.sub(r"\{([a-z]+)\}", lambda m: valores.get(m.group(1), m.group(0)), formato)


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


def _es_envasado(texto):
    """Ronda 5 (B): YAML `envasado_diario` (lo mismo que mira `lote_ciclo`)."""
    t = _plano(texto)
    return any(re.search(p, t) for p in (plantilla().get("envasado_diario") or []))


def es_disparador(texto):
    t = _plano(texto)
    return any(re.search(p, t) for p in plantilla().get("disparadores") or [])


# ── leer un mensaje ─────────────────────────────────────────────────────────

def _items(preguntadas):
    """`preguntadas` admite nombres sueltos (compatibilidad) o grupos."""
    return [list(x) if isinstance(x, (list, tuple)) else [x] for x in (preguntadas or ())]


def leer(texto, preguntadas=()):
    """Lo que el mensaje dice, segun la plantilla. Sin modelo.

    `preguntadas`: lo que se pregunto, en orden (cada item = los campos de esa
    pregunta numerada). Devuelve dict: campos, notas, omitir (bool), consumio
    (bool), resto (str), dinero (bool: habla de dinero -> no es de la plantilla).
    """
    p = plantilla()
    t = _plano(texto)
    items = _items(preguntadas)
    campos, notas, tramos = {}, [], []

    def tomar(m):
        tramos.append(m.span())

    # 1. Numeradas: "1. 40  2. 8" / "1) 40, 2) 8". Solo si el mensaje EMPIEZA asi
    #    (con 1; o con cualquier numero si se esta corrigiendo: "2. 13").
    #    "2.5 kilos" NO es numerada: tras el punto no puede venir un digito.
    inicio = r"^\s*[1-9]\s*[.)\-:](?!\d)" if len(items) > 1 else r"^\s*1\s*[.)\-:](?!\d)"
    if items and re.match(inicio, t):
        piezas = re.split(r"(?:^|[\s,;])([1-9])\s*[.)\-:](?!\d)\s*", t)
        for i in range(1, len(piezas) - 1, 2):
            idx = int(piezas[i]) - 1
            if 0 <= idx < len(items):
                campos.update(_valores_de_item(items[idx], piezas[i + 1].strip(" ,;.")))
        if campos:
            return {"campos": campos, "notas": notas, "omitir": False, "consumio": True,
                    "resto": "", "dinero": False}

    # 2. Un numero solo, cuando se pregunto UNA cosa y su primer campo es numerico.
    solo = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*$", t)
    if solo and len(items) == 1 and (_campo(items[0][0]) or {}).get("tipo") == "numero":
        campos[items[0][0]] = _num(solo.group(1))
        return {"campos": campos, "notas": notas, "omitir": False, "consumio": True,
                "resto": "", "dinero": False}

    # 3. Sueltas, por los patrones de cada campo. Un tramo ya tomado por otro
    #    campo no se vuelve a leer ("2 kilos de aditivo" no son kilos de chile).
    def libre(m):
        a, b = m.span()
        return not any(a < y and x < b for x, y in tramos)

    def extra(e, m):
        tomar(m)
        if e["tipo"] == "codigo":
            cod = m.group(1).upper()
            if not cod.startswith("L-"):
                cod = "L-" + cod[1:]
            campos.setdefault("codigo_lote", cod)
        elif e["tipo"] == "a_notas":
            # Ronda 3: si lo que se pregunto deja UN solo campo posible
            # (`campo_si_unico`), el dato es de ese campo; si no, a notas.
            posibles = [n for it in items for n in it
                        if n in (e.get("campo_si_unico") or ()) and n not in campos]
            if len(posibles) == 1 and _num(m.group(1)) is not None:
                campos[posibles[0]] = _num(m.group(1))
            else:
                notas.append(e.get("nota", "{0}").format(m.group(1).strip(), t=m.group(0).strip()))

    # Ronda 5: los extras `primero` (la temperatura dicha) se leen ANTES que los
    # campos: su tramo ya no es de nadie ("temperatura 24 grados" no da 24 kg).
    for e in p.get("extras") or []:
        if e.get("primero"):
            for patron in e.get("patrones") or []:
                for m in re.finditer(patron, t):
                    if libre(m):
                        extra(e, m)

    # Ronda 5 (C): mezcla de chiles, "30 kg guajillo y 10 kg guajon".
    mezcla = leer_chiles(t)
    if mezcla:
        for a, b in mezcla["tramos"]:
            tramos.append((a, b))
        campos.update(mezcla["campos"])
    else:
        # Ronda 6 (auditoria r5): dos chiles SIN kilos por tipo ("40 kilos de
        # guajillo y guajon", "mitad guajillo mitad guajon") no se cargan enteros
        # a guajillo: `reparto_chile` = 'mitad' (50/50) o 'falta' (se pregunta).
        dichos = sorted(set(m.group(1) for m in re.finditer(
            r"\b(%s)\b" % "|".join(re.escape(k) for k in chiles_conocidos()), t)))
        if len(dichos) >= 2:
            for m in re.finditer(r"\b(%s)\b" % "|".join(re.escape(k) for k in dichos), t):
                tomar(m)
            campos["tipo_chile"] = " y ".join(dichos)
            campos["reparto_chile"] = "mitad" if _MITAD.search(t) else "falta"
    if _MITAD.search(t) and "reparto_chile" not in campos and any("tipo_chile" in it for it in items):
        for m in _MITAD.finditer(t):
            tomar(m)
        campos["reparto_chile"] = "mitad"

    orden = sorted(p["campos"], key=lambda c: 0 if c["nombre"] != "kg_chile" else 1)
    for c in orden:
        for patron in c.get("patrones") or []:
            for m in re.finditer(patron, t):
                if not libre(m):
                    continue
                tomar(m)
                if c["tipo"] == "numero":
                    campos.setdefault(c["nombre"], a_unidad_del_campo(c, _num(m.group(1)), m.group(0)))
                elif c["tipo"] == "texto":
                    campos.setdefault(c["nombre"], m.group(1))
    for e in p.get("extras") or []:
        if e.get("primero"):
            continue
        for patron in e.get("patrones") or []:
            for m in re.finditer(patron, t):
                if libre(m):
                    extra(e, m)

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


def chiles_conocidos():
    """{tipo: sku} de los chiles que se usan (YAML `chiles.conocidos`)."""
    return dict(((plantilla().get("chiles") or {}).get("conocidos")) or {"guajillo": "chile-guajillo"})


def tipo_conocido(tipo):
    """'guajillo' / 'Guajón' / 'guajillo y guajon' -> True si TODO lo dicho es
    de los chiles conocidos. **Pura.**"""
    palabras = [w for w in re.findall(r"[a-z]+", _plano(tipo or "")) if w not in ("y", "e", "chile", "de", "mezcla")]
    return bool(palabras) and all(w in chiles_conocidos() for w in palabras)


_MITAD = re.compile(r"\bmitad\b|\b50\s*(?:/|y|-)\s*50\b|\bpartes?\s+iguales\b")


def repartir_chiles(s):
    """Ronda 6: una mezcla sin kilos por tipo. 'mitad' + kilos -> 50/50 en
    `chiles` (y una nota, visible en el resumen); 'falta' -> 'preguntar'. None
    si no hay nada que repartir. Muta la sesion."""
    c = s["campos"]
    rep = c.pop("reparto_chile", None)
    tipos = [w for w in re.findall(r"[a-z]+", _plano(c.get("tipo_chile") or "")) if w in chiles_conocidos()]
    if isinstance(c.get("chiles"), dict) and c["chiles"]:
        s.pop("reparto_pendiente", None)
        return None
    rep = rep or s.get("reparto_pendiente")
    if not rep or len(tipos) < 2:
        s.pop("reparto_pendiente", None)
        return None
    kg = c.get("kg_chile")
    if rep == "mitad" and kg not in (None, "", 0):
        parte = float(kg) / len(tipos)
        parte = int(parte) if parte.is_integer() else round(parte, 3)
        c["chiles"] = {t: parte for t in tipos}
        nota = "reparto de chile: mitad y mitad (%s kg de cada uno)" % parte
        if nota not in s["notas"]:
            s["notas"].append(nota)
        s.pop("reparto_pendiente", None)
        return None
    s["reparto_pendiente"] = rep
    return "preguntar" if rep == "falta" else None


def leer_chiles(texto):
    """Ronda 5 (C): "30 kg guajillo y 10 kg guajon" -> dos renglones. Solo si
    hay DOS tipos conocidos distintos con sus kilos; un solo chile lo leen los
    campos de siempre (kg_chile + tipo_chile). **Pura.** None o
    {'campos': {'chiles': {...}, 'kg_chile': total, 'tipo_chile': 'guajillo y guajon'}, 'tramos': [...]}"""
    patron = (plantilla().get("chiles") or {}).get("mezcla")
    if not patron:
        return None
    t = _plano(texto)
    pares, tramos = {}, []
    for m in re.finditer(patron, t):
        kg = _num(m.group(1))
        if kg is None:
            continue
        pares[m.group(2)] = pares.get(m.group(2), 0) + kg
        tramos.append(m.span())
    if len(pares) < 2:
        return None
    total = sum(pares.values())
    return {"campos": {"chiles": pares, "kg_chile": int(total) if float(total).is_integer() else total,
                       "tipo_chile": " y ".join(sorted(pares))}, "tramos": tramos}


def renglones_de_chile(campos):
    """Los renglones de insumo del chile, por SKU (YAML `chiles.conocidos`).
    [] si el tipo no se reconoce o no hay kilos: entonces va `kg_chile` suelto
    (y el bot lo carga a chile-guajillo, con aviso). **Pura.**"""
    conocidos = chiles_conocidos()
    mezcla = campos.get("chiles")
    if isinstance(mezcla, dict) and mezcla:
        return [{"insumo": conocidos[k], "cantidad": v, "unidad": _unidad_chile()} for k, v in sorted(mezcla.items())
                if k in conocidos]
    tipo = _plano(campos.get("tipo_chile") or "").strip()
    kg = campos.get("kg_chile")
    if kg in (None, "", 0) or tipo not in conocidos:
        return []
    return [{"insumo": conocidos[tipo], "cantidad": kg, "unidad": _unidad_chile()}]


def _unidad_chile():
    return (_campo("kg_chile") or {}).get("unidad") or 'kg'


def _valores_de_item(nombres, texto):
    """La respuesta a UNA pregunta numerada -> sus campos. "40 guajillo" en la
    pregunta 1 da kilos (el numero) y tipo (lo que reconoce el patron, o la
    palabra que sobra)."""
    salida = {}
    if "kg_chile" in nombres:
        mezcla = leer_chiles(texto)
        if mezcla:
            return dict(mezcla["campos"])
    numeros = re.findall(r"(\d+(?:[.,]\d+)?)", texto)
    i_num = 0
    for nombre in nombres:
        c = _campo(nombre) or {}
        if c.get("tipo") == "numero":
            if i_num < len(numeros):
                salida[nombre] = a_unidad_del_campo(c, _num(numeros[i_num]), texto)
                i_num += 1
        elif c.get("tipo") == "texto":
            valor = None
            for patron in c.get("patrones") or []:
                m = re.search(patron, texto)
                if m:
                    valor = m.group(1)
                    break
            if valor is None:
                relleno = set((plantilla().get("relleno") or "").split()) | {"kilos", "kg", "kgs", "kilo"}
                palabras = [w for w in re.findall(r"[a-z]+", texto) if w not in relleno]
                valor = " ".join(palabras) or None
            if valor:
                salida[nombre] = valor
    return salida


# ── preguntar ───────────────────────────────────────────────────────────────

# Lo que el enrutador puede traer que la plantilla entiende (el resto se ignora).
NOMBRES_DE_CAMPO = ("kg_chile", "tipo_chile", "brix_chile", "aditivo_1", "brix_final", "codigo_lote")


def faltan(s):
    return [c["nombre"] for c in plantilla()["campos"]
            if c.get("obligatorio") and c["nombre"] not in s["campos"] and c["nombre"] not in s["omitidos"]]


def texto_plantilla(codigo=None):
    p = plantilla()
    lineas = [codigo] if codigo else []
    lineas.append(p.get("intro", "Lote nuevo:"))
    for i, q in enumerate(preguntas(), 1):
        lineas.append("%d. %s" % (i, q["etiqueta"]))
    if p.get("cierre"):
        lineas.append(p["cierre"])
    return "\n".join(lineas)


def texto_faltan(nombres):
    lote = nombres[:MAX_PREGUNTAS]
    lineas = ["Me falta:"] + ["%d. %s" % (i, _campo(n)["pregunta"]) for i, n in enumerate(lote, 1)]
    return "\n".join(lineas), [[n] for n in lote]


def avisos_de_rango(campos):
    avisos = []
    for c in plantilla()["campos"]:
        rango = c.get("rango")
        v = campos.get(c["nombre"])
        if not rango or v in (None, ""):
            continue
        if isinstance(v, (int, float)) and not (rango[0] <= v <= rango[1]):
            avisos.append("Ojo: %s = %s %s se sale de lo normal (%s a %s). Lo dejo asi; si es error, corrigelo."
                          % (c["etiqueta"], v, c.get("unidad", ""), rango[0], rango[1]))
    return avisos


def _anotar(s, leido):
    for k, v in leido["campos"].items():
        s["campos"][k] = v
        s["omitidos"].discard(k)
        if k == "codigo_lote":
            s["codigo_dictado"] = True
    s["notas"].extend(n for n in leido["notas"] if n not in s["notas"])
    if leido.get("resto"):
        s["notas"].append(leido["resto"])
    pedidas = [n for item in _items(s["preguntadas"]) for n in item]
    if leido["omitir"]:
        for n in pedidas or faltan(s):
            if n not in leido["campos"] and n not in s["campos"]:
                s["omitidos"].add(n)
    # Se pregunta UNA vez: lo que se pidio en "Me falta" y no vino en la
    # respuesta se deja vacio y se anota como pendiente (no se vuelve a pedir).
    # La plantilla completa no cuenta como pregunta: es el formulario.
    if s.get("modo") == "faltan":
        for n in pedidas:
            if n not in s["campos"] and (_campo(n) or {}).get("obligatorio"):
                s["omitidos"].add(n)


def notas_de(s):
    notas = list(s["notas"])
    tipo = s["campos"].get("tipo_chile")
    if tipo and not tipo_conocido(tipo):
        notas.insert(0, "tipo de chile: " + str(tipo))
    for n in sorted(s["omitidos"]):
        notas.append("%s: pendiente (dijeron que luego)" % _campo(n)["etiqueta"].lower())
    return "; ".join(notas)[:500]


def codigo_de(s):
    return s["campos"].get("codigo_lote") or s.get("codigo")


def campos_para_peticion(s):
    """Los campos tal como los entiende `_peticion_de_lote` del bot. El aditivo
    1 sale como renglon de insumo con su SKU OPACO (YAML `aditivo_1_sku`)."""
    c = {k: v for k, v in s["campos"].items()
         if k in ("kg_chile", "brix_chile", "brix_final", "dias_fermentacion", "tandas")}
    codigo = codigo_de(s)
    if codigo:
        c["codigo_lote"] = codigo
    insumos = renglones_de_chile(s["campos"])
    if insumos:
        c.pop("kg_chile", None)  # va como renglon(es) con su SKU, no suelto
    ad1 = s["campos"].get("aditivo_1")
    if ad1 not in (None, "", 0):
        # Fase 7: va en la unidad del campo (YAML, la del catalogo: g). El
        # servidor la pasa a la del catalogo; con g -> GRAMOS queda igual.
        insumos.append({"insumo": plantilla().get("aditivo_1_sku") or "mosto-1", "cantidad": ad1,
                        "unidad": (_campo("aditivo_1") or {}).get("unidad") or "g"})
    if insumos:
        c["insumos"] = insumos
    return c


def resumen(s, hoy=None):
    """EL mensaje de confirmacion: todo lo capturado + la fecha de hoy."""
    hoy = hoy or hoy_local()
    lineas = ["Revisa el lote antes de guardarlo:", "",
              "LOTE %s" % (codigo_de(s) or "(codigo lo pone el sistema)"),
              "Fecha: %s (hoy)" % fecha_para_persona(hoy)]
    for c in plantilla()["campos"]:
        v = s["campos"].get(c["nombre"])
        if c["nombre"] in s["omitidos"]:
            lineas.append("%s: pendiente" % c["etiqueta"])
        elif v not in (None, ""):
            lineas.append("%s: %s%s" % (c["etiqueta"], v, (" " + c["unidad"]) if c.get("unidad") and c["unidad"] != "Brix" else ""))
    tipo = str(s["campos"].get("tipo_chile") or "").strip()
    mezcla = s["campos"].get("chiles")
    if isinstance(mezcla, dict) and mezcla:
        for k, v in sorted(mezcla.items()):
            lineas.append("   chile %s: %s kg" % (k, v))
    elif s["campos"].get("kg_chile") not in (None, "") and not tipo_conocido(tipo):
        # Ronda 5 (C): solo si el tipo NO se reconoce (o no se dijo) se avisa a
        # que insumo van los kilos, ANTES de confirmar.
        lineas.append("   (los kilos se cargan a chile-guajillo%s)"
                      % ((": el tipo '%s' no es guajillo ni guajon y va a notas" % tipo) if tipo else ": no dijeron el tipo"))
    notas = [n for n in s["notas"]]
    if notas:
        lineas.append("Notas: " + "; ".join(notas)[:300])
    lineas += ["", "Nada se guarda hasta que confirmes."]
    return "\n".join(lineas)


def texto_corregir(s):
    lineas = ["Que corrijo? Contestame con el numero, por ejemplo: 2. 13"]
    for i, q in enumerate(preguntas(), 1):
        vals = [str(s["campos"].get(n)) for n in q["campos"] if s["campos"].get(n) not in (None, "")]
        lineas.append("%d. %s: %s" % (i, q["etiqueta"], " ".join(vals) if vals else "(vacio)"))
    return "\n".join(lineas)


def _teclado_resumen():
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("Confirmar", callback_data="ltok:x"),
        InlineKeyboardButton("Corregir", callback_data="ltcor:x"),
    ]])


def empezar(chat, campos=None, notas=None, codigo=None):
    campos = dict(campos or {})
    _sesiones[chat] = {"campos": campos, "notas": list(notas or []), "omitidos": set(),
                       "preguntadas": [list(q["campos"]) for q in preguntas()],
                       "modo": "plantilla", "nacido_en": time.time(), "codigo": codigo,
                       "codigo_dictado": bool(campos.get("codigo_lote"))}
    return _sesiones[chat]


async def ensenar_resumen(update, s, avisos=(), hoy=None):
    s["modo"] = "resumen"
    s["preguntadas"] = []
    s["nacido_en"] = time.time()
    await update.effective_message.reply_text("\n".join(list(avisos) + [resumen(s, hoy)]),
                                              reply_markup=_teclado_resumen())


async def corregir(update, chat):
    s = sesion(chat)
    if not s:
        await update.effective_message.reply_text("Ya no tengo ese lote a medias. Dictamelo otra vez.")
        return
    s["modo"] = "corregir"
    s["preguntadas"] = [list(q["campos"]) for q in preguntas()]
    s["nacido_en"] = time.time()
    await update.effective_message.reply_text(texto_corregir(s))


def preparar_confirmacion(chat, codigo_actual=None):
    """Confirmar. Devuelve ("ok", peticion_campos, notas) | ("reconfirmar", s, None) | (None, texto, None).

    Si el codigo NO se dicto y otro lote del dia ya tomo el que se enseno, se
    enseña otra vez con el nuevo: no se escribe un codigo distinto del que se
    confirmo."""
    s = sesion(chat)
    if not s or s.get("modo") != "resumen":
        return None, "No tengo ningun lote por confirmar. Dictamelo otra vez.", None
    if not s.get("codigo_dictado") and codigo_actual and codigo_actual != s.get("codigo"):
        s["codigo"] = codigo_actual
        return "reconfirmar", s, None
    campos = campos_para_peticion(s)
    notas = notas_de(s)
    olvidar(chat)
    return "ok", campos, notas


# ── el turno ────────────────────────────────────────────────────────────────

async def atender(update, chat, texto, proponer_lote=None, peticion_de=None, desde_enrutador=None,
                  codigo_nuevo=None, confirmar=None):
    """Atiende el mensaje si es de la plantilla. Devuelve True si lo atendio.

    `proponer_lote` y `peticion_de` quedan por compatibilidad: la plantilla ya
    no propone sola (Lote v2: primero Confirmar). `codigo_nuevo()` (sincrona)
    da el codigo que le toca hoy; `confirmar(update, chat)` es el Confirmar del
    bot, para cuando lo dicen por voz ("confirmar", "si").
    `desde_enrutador`: los campos que el enrutador saco de un `lote` sin datos
    suficientes; abre la sesion aunque el texto no traiga disparador.
    """
    s = sesion(chat)
    t = _plano(texto)
    if s is not None and s.get("modo") == "resumen" and desde_enrutador is None:
        if _SI.match(t) and confirmar is not None:
            await confirmar(update, chat)
            return True
        if _CORREGIR.match(t):
            await corregir(update, chat)
            return True
    if desde_enrutador is None and _es_envasado(t):
        # Ronda 5 (B): el envasado es diario y no se liga al lote: la plantilla
        # nunca lo toma (ni lo abre ni lo mete a una abierta). La sesion sigue.
        return False
    leido = leer(texto, s["preguntadas"] if s else ())
    if leido["dinero"] and desde_enrutador is None:
        return False  # habla de dinero: lo decide el enrutador, la sesion sigue viva
    if s is None:
        if desde_enrutador is None and not es_disparador(texto):
            return False
        if desde_enrutador is None and leido.get("resto"):
            return False  # trae mas cosas de las que la plantilla entiende: al enrutador
        codigo = None
        if codigo_nuevo is not None:
            try:
                codigo = await asyncio.to_thread(codigo_nuevo)
            except Exception:
                codigo = None
        s = empezar(chat, desde_enrutador or {}, codigo=codigo)
        nueva = True
    else:
        if not leido["consumio"]:
            return False
        nueva = False
    _anotar(s, leido)

    avisos = avisos_de_rango(leido["campos"])
    if nueva and not s["campos"]:
        s["preguntadas"] = [list(q["campos"]) for q in preguntas()]
        await update.effective_message.reply_text("\n".join(avisos + [texto_plantilla(codigo_de(s))]))
        return True
    tipo = s["campos"].get("tipo_chile")
    if tipo and not tipo_conocido(tipo) and not s.get("chile_preguntado"):
        # Ronda 5 (C): un chile que no es guajillo ni guajon: se avisa y se
        # pregunta UNA vez. Si no lo aclaran, se carga a guajillo con aviso.
        s["chile_preguntado"] = True
        s["preguntadas"] = [["kg_chile", "tipo_chile"]]
        s["modo"] = "chile"
        s["nacido_en"] = time.time()
        await update.effective_message.reply_text("\n".join(avisos + [
            "Dijiste chile '%s'. Solo uso guajillo, guajon o una mezcla de los dos. Cual es? "
            "Por ejemplo: 'guajon', o '30 kg guajillo y 10 kg guajon'." % tipo]))
        return True
    if repartir_chiles(s) == "preguntar":
        s["preguntadas"] = [["kg_chile", "tipo_chile"]]
        s["modo"] = "mezcla"
        s["nacido_en"] = time.time()
        await update.effective_message.reply_text("\n".join(avisos + [
            "Dijiste %s. Cuantos kilos de cada uno? Por ejemplo: '30 kg guajillo y 10 kg guajon', "
            "o 'mitad y mitad'." % s["campos"].get("tipo_chile")]))
        return True
    if s.get("modo") in ("corregir", "resumen"):
        await ensenar_resumen(update, s, avisos)
        return True
    pendientes = faltan(s)
    if pendientes:
        pregunta, s["preguntadas"] = texto_faltan(pendientes)
        s["modo"] = "faltan"
        s["nacido_en"] = time.time()
        await update.effective_message.reply_text("\n".join(avisos + [pregunta]))
        return True
    await ensenar_resumen(update, s, avisos)
    return True
