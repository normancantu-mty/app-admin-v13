# -*- coding: utf-8 -*-
"""Lote v2: LA TEMPERATURA DE LA FERMENTACION (Open-Meteo, Fresnillo, Zac.).

Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).

  1. FIXTURE GRABADO (respuesta real de Open-Meteo del 2026-10-19, dias
     2026-10-12 a 18, `bot/fixtures/`): `temperaturas()` devuelve min / max /
     promedio POR DIA, con la fuente 'open-meteo exterior' y la URL que pide
     Fresnillo (lat/lon del YAML), los tres diarios y la zona de Mexico.
  2. LLAMADA REAL (si hay red): la misma funcion contra la API de verdad; la
     salida se IMPRIME (va al log del informe). Sin red: se dice "SIN RED" y
     el caso no cuenta como pasado ni como fallado.
  3. LA API FALLA: `completar_temperatura` no revienta, no guarda nada, dice
     cuantos dias quedan pendientes; y en la siguiente vuelta, con la API de
     vuelta, los guarda (el reintento es que el dia sigue sin fila).
     CONTROL: un dia que ya tiene fila no se vuelve a pedir.
  4. `dias_que_faltan`: de la produccion a AYER si sigue fermentando; hasta
     el dia de la destilacion si ya se destilo.
  5. Un dia con un valor nulo no se inventa (no sale).
  6. El lote se guarda aunque Open-Meteo falle: la temperatura no esta en el
     camino del lote (el `tick` sigue y manda sus recordatorios).

Corre con:  python bot/probar_temperatura.py
"""
import asyncio
import datetime as dt
import json
import os
import sys
import tempfile
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import lote_ciclo as C  # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(AQUI, "fixtures", "open_meteo_fresnillo_2026-10-12_a_18.json")
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


with open(FIXTURE, encoding="utf-8") as f:
    GRABADA = json.load(f)
pedidas = []


def abrir_fixture(url, timeout):
    pedidas.append((url, timeout))
    return GRABADA


# ─── 1. el fixture ──────────────────────────────────────────────────────────
dias = C.temperaturas("2026-10-12", "2026-10-18", abrir=abrir_fixture)
caso("1. siete dias", len(dias), 7)
caso("1. el primero: min/max/prom del 12 de octubre",
     (dias[0]["fecha"], dias[0]["t_min"], dias[0]["t_max"], dias[0]["t_prom"]), ("2026-10-12", 11.9, 23.4, 16.9))
caso("1. el ultimo: 18 de octubre",
     (dias[-1]["fecha"], dias[-1]["t_min"], dias[-1]["t_max"], dias[-1]["t_prom"]), ("2026-10-18", 8.3, 17.4, 11.8))
caso("1. fuente 'open-meteo exterior' (proxy sin anclar)", {d["fuente"] for d in dias}, {"open-meteo exterior"})
q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(pedidas[0][0]).query))
caso("1. la URL pide Fresnillo (lat/lon del YAML)", (q["latitude"], q["longitude"]), ("23.1749", "-102.86785"))
caso("1. ... los tres diarios y la zona de Mexico",
     (q["daily"], q["timezone"]), ("temperature_2m_max,temperature_2m_min,temperature_2m_mean", "America/Mexico_City"))
caso("1. ... el periodo pedido", (q["start_date"], q["end_date"]), ("2026-10-12", "2026-10-18"))
caso("1. ... con timeout (YAML)", pedidas[0][1], 20.0)
caso("1. min <= prom <= max en cada dia", all(d["t_min"] <= d["t_prom"] <= d["t_max"] for d in dias), True)

# ─── 2. la llamada real ─────────────────────────────────────────────────────
hoy = dt.date.today()
try:
    reales = C.temperaturas(hoy - dt.timedelta(days=3), hoy - dt.timedelta(days=1))
    print("LLAMADA REAL Open-Meteo (%s a %s):" % (hoy - dt.timedelta(days=3), hoy - dt.timedelta(days=1)))
    for d in reales:
        print("   %s  min %.1f  max %.1f  prom %.1f  (%s)" % (d["fecha"], d["t_min"], d["t_max"], d["t_prom"], d["fuente"]))
    caso("2. llamada real: 3 dias con min/max/prom", (len(reales), all(
        isinstance(d["t_min"], float) and isinstance(d["t_max"], float) and isinstance(d["t_prom"], float)
        for d in reales)), (3, True))
