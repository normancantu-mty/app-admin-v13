# -*- coding: utf-8 -*-
"""Corre el conjunto de oro contra el enrutador actual y mide.

CAPA MEDIDA: `enrutador.enrutar()` -- la llamada al modelo (claude -p --model
sonnet) que decide intencion + hechos + campos. NO se mide `manejar_texto`
(la tuberia completa de Telegram): esa capa solo propone/escribe a partir de lo
que `enrutar` devuelve y no puede crear tipos que el enrutador no emite.
Modo ensayo: `BOT_ENSAYO=1` queda puesto en el entorno y `enrutar` no escribe
nada (solo habla con el modelo), asi que no se toca produccion.

Uso:
    python bot/oro/correr_oro.py                 # corre (o reanuda) todo
    python bot/oro/correr_oro.py --solo kevin_completo_01 nota_02
    python bot/oro/correr_oro.py --solo-evaluar  # re-puntua sin llamar al modelo
    python bot/oro/correr_oro.py --workers 3 --fecha 2026-10-18

El avance por caso se guarda en `bot/oro/avance_<fecha>.jsonl`; si se corta
(limite de la suscripcion, timeout), se vuelve a lanzar el mismo comando y
reanuda donde se quedo.
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

AQUI = os.path.dirname(os.path.abspath(__file__))
BOT = os.path.dirname(AQUI)
os.environ["BOT_ENSAYO"] = "1"
sys.path.insert(0, BOT)
os.chdir(BOT)

import enrutador as E  # noqa: E402

PRODUCTOS = [
    {"id": "c1000000-0000-0000-0000-000000000001", "sku": "plata-750ml",
     "nombre": "Destilado Plata 750ml", "ml_por_unidad": 750},
    {"id": "c1000000-0000-0000-0000-000000000003", "sku": "plata-250ml",
     "nombre": "Destilado Plata 250ml", "ml_por_unidad": 250},
    {"id": "c1000000-0000-0000-0000-000000000004", "sku": "plata-50ml",
     "nombre": "Destilado Plata 50ml", "ml_por_unidad": 50},
]
ETIQUETA_PRODUCTO = {
    "c1000000-0000-0000-0000-000000000001": "grande",
    "c1000000-0000-0000-0000-000000000003": "chica",
    "c1000000-0000-0000-0000-000000000004": "mini",
}
NOMBRE_HABLANTE = {"norman": "Norman", "kevin": "Kevin", "trabajador": "Luis (trabajador)"}
TIPOS_QUE_ESCRIBEN = set(E.TIPOS_DE_HECHO)
PERSONA = ("comprador", "cliente", "deudor", "quien", "nombre", "para_quien")
LIMITE_PATRONES = ("limit", "usage", "quota", "429", "overloaded", "rate", "capacity", "credit")


# --------------------------------------------------------------- normalizacion
def norm(s):
    t = unicodedata.normalize("NFD", str(s).strip().lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9. ]+", " ", t).strip()


def a_num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = re.fullmatch(r"\s*\$?\s*([0-9][0-9,]*\.?[0-9]*)\s*(?:pesos|ml|g|kg|l)?\s*", v.lower())
        if m:
            try:
                return float(m.group(1).replace(",", ""))
            except ValueError:
                return None
    return None


# --------------------------------------------------------------- vista del hecho predicho
def vista(h):
    c = dict(h.get("campos") or {})
    v = {"_tipo": h.get("intencion")}
    v.update(c)
    prods = c.get("productos") if isinstance(c.get("productos"), list) else []
    if prods:
        cant = [p.get("cantidad") for p in prods if isinstance(p, dict) and a_num(p.get("cantidad")) is not None]
        if cant and "cantidad" not in v:
            v["cantidad"] = sum(a_num(x) for x in cant)
        etiquetas = set()
        for p in prods:
            if not isinstance(p, dict):
                continue
            e = ETIQUETA_PRODUCTO.get(p.get("id_producto"))
            if not e:
                n = norm(p.get("producto") or "")
                e = "grande" if ("grande" in n or "750" in n) else "chica" if ("chica" in n or "250" in n) \
                    else "mini" if ("mini" in n or "50" in n) else n
            etiquetas.add(e)
        v["producto"] = "|".join(sorted(etiquetas))
    if "botellas" in v and "cantidad" not in v:
        v["cantidad"] = v["botellas"]
    return v


def valor_pred(v, clave):
    if clave in PERSONA:
        for k in PERSONA:
            if v.get(k) not in (None, ""):
                return v[k]
        return None
    if clave == "precio_unitario":
        for k in ("precio_unitario", "precio"):
            if v.get(k) not in (None, ""):
                return v[k]
        return None
    return v.get(clave)


def igual(esp, got):
    if got is None or got == "":
        return False
    if isinstance(esp, bool):
        return bool(got) == esp if isinstance(got, bool) else (esp is True and bool(got))
    if esp is True:
        return bool(got)
    if isinstance(esp, (int, float)):
        g = a_num(got)
        return g is not None and abs(g - float(esp)) < 1e-6
    if isinstance(esp, str):
        e, g = norm(esp), norm(got)
        if not e or not g:
            return False
        if e.isdigit() and g.isdigit():
            return e == g
        dg = re.sub(r"[^0-9]", "", g)
        if e.isdigit() and dg:      # formato "750" vs "750ml"
            return e == dg
        return e in g or g in e
    return False


def cumple(esp_campos, v, solo_nucleo):
    for k, ev in esp_campos.items():
        extendido = k.startswith("x_")
        if solo_nucleo and extendido:
            continue
        clave = k[2:] if extendido else k
        if not igual(ev, valor_pred(v, clave)):
            return False
    return True


def empata(esperados, predichos, solo_nucleo):
    """Asignacion voraz esperado -> predicho del mismo tipo. Devuelve #aciertos."""
    usados = set()
    tp = 0
    for e in esperados:
        for i, p in enumerate(predichos):
            if i in usados or p["_tipo"] != e["tipo"]:
                continue
            if cumple(e["campos"], p, solo_nucleo):
                usados.add(i)
                tp += 1
                break
    return tp


# --------------------------------------------------------------- correr un caso
def es_limite(texto):
    t = str(texto).lower()
    return any(p in t for p in LIMITE_PATRONES)


def llamar(texto, borrador, en_pantalla, historial, hablante):
    ultimo = ""
    for intento in range(8):
        ok, r = E.enrutar(texto, borrador, list(E.CATEGORIAS_SEMILLA), None, PRODUCTOS,
                          en_pantalla, historial=historial, hablante=hablante)
        if ok:
            return True, r
        ultimo = str(r)
        espera = 300 if es_limite(ultimo) else 20
        if intento < 7:
            time.sleep(espera)
    return False, ultimo


def correr_caso(caso):
    hablante = NOMBRE_HABLANTE[caso["persona"]] if caso["chat"] == "grupo" else None
    historial, salidas = [], []
    borrador, en_pantalla = None, None
    for i, msg in enumerate(caso["mensajes"]):
        ok, r = llamar(msg, borrador, en_pantalla, list(historial) or None, hablante)
        if not ok:
            salidas.append({"mensaje": msg, "error": r})
            return {"id": caso["id"], "salidas": salidas, "error": True}
        salidas.append({"mensaje": msg, "salida": r})
        quien = hablante or "Norman"
        historial.append((len(caso["mensajes"]) - i, msg, r.get("respuesta"), quien) if hablante
                         else (len(caso["mensajes"]) - i, msg, r.get("respuesta")))
        hs = [h for h in (r.get("hechos") or []) if isinstance(h, dict)]
        if hs and r.get("intencion") in TIPOS_QUE_ESCRIBEN:
            h = hs[0]
            if h.get("faltantes"):
                borrador, en_pantalla = dict(h.get("campos") or {}), None
            else:
                borrador = None
                en_pantalla = "Propuesta de %s: %s" % (
                    h.get("intencion"), json.dumps(h.get("campos"), ensure_ascii=False))
        elif r.get("intencion") not in ("ajustar", "corregir"):
            borrador, en_pantalla = None, None
    return {"id": caso["id"], "salidas": salidas, "error": False}