except Exception as e:  # sin red no es un fallo del codigo: se dice
    print("LLAMADA REAL: SIN RED (%s: %s) -- el caso 2 no cuenta" % (type(e).__name__, e))


# ─── 3. la API falla -> pendiente, reintento ────────────────────────────────
class Servidor(object):
    def __init__(self):
        self.filas = {}
        self.llamadas = []

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if cuerpo.get("accion") == "temperatura":
            for d in cuerpo["dias"]:
                self.filas[(d["fecha"], d["fuente"])] = d
            return 200, {"ok": True, "guardados": len(cuerpo["dias"])}
        return 200, {"ok": True}


def api_caida(url, timeout):
    raise OSError("api caida (inyectada)")


LOTES = [{"id": "a", "codigo_lote": "L-12-10.1", "fecha_inicio": "2026-10-12", "etapas": [], "recordatorios": []}]
srv = Servidor()
r = C.completar_temperatura(srv, LOTES, [], dt.date(2026, 10, 19), abrir=api_caida)
caso("3. API caida: no revienta, 0 guardados, 7 pendientes", r, (0, 7))
caso("3. ... y no se guardo nada", (len(srv.filas), len(srv.llamadas)), (0, 0))
r = C.completar_temperatura(srv, LOTES, [], dt.date(2026, 10, 19), abrir=abrir_fixture)
caso("3. siguiente vuelta, API de vuelta: guarda los 7", r, (7, 0))
caso("3. ... en la base con su fuente", sorted(k[0] for k in srv.filas)[0:2], ["2026-10-12", "2026-10-13"])
existentes = list(srv.filas.values())
n = len(srv.llamadas)
r = C.completar_temperatura(srv, LOTES, existentes, dt.date(2026, 10, 19), abrir=abrir_fixture)
caso("3. CONTROL con todo guardado no se pide nada", (r, len(srv.llamadas) - n), ((0, 0), 0))
r = C.completar_temperatura(srv, LOTES, existentes[:5], dt.date(2026, 10, 19), abrir=abrir_fixture)
caso("3. faltan dos dias: solo esos se guardan", r, (2, 0))

# ─── 4. que dias tocan ──────────────────────────────────────────────────────
caso("4. fermentando: de la produccion a AYER",
     C.dias_que_faltan(LOTES, [], dt.date(2026, 10, 15)), ["2026-10-12", "2026-10-13", "2026-10-14"])
destilado = [dict(LOTES[0], etapas=[{"etapa": "destilacion", "fecha": "2026-10-14"}])]
caso("4. destilado: hasta el dia de la destilacion",
     C.dias_que_faltan(destilado, [], dt.date(2026, 10, 19)), ["2026-10-12", "2026-10-13", "2026-10-14"])
caso("4. 'manual' no tapa al proxy (otra fuente)",
     len(C.dias_que_faltan(LOTES, [{"fecha": "2026-10-12", "fuente": "manual"}], dt.date(2026, 10, 13))), 1)

# ─── 5. un nulo no se inventa ───────────────────────────────────────────────
con_nulo = json.loads(json.dumps(GRABADA))
con_nulo["daily"]["temperature_2m_mean"][2] = None
caso("5. un dia con nulo no sale", [d["fecha"] for d in C.de_open_meteo(con_nulo)][1:3], ["2026-10-13", "2026-10-15"])


# ─── 6. el tick sigue aunque Open-Meteo falle ───────────────────────────────
class ServidorCiclo(Servidor):
    def __call__(self, ruta, cuerpo):
        if cuerpo.get("accion") == "leer":
            self.llamadas.append((ruta, cuerpo))
            return 200, {"ok": True, "lotes": LOTES, "admins": [111], "temperaturas": [], "codigos": []}
        if cuerpo.get("accion") == "reclamar":
            self.llamadas.append((ruta, cuerpo))
            return 200, {"ok": True, "reclamado": True}
        return Servidor.__call__(self, ruta, cuerpo)


class BotTg(object):
    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, **k):
        self.enviados.append((chat_id, texto))


bot, srv = BotTg(), ServidorCiclo()
hecho = asyncio.run(C.tick(bot, srv, ahora=dt.datetime(2026, 10, 19, 16, 0, tzinfo=dt.timezone.utc), abrir=api_caida))
caso("6. Open-Meteo caido: la temperatura queda pendiente", hecho["temperatura"], (0, 7))
caso("6. ... y el tick siguio: mando el recordatorio del aditivo 2",
     [t for _l, t, _c in hecho["enviados"]], ["aditivo_2"])

fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