def hechos_predichos(corrida):
    """Une los hechos de todos los mensajes del caso (ajustar fusiona, completar reemplaza)."""
    acum = []   # lista de hechos crudos
    for s in corrida["salidas"]:
        r = s.get("salida")
        if not r:
            continue
        hs = [h for h in (r.get("hechos") or []) if isinstance(h, dict) and h.get("intencion") in TIPOS_QUE_ESCRIBEN]
        if not hs and r.get("intencion") in TIPOS_QUE_ESCRIBEN and r.get("campos"):
            hs = [{"intencion": r["intencion"], "campos": r["campos"], "faltantes": r.get("faltantes")}]
        if r.get("intencion") in ("ajustar", "corregir") and acum:
            nuevo = r.get("campos") or {}
            ultimo = acum[-1]
            campos = dict(ultimo.get("campos") or {})
            for k, v in nuevo.items():
                if k == "valor_nuevo":
                    k = "monto" if a_num(v) is not None else k
                campos[k] = v
            ultimo["campos"] = campos
            continue
        for h in hs:
            if acum and acum[-1].get("faltantes") and acum[-1].get("intencion") == h.get("intencion"):
                acum[-1] = h          # completa el borrador a medias
            else:
                acum.append(h)
    return [vista(h) for h in acum]


# --------------------------------------------------------------- puntuacion
def puntuar(casos, corridas):
    por_id = {c["id"]: corridas.get(c["id"]) for c in casos}
    cats = {}
    pend_total = {"esp": 0}
    for c in casos:
        corr = por_id[c["id"]]
        a = cats.setdefault(c["categoria"], dict(
            casos=0, evaluados=0, errores=0, esperados=0, pendientes=0, predichos=0,
            tp_n=0, tp_f=0, charla_casos=0, charla_fp=0, sin_hechos=0, sin_hechos_fp=0,
            dest_casos=0, dest_ok=0))
        a["casos"] += 1
        esp = c["hechos_esperados"]
        a["esperados"] += len(esp)
        a["pendientes"] += len(c["pendientes_esperados"])
        if c["destinatario_esperado"]:
            a["dest_casos"] += 1     # el enrutador de hoy no emite destinatario: nunca acierta
        if not corr or corr.get("error"):
            a["errores"] += 1
            continue
        a["evaluados"] += 1
        pred = hechos_predichos(corr)
        a["predichos"] += len(pred)
        a["tp_n"] += empata(esp, pred, True)
        a["tp_f"] += empata(esp, pred, False)
        if c["es_charla"]:
            a["charla_casos"] += 1
            a["charla_fp"] += 1 if pred else 0
        if not esp and not c["pendientes_esperados"]:
            a["sin_hechos"] += 1
            a["sin_hechos_fp"] += 1 if pred else 0
    return cats


def razon(a, b):
    return None if not b else round(a / b, 4)


def resumen(a):
    esp_total = a["esperados"] + a["pendientes"]
    return {
        "casos": a["casos"], "evaluados": a["evaluados"], "errores_sin_resolver": a["errores"],
        "hechos_esperados": a["esperados"], "pendientes_esperados": a["pendientes"],
        "hechos_predichos": a["predichos"],
        "estricto": {
            "precision": razon(a["tp_n"], a["predichos"]),
            "exhaustividad": razon(a["tp_n"], esp_total),
            "aciertos": a["tp_n"]},
        "completo": {
            "precision": razon(a["tp_f"], a["predichos"]),
            "exhaustividad": razon(a["tp_f"], esp_total),
            "aciertos": a["tp_f"]},
        "falsos_positivos_charla": {"casos": a["charla_casos"], "con_falso_positivo": a["charla_fp"],
                                    "tasa": razon(a["charla_fp"], a["charla_casos"])},
        "falsos_positivos_sin_hechos": {"casos": a["sin_hechos"], "con_falso_positivo": a["sin_hechos_fp"],
                                        "tasa": razon(a["sin_hechos_fp"], a["sin_hechos"])},
        "destinatario": {"casos": a["dest_casos"], "aciertos": a["dest_ok"]},
    }


def sumar(cats):
    t = None
    for a in cats.values():
        if t is None:
            t = dict(a)
        else:
            for k, v in a.items():
                t[k] += v
    return t


# --------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fecha", default=time.strftime("%Y-%m-%d"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--solo", nargs="*", default=None)
    ap.add_argument("--solo-evaluar", action="store_true")
    ap.add_argument("--rehacer-errores", action="store_true")
    a = ap.parse_args()

    casos = [json.loads(l) for l in open(os.path.join(AQUI, "casos.jsonl"), encoding="utf-8") if l.strip()]
    avance_ruta = os.path.join(AQUI, "avance_%s.jsonl" % a.fecha)
    corridas = {}
    if os.path.exists(avance_ruta):
        for l in open(avance_ruta, encoding="utf-8"):
            if l.strip():
                d = json.loads(l)
                corridas[d["id"]] = d
    if a.rehacer_errores:
        corridas = {k: v for k, v in corridas.items() if not v.get("error")}

    if not a.solo_evaluar:
        seleccion = [c for c in casos if (a.solo is None or c["id"] in a.solo) and c["id"] not in corridas]
        print("por correr: %d de %d casos (ya hechos: %d)" % (len(seleccion), len(casos), len(corridas)), flush=True)
        t0 = time.time()
        with open(avance_ruta, "a", encoding="utf-8") as f, ThreadPoolExecutor(max_workers=a.workers) as ex:
            for n, res in enumerate(ex.map(correr_caso, seleccion), 1):
                corridas[res["id"]] = res
                f.write(json.dumps(res, ensure_ascii=False) + "\n")
                f.flush()
                if n % 10 == 0 or res.get("error"):
                    print("  %d/%d  (%ds)%s" % (n, len(seleccion), time.time() - t0,
                                                 "  ERROR en " + res["id"] if res.get("error") else ""), flush=True)

    cats = puntuar(casos, corridas)
    salida = {
        "fecha": a.fecha,
        "capa_medida": "enrutador.enrutar() (claude -p --model sonnet), BOT_ENSAYO=1; no manejar_texto",
        "md5_prompt": __import__("hashlib").md5(E.PROMPT.encode("utf-8")).hexdigest(),
        "casos_total": len(casos),
        "casos_sin_correr": sum(1 for c in casos if c["id"] not in corridas),
        "total": resumen(sumar(cats)),
        "por_categoria": {k: resumen(v) for k, v in sorted(cats.items())},
    }
    ruta = os.path.join(AQUI, "resultados_%s.json" % a.fecha)
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=2)
    t = salida["total"]
    print("\nLINEA BASE (%s)" % a.fecha)
    print("  precision estricta     :", t["estricto"]["precision"])
    print("  exhaustividad estricta :", t["estricto"]["exhaustividad"])
    print("  falsos positivos charla:", t["falsos_positivos_charla"]["tasa"],
          "(%d de %d)" % (t["falsos_positivos_charla"]["con_falso_positivo"], t["falsos_positivos_charla"]["casos"]))
    print("  [completo] precision/exhaustividad:", t["completo"]["precision"], t["completo"]["exhaustividad"])
    print("  errores sin resolver:", t["errores_sin_resolver"], "| sin correr:", salida["casos_sin_correr"])
    print("  ->", ruta)


if __name__ == "__main__":
    main()
