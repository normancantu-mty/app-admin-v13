# -*- coding: utf-8 -*-
"""Lote v2: EL CICLO DEL LOTE -- codigo, recordatorios, etapas, muestra.

Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).

Llama a las funciones DE VERDAD (no lee el codigo fuente). La base es un
doble de `/api/bot/lote/ciclo` + `/api/bot/lote/etapa/*` que se porta como las
tablas: `lote_recordatorios` con PK (id_lote, tipo) e INSERT ... ON CONFLICT
DO NOTHING, `lote_etapas` unica por (id_lote, etapa). El reloj se inyecta.

  1. EL CODIGO: con 0 / 1 / 2 lotes del mismo dia sale .1 / .2 / .3
     (`codigo_siguiente`, formato leido del YAML, y `_codigo_nuevo_lote` del
     bot contra la ruta doblada). CONTROLES: otro dia u otro mes no cuentan; un
     hueco (.1 borrado) no se reusa.
  2. ADITIVO 2 en D+3: antes no; D+3 antes de las 8 no; D+3 a las 9 SI, a quien
     abrio el lote + los ADMIN, sin repetir. Otro latido: nada. REINICIO
     (importlib.reload de los modulos, la base sigue): nada.
  3. DESTILAR reposo_dias despues del aditivo 2: antes no; el dia SI, UNA vez,
     y tampoco tras reinicio. Ya destilado: no.
  4. MUESTRA: al confirmar la destilacion sale "Guarda una muestra" con su
     boton y queda reclamada (el latido no la repite). A las 23 h nada; a las 24 h
     UN segundo aviso; a las 48 h nada mas. Con "Ya la guarde" no hay segundo.
  5. LA ETAPA EN EL CHAT (bot real, botones reales): el resumen trae TODO + la
     fecha de hoy y NO sale nada al servidor antes de Confirmar; Corregir
     vuelve a preguntar; Confirmar propone + confirma con el SKU del aditivo 2
     del YAML. Destilacion por garrafa: pide las que faltan; avisa los rangos
     sin bloquear. TRABAJADOR: espera el Aprobar (no se escribe) y el aviso
     al aprobador lleva el resumen.
  6. Texto "aditivo 2 del L-..., 4 kilos": resumen directo, sin modelo.

Corre con:  python bot/probar_lote_ciclo.py      (sin red)
"""
import asyncio
import datetime as dt
import importlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import lote_ciclo as C  # noqa: E402
import lote_plantilla as P  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


UTC = dt.timezone.utc


def local(y, m, d, h, mi=0):
    """Hora de la planta (UTC-6) -> instante UTC."""
    return dt.datetime(y, m, d, h, mi, tzinfo=dt.timezone(dt.timedelta(hours=-6))).astimezone(UTC)


# ─── 1. el codigo ───────────────────────────────────────────────────────────
HOY = dt.date(2026, 10, 19)
caso("1. 0 lotes hoy -> .1", P.codigo_siguiente([], HOY), "L-19-10.1")
caso("1. 1 lote hoy -> .2", P.codigo_siguiente(["L-19-10.1"], HOY), "L-19-10.2")
caso("1. 2 lotes hoy -> .3", P.codigo_siguiente(["L-19-10.1", "L-19-10.2"], HOY), "L-19-10.3")
caso("1. CONTROL otro dia / otro mes no cuentan",
     P.codigo_siguiente(["L-18-10.1", "L-19-11.4", "L-1017", "L-19-10.1x"], HOY), "L-19-10.1")
caso("1. CONTROL un hueco no se reusa (.1 borrado, queda .2)", P.codigo_siguiente(["L-19-10.2"], HOY), "L-19-10.3")
caso("1. el formato sale del YAML", P.plantilla().get("formato_codigo"), "L-{dd}-{mm}.{n}")
caso("1. otro formato (YAML) funciona igual", P.codigo_siguiente(["19/10-1"], HOY, "{dd}/{mm}-{n}"), "19/10-2")


class Ciclo(object):
    """La base del ciclo, doblada como las tablas."""

    def __init__(self):
        self.lotes = {}         # id -> lote
        self.etapas = {}        # (id, etapa) -> fila
        self.recordatorios = {}  # (id, tipo) -> enviado_en (iso)
        self.estado = {}         # (id, tipo) -> {intentos, entregado_en}; sin fila = sembrado y entregado
        self.temperaturas = []
        self.ahora = dt.datetime(2026, 10, 19, 15, 0, tzinfo=UTC)
        self.llamadas = []
        self.esperar = False    # TRABAJADOR: confirmar contesta espera_aprobacion
        self.borradores = {}

    def nuevo_lote(self, id_lote, codigo, fecha, abrio=555):
        self.lotes[id_lote] = {"id": id_lote, "codigo_lote": codigo, "fecha_inicio": fecha,
                               "creado_en": fecha + "T15:00:00+00:00", "abrio_telegram_id": abrio}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, dict(cuerpo)))
        a = cuerpo.get("accion")
        if ruta == C.RUTA_CICLO and a == "leer":
            lotes = []
            for lid, l in self.lotes.items():
                lotes.append(dict(l, etapas=[dict(v, etapa=k[1]) for k, v in self.etapas.items() if k[0] == lid],
                                  recordatorios=[{"id_lote": lid, "tipo": k[1], "enviado_en": v,
                                                  "intentos": self.estado.get(k, {}).get("intentos", 1),
                                                  "entregado_en": self.estado.get(k, {}).get("entregado_en", v)}
                                                 for k, v in self.recordatorios.items() if k[0] == lid]))
            return 200, {"ok": True, "lotes": lotes, "admins": [111, 555], "temperaturas": list(self.temperaturas),
                         "codigos": [l["codigo_lote"] for l in self.lotes.values()]}
        if ruta == C.RUTA_CICLO and a == "reclamar":
            k = (cuerpo["id_lote"], cuerpo["tipo"])
            if k in self.recordatorios:
                return 200, {"ok": True, "reclamado": False}
            self.recordatorios[k] = self.ahora.isoformat()
            self.estado[k] = {"intentos": 1, "entregado_en": None}
            return 200, {"ok": True, "reclamado": True}
        if ruta == C.RUTA_CICLO and a == "reintentar":
            # UPDATE ... SET intentos = n+1 WHERE intentos = n AND entregado_en IS NULL
            k = (cuerpo["id_lote"], cuerpo["tipo"])
            e = self.estado.get(k)
            if not e or e["entregado_en"] or e["intentos"] != cuerpo["intentos"]:
                return 200, {"ok": True, "reclamado": False}
            e["intentos"] += 1
            return 200, {"ok": True, "reclamado": True}
        if ruta == C.RUTA_CICLO and a == "entregado":
            e = self.estado.setdefault((cuerpo["id_lote"], cuerpo["tipo"]), {"intentos": 1, "entregado_en": None})
            e["entregado_en"] = e["entregado_en"] or self.ahora.isoformat()
            return 200, {"ok": True}
        if ruta == C.RUTA_CICLO and a == "temperatura":
            self.temperaturas += cuerpo["dias"]
            return 200, {"ok": True}
        if ruta == C.RUTA_CICLO and a == "muestra":
            k = (cuerpo["id_lote"], "muestra")
            nueva = k not in self.etapas
            self.etapas.setdefault(k, {"fecha": self.ahora.date().isoformat(), "telegram_id": cuerpo["telegram_id"]})
            return 200, {"ok": True, "nueva": nueva, "mensaje": "Anotado: muestra guardada." if nueva else "Ya estaba anotada."}
        if ruta == C.RUTA_ETAPA_PROPONER:
            lote = next((l for l in self.lotes.values() if l["codigo_lote"] == cuerpo["codigo_lote"]), None)
            if not lote:
                return 404, {"ok": False, "error": "No encuentro el lote."}
            bid = "b-%d" % (len(self.borradores) + 1)
            self.borradores[bid] = dict(cuerpo, id_lote=lote["id"])
            return 200, {"ok": True, "borrador_id": bid, "sello": "s" * 64, "codigo_lote": lote["codigo_lote"],
                         "mensaje": "propuesta"}
        if ruta == C.RUTA_ETAPA_CONFIRMAR:
            b = self.borradores[cuerpo["borrador_id"]]
            if self.esperar:
                return 200, {"ok": False, "espera_aprobacion": True, "borrador_id": cuerpo["borrador_id"],
                             "mensaje": "No lo escribo todavia: espera el Aprobar de Norman.",
                             "mensaje_aprobador": "Kevin propuso una etapa de lote.", "avisar_a": [111]}
            self.etapas[(b["id_lote"], b["etapa"])] = {"fecha": self.ahora.date().isoformat(), "telegram_id": b["telegram_id"]}
            return 200, {"ok": True, "etapa": b["etapa"], "id_lote": b["id_lote"], "codigo_lote": b["codigo_lote"],
                         "mensaje": "Listo. Quedo la etapa %s del lote %s." % (b["etapa"], b["codigo_lote"])}
        if ruta == "/api/bot/lote/proponer":
            # El camino F0/D81 (agregar a un lote existente): propuesta con VA.
            return 200, {"ok": True, "borrador_id": "d81-1", "sello": "t" * 64,
                         "codigo_lote": (cuerpo.get("propuesta") or {}).get("codigo_lote"),
                         "mensaje": "Agrego al lote %s." % (cuerpo.get("propuesta") or {}).get("codigo_lote")}
        return 200, {"ok": True}


class BotTg(object):
    def __init__(self, fallan=()):
        self.enviados = []
        self.fallan = set(fallan)   # chat_ids a los que Telegram no entrega

    async def send_message(self, chat_id, texto, reply_markup=None, **k):
        if chat_id in self.fallan or "todos" in self.fallan:
            raise RuntimeError("Telegram no entrego (inyectado)")
        datos = [b.callback_data for fila in (reply_markup.inline_keyboard if reply_markup else ()) for b in fila]
        self.enviados.append((chat_id, texto, datos))


def latir(base, bot, ahora):
    base.ahora = ahora
    return asyncio.run(C.tick(bot, base, ahora=ahora, abrir=lambda u, t: {"daily": {}}))


def tipos(hecho):
    return sorted({t for _c, t, _x in hecho["enviados"]})


def reiniciar():
    """El proceso muere: todo lo de RAM se va. La base (el doble) sigue."""
    global C, P
    P = importlib.reload(P)
    C = importlib.reload(C)


# ─── 1b. el codigo, por el bot, contra la ruta ──────────────────────────────
import bot_gastos as B  # noqa: E402
base = Ciclo()
B._post_de_verdad = base
caso("1b. el bot sin lotes hoy -> .1", B.lote_ciclo.codigo_nuevo(base, ahora=local(2026, 10, 19, 9)), "L-19-10.1")
base.nuevo_lote("x1", "L-19-10.1", "2026-10-19")
caso("1b. con uno -> .2", B.lote_ciclo.codigo_nuevo(base, ahora=local(2026, 10, 19, 9)), "L-19-10.2")
base.nuevo_lote("x2", "L-19-10.2", "2026-10-19")
caso("1b. con dos -> .3", B.lote_ciclo.codigo_nuevo(base, ahora=local(2026, 10, 19, 9)), "L-19-10.3")
caso("1b. a las 23:30 de la planta (05:30 UTC del dia siguiente) sigue siendo el 19",
     B.lote_ciclo.codigo_nuevo(base, ahora=local(2026, 10, 19, 23, 30)), "L-19-10.3")
caso("1b. sin red sale .1 (no se inventa un N)", B.lote_ciclo.codigo_nuevo(lambda r, c: (0, {}), ahora=local(2026, 10, 19, 9)),
     "L-19-10.1")

# ─── 2. aditivo 2 en D+3 ────────────────────────────────────────────────────
base, bot = Ciclo(), BotTg()
base.nuevo_lote("lote-a", "L-12-10.1", "2026-10-12", abrio=555)
caso("2. D+2: nada", tipos(latir(base, bot, local(2026, 10, 14, 9))), [])
caso("2. D+3 a las 7 (antes de la hora del YAML): nada", tipos(latir(base, bot, local(2026, 10, 15, 7))), [])
h = latir(base, bot, local(2026, 10, 15, 9))
caso("2. D+3 a las 9: el recordatorio del aditivo 2", tipos(h), ["aditivo_2"])
caso("2. ... a quien abrio + ADMIN, sin repetir (555 es las dos cosas)",
     sorted(c for _l, _t, c in h["enviados"]), [111, 555])
caso("2. ... el texto dice el codigo y el dia", "L-12-10.1" in bot.enviados[0][1] and "dia 3" in bot.enviados[0][1], True)
caso("2. ... con el boton que abre la etapa", bot.enviados[0][2], ["ltad2:L-12-10.1"])
caso("2. ... callback_data <= 64 bytes", all(len(d.encode()) <= 64 for _c, _t, ds in bot.enviados for d in ds), True)
caso("2. otro latido: nada", tipos(latir(base, bot, local(2026, 10, 15, 9, 15))), [])
reiniciar()
caso("2. REINICIO del bot: tampoco (el reclamo esta en la base)", tipos(latir(base, bot, local(2026, 10, 16, 10))), [])
caso("2. ... salio UNA vez en total (2 personas)", len(bot.enviados), 2)

# ─── 3. destilar reposo_dias despues del aditivo 2 ──────────────────────────
base.etapas[("lote-a", "aditivo_2")] = {"fecha": "2026-10-15", "telegram_id": 555}
caso("3. reposo del YAML", C._ciclo()["reposo_dias"], 3)
caso("3. 2 dias despues del aditivo 2: nada", tipos(latir(base, bot, local(2026, 10, 17, 9))), [])
antes = len(bot.enviados)
h = latir(base, bot, local(2026, 10, 18, 9))
caso("3. 3 dias despues: ya toca destilar", tipos(h), ["destilar"])
caso("3. ... con su boton", bot.enviados[-1][2], ["ltdes:L-12-10.1"])
caso("3. otro latido: nada", tipos(latir(base, bot, local(2026, 10, 18, 9, 15))), [])
reiniciar()
caso("3. REINICIO: nada", tipos(latir(base, bot, local(2026, 10, 19, 9))), [])
caso("3. ... UNA vez (2 personas)", len(bot.enviados) - antes, 2)
otro = Ciclo()
otro.nuevo_lote("lote-b", "L-12-10.2", "2026-10-12")
otro.etapas[("lote-b", "aditivo_2")] = {"fecha": "2026-10-15"}
otro.etapas[("lote-b", "destilacion")] = {"fecha": "2026-10-17", "telegram_id": 555}
otro.recordatorios[("lote-b", "muestra")] = local(2026, 10, 17, 12).isoformat()
caso("3. CONTROL ya destilado: no se recuerda destilar", "destilar" in tipos(latir(otro, BotTg(), local(2026, 10, 18, 9))), False)


# ─── 5. la etapa en el chat, por el bot real ────────────────────────────────
class Mensaje(object):
    def __init__(self, chat, texto=""):
        self.chat = type("Chat", (), {"id": chat, "type": "private"})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos, self.teclados = [], []

    async def _nada(self, *a, **k):
        return None

    async def reply_text(self, texto, reply_markup=None, **k):
        self.dichos.append(str(texto))
        self.teclados.append([b.callback_data for fila in (reply_markup.inline_keyboard if reply_markup else ())
                              for b in fila])


class Update(object):
    def __init__(self, chat, texto=""):
        self.message = Mensaje(chat, texto)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat

    def get_bot(self):
        return BOT_APROBADOR


BOT_APROBADOR = BotTg()
CHAT = 555
importlib.reload(B.lote_ciclo)
C = B.lote_ciclo
P = B.lote_plantilla
base = Ciclo()
base.nuevo_lote("lote-a", "L-12-10.1", "2026-10-12")
B._post_de_verdad = base
B.enrutar = lambda *a, **k: (_ for _ in ()).throw(AssertionError("el modelo no debe llamarse"))


def boton(u, accion, arg="x"):
    asyncio.run(B._manejar_boton(u, CHAT, None, [accion, arg], accion))


def texto(u, t):
    u.message.text = t
    asyncio.run(B._enrutar_y_despachar(u, CHAT, t))


def rutas():
    return [r for r, _c in base.llamadas]


HOY_TXT = P.fecha_para_persona(C.ahora_local().date())
u = Update(CHAT)
boton(u, "ltad2", "L-12-10.1")
caso("5. boton del recordatorio: pregunta los kilos del aditivo 2", "Cuantos kilos de aditivo 2" in u.message.dichos[-1], True)
texto(u, "4.5")
res = u.message.dichos[-1]
caso("5. resumen: lote, etapa, fecha de hoy y kilos",
     ("LOTE L-12-10.1 - ADITIVO 2" in res, ("Fecha: %s (hoy)" % HOY_TXT) in res, "Kilos de aditivo 2: 4.5" in res),
     (True, True, True))
caso("5. ... con Confirmar / Corregir", u.message.teclados[-1], ["ltec:x", "ltecc:x"])
caso("5. ... y NADA salio al servidor antes de Confirmar", [r for r in rutas() if "/etapa/" in r], [])
boton(u, "ltecc")
caso("5. Corregir: vuelve a preguntar", "Cuantos kilos de aditivo 2" in u.message.dichos[-1], True)
caso("5. ... y sigue sin salir nada", [r for r in rutas() if "/etapa/" in r], [])
texto(u, "250")
caso("5. fuera de rango AVISA y no bloquea", ("Ojo" in u.message.dichos[-1], "Kilos de aditivo 2: 250" in u.message.dichos[-1]),
     (True, True))
texto(u, "4")
boton(u, "ltec")
prop = [c for r, c in base.llamadas if r == C.RUTA_ETAPA_PROPONER]
caso("5. Confirmar: propone UNA vez con kg y el SKU del YAML",
     [(c["etapa"], c["kg"], c["insumo_sku"], c["codigo_lote"]) for c in prop], [("aditivo_2", 4.0, "ing-al", "L-12-10.1")])
caso("5. ... y confirma", rutas().count(C.RUTA_ETAPA_CONFIRMAR), 1)
caso("5. ... quedo en la base", ("lote-a", "aditivo_2") in base.etapas, True)
caso("5. ... y lo dice", u.message.dichos[-1].startswith("Listo."), True)

# destilacion
u = Update(CHAT)
boton(u, "ltdes", "L-12-10.1")
caso("5. destilacion: pregunta garrafas, peso y %", "Cuantas garrafas" in u.message.dichos[-1], True)
texto(u, "3 garrafas: 18.5 kg 52%, 17 kg 48%")
caso("5. ... falta una: la pide", ("Me falta" in u.message.dichos[-1], "garrafa 3" in u.message.dichos[-1]), (True, True))
texto(u, "10 kg 95%")
res = u.message.dichos[-1]
caso("5. resumen de destilacion: todas las garrafas y la fecha",
     ("LOTE L-12-10.1 - DESTILACION" in res, "Garrafas: 3" in res, "Garrafa 1: 18.5 kg a 52.0%" in res,
      "Garrafa 3: 10.0 kg a 95.0%" in res, ("Fecha: %s (hoy)" % HOY_TXT) in res), (True, True, True, True, True))
caso("5. ... 95% avisa (fuera de 0-80) sin bloquear", "Ojo: la garrafa 3" in res, True)
caso("5. ... nada salio todavia", rutas().count(C.RUTA_ETAPA_PROPONER), 1)
base.ahora = local(2026, 10, 19, 10)
boton(u, "ltec")
prop = [c for r, c in base.llamadas if r == C.RUTA_ETAPA_PROPONER][-1]
caso("5. Confirmar destilacion: una fila por garrafa (peso, %)", prop["garrafas"],
     [{"peso_kg": 18.5, "grado_alcohol": 52.0}, {"peso_kg": 17.0, "grado_alcohol": 48.0},
      {"peso_kg": 10.0, "grado_alcohol": 95.0}])
caso("5. ... sin litros (no se inventa densidad)", any("litros" in g for g in prop["garrafas"]), False)

# ─── 4. la muestra ──────────────────────────────────────────────────────────
caso("4. al confirmar la destilacion: 'Guarda una muestra del lote'",
     "Guarda una muestra del lote L-12-10.1" in u.message.dichos[-1], True)
caso("4. ... con el boton Ya la guarde", u.message.teclados[-1], ["ltmu:lote-a"])
caso("4. ... y quedo reclamada en la base", ("lote-a", "muestra") in base.recordatorios, True)
bot = BotTg()
caso("4. el latido NO la repite", tipos(latir(base, bot, local(2026, 10, 19, 10, 15))), [])
caso("4. a las 23 h: nada", tipos(latir(base, bot, local(2026, 10, 20, 9))), [])
h = latir(base, bot, local(2026, 10, 20, 10))
caso("4. a las 24 h: UN segundo aviso", tipos(h), ["muestra_2"])
caso("4. ... a quien abrio, ADMIN y quien destilo", sorted({c for _l, _t, c in h["enviados"]}), [111, 555])
reiniciar()
caso("4. REINICIO y 48 h: nada mas", tipos(latir(base, bot, local(2026, 10, 21, 10))), [])
u2 = Update(CHAT)
boton(u2, "ltmu", "lote-a")
caso("4. 'Ya la guarde': quien y cuando", (base.etapas.get(("lote-a", "muestra")) or {}).get("telegram_id"), CHAT)
caso("4. ... y lo dice", u2.message.dichos[-1], "Anotado: muestra guardada.")
otro = Ciclo()
otro.nuevo_lote("lote-c", "L-13-10.1", "2026-10-13")
otro.etapas[("lote-c", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": 777}
otro.recordatorios[("lote-c", "muestra")] = local(2026, 10, 19, 10).isoformat()
otro.etapas[("lote-c", "muestra")] = {"fecha": "2026-10-19", "telegram_id": 777}
caso("4. CONTROL con 'Ya la guarde' no hay segundo aviso", tipos(latir(otro, BotTg(), local(2026, 10, 20, 11))), [])
otro.etapas.pop(("lote-c", "muestra"))
otro.recordatorios.pop(("lote-c", "muestra"))
h = latir(otro, BotTg(), local(2026, 10, 19, 11))
caso("4. red: destilado sin muestra reclamada -> el latido manda la primera", tipos(h), ["muestra"])
caso("4. ... tambien a quien destilo (777)", 777 in [c for _l, _t, c in h["enviados"]], True)

# ─── 5b. TRABAJADOR: espera el Aprobar ──────────────────────────────────────
C = B.lote_ciclo
base.esperar = True
base.etapas.pop(("lote-a", "aditivo_2"), None)
B._por_aprobar.clear()
u = Update(CHAT)
boton(u, "ltad2", "L-12-10.1")
texto(u, "3 kilos")
boton(u, "ltec")
caso("5b. TRABAJADOR: no se escribio", ("lote-a", "aditivo_2") in base.etapas, False)
caso("5b. ... se le dice que espera el Aprobar", "espera el Aprobar" in u.message.dichos[-1], True)
caso("5b. ... y queda anotado para avisar al aprobador", [p["avisar_a"] for p in B._por_aprobar], [[111]])
asyncio.run(B._avisar_aprobaciones(u))
caso("5b. el aviso al aprobador lleva el resumen con la fecha",
     ("Kilos de aditivo 2: 3" in BOT_APROBADOR.enviados[-1][1], ("Fecha: %s" % HOY_TXT) in BOT_APROBADOR.enviados[-1][1]),
     (True, True))
caso("5b. ... con Aprobar / Rechazar", [d.split(":")[0] for d in BOT_APROBADOR.enviados[-1][2]], ["apr", "rch"])
caso("5b. la ruta de Aprobar de lote_etapa existe", B.RUTA_CONFIRMAR_DE.get("lote_etapa"), "/api/bot/lote/etapa/confirmar")
base.esperar = False

# ─── 6. por texto, sin modelo ───────────────────────────────────────────────
base.etapas.pop(("lote-a", "aditivo_2"), None)
n = rutas().count(C.RUTA_ETAPA_PROPONER)
u = Update(CHAT)
texto(u, "aditivo 2 del L-12-10.1, 4 kilos")
caso("6. 'aditivo 2 del L-..., 4 kilos': resumen directo", "Kilos de aditivo 2: 4" in u.message.dichos[-1], True)
caso("6. ... sin proponer todavia", rutas().count(C.RUTA_ETAPA_PROPONER), n)
texto(u, "confirmar")
caso("6. 'confirmar' dicho: propone y confirma", (rutas().count(C.RUTA_ETAPA_PROPONER), ("lote-a", "aditivo_2") in base.etapas),
     (n + 1, True))
u = Update(CHAT)
texto(u, "destilamos hoy")
caso("6. sin codigo: pregunta de cual lote", "De cual lote?" in u.message.dichos[-1], True)

# --- 7. RONDA 2 (H1): NO-REGRESION del camino F0/D81 y frases naturales ------
# El auditor: "le pusimos 4 kilos de aditivo 2 al L-12-10.1" y "agregale 5
# kilos de ing-az al lote L-12-10.1" abrian la plantilla de lote NUEVO.
base.etapas.pop(("lote-a", "aditivo_2"), None)
B._olvidar_chat(CHAT)
P.olvidar(CHAT)
C.olvidar(CHAT)
u = Update(CHAT)
texto(u, "le pusimos 4 kilos de aditivo 2 al L-12-10.1")
caso("7. 'le pusimos 4 kilos de aditivo 2 al L-12-10.1' (sin modelo): resumen de la etapa del L-12-10.1",
     ("LOTE L-12-10.1 - ADITIVO 2" in u.message.dichos[-1], "Kilos de aditivo 2: 4" in u.message.dichos[-1]),
     (True, True))
caso("7. ... NO abre la plantilla de lote nuevo", any("Me falta" in d for d in u.message.dichos), False)
C.olvidar(CHAT)
u = Update(CHAT)
texto(u, "oye, ya destilamos el L-12-10.1: 2 garrafas, 18 kg 50% y 10 kg 30%")
caso("7. frase natural de destilacion con codigo en medio: resumen con 2 garrafas",
     ("DESTILACION" in u.message.dichos[-1], "Garrafa 2: 10.0 kg a 30.0%" in u.message.dichos[-1]), (True, True))
C.olvidar(CHAT)
caso("7. CONTROL 'aditivo 2' en medio SIN codigo no dispara la etapa", C._disparo("cuanto aditivo 2 queda en bodega"),
     (None, None))

MODELO = []


def modelo_dice(campos):
    def enrutar(*a, **k):
        MODELO.append(a[0])
        return True, {"intencion": "lote", "confianza": "alta", "campos": dict(campos), "entendido": "lote"}
    return enrutar


B.enrutar = modelo_dice({"codigo_lote": "L-12-10.1", "insumos": [{"insumo": "ing-az", "cantidad": 5}]})
n = len(base.llamadas)
u = Update(CHAT)
texto(u, "agregale 5 kilos de ing-az al lote L-12-10.1")
props = [c for r, c in base.llamadas[n:] if r == "/api/bot/lote/proponer"]
caso("7. 'agregale 5 kilos de ing-az al lote L-12-10.1' pasa por el modelo", MODELO[-1:],
     ["agregale 5 kilos de ing-az al lote L-12-10.1"])
caso("7. ... y va al camino D81: /lote/proponer con el codigo y el insumo",
     [(c["propuesta"].get("codigo_lote"), c["insumos"]) for c in props],
     [("L-12-10.1", [{"insumo": "ing-az", "cantidad": 5}])])
caso("7. ... con el VA del lote", u.message.teclados[-1][:1] != [], True)
caso("7. ... NO la plantilla de lote nuevo", any("Me falta" in d for d in u.message.dichos), False)
B._olvidar_chat(CHAT)

# El modelo leyo la frase del aditivo 2 (si el regex no la hubiera tomado):
# insumo ajeno a la plantilla y codigo -> tambien D81.
B.enrutar = modelo_dice({"codigo_lote": "L-12-10.1", "insumos": [{"insumo": "aditivo 2", "cantidad": 4}]})
n = len(base.llamadas)
u = Update(CHAT)
asyncio.run(B._despachar_hecho(u, CHAT, {"intencion": "lote", "campos": {
    "codigo_lote": "L-12-10.1", "insumos": [{"insumo": "aditivo 2", "cantidad": 4}]}}))
caso("7. por el modelo, 'aditivo 2' + codigo -> D81 (no plantilla)",
     ([r for r, _c in base.llamadas[n:]].count("/api/bot/lote/proponer"), any("Me falta" in d for d in u.message.dichos)),
     (1, False))
B._olvidar_chat(CHAT)
# Insumo ajeno SIN codigo: tambien F0 (como 24d1cbd: lo resuelve el servidor).
n = len(base.llamadas)
u = Update(CHAT)
asyncio.run(B._despachar_hecho(u, CHAT, {"intencion": "lote", "campos": {
    "insumos": [{"insumo": "levadura", "cantidad": 1}]}}))
caso("7. insumo ajeno sin codigo -> F0 (/lote/proponer)",
     [r for r, _c in base.llamadas[n:]].count("/api/bot/lote/proponer"), 1)
B._olvidar_chat(CHAT)
# CONTROL: abrir un lote nuevo (solo chile) SIGUE yendo a la plantilla.
n = len(base.llamadas)
u = Update(CHAT)
asyncio.run(B._despachar_hecho(u, CHAT, {"intencion": "lote", "campos": {"kg_chile": 80}}))
caso("7. CONTROL solo kg_chile -> la plantilla (pregunta lo que falta, sin proponer)",
     ([r for r, _c in base.llamadas[n:]].count("/api/bot/lote/proponer"), any("Me falta" in d for d in u.message.dichos)),
     (0, True))
caso("7. CONTROL chile + aditivo 1 (ing-az) sin codigo -> la plantilla",
     B._lote_es_de_otro_camino({"insumos": [{"insumo": "chile-guajillo", "cantidad": 80},
                                            {"insumo": "ing-az", "cantidad": 2}]}), False)
P.olvidar(CHAT)
B._olvidar_chat(CHAT)

# --- 8. RONDA 2: a lo mas una vez, pero ENTREGADO (reintento con tope) -------
caso("8. el tope sale del YAML", C._ciclo()["intentos_recordatorio"], 3)
base8 = Ciclo()
base8.nuevo_lote("lote-r", "L-12-10.3", "2026-10-12", abrio=555)
h = latir(base8, BotTg(fallan=["todos"]), local(2026, 10, 15, 9))
caso("8. fallan TODOS los envios: nada salio", (h["enviados"], h["sin_entregar"]), ([], [("L-12-10.3", "aditivo_2", 1)]))
caso("8. ... en la base queda reclamado SIN entregar", dict(base8.estado[("lote-r", "aditivo_2")]), {"intentos": 1, "entregado_en": None})
reiniciar()
bot8 = BotTg()
h = latir(base8, bot8, local(2026, 10, 15, 9, 15))
caso("8. siguiente latido (y tras REINICIO): se reintenta y sale", tipos(h), ["aditivo_2"])
caso("8. ... por el compare-and-swap (reintentar con intentos=1)",
     [c.get("intentos") for r, c in base8.llamadas if c.get("accion") == "reintentar"], [1])
caso("8. ... y queda entregado", (base8.estado[("lote-r", "aditivo_2")]["intentos"],
                                  bool(base8.estado[("lote-r", "aditivo_2")]["entregado_en"])), (2, True))
caso("8. otro latido: nada (ya entregado)", tipos(latir(base8, bot8, local(2026, 10, 15, 9, 30))), [])
# el tope: Telegram nunca entrega
base8b = Ciclo()
base8b.nuevo_lote("lote-t", "L-12-10.4", "2026-10-12")
caido = BotTg(fallan=["todos"])
intentos = []
for i in range(5):
    intentos.append([n for _c, _t, n in latir(base8b, caido, local(2026, 10, 15, 9 + i, 0))["sin_entregar"]])
caso("8. TOPE: intenta 1, 2, 3 y despues ya no", intentos, [[1], [2], [3], [], []])
# entrega parcial: uno falla, otro recibe -> entregado, sin reintento
base8c = Ciclo()
base8c.nuevo_lote("lote-p", "L-12-10.5", "2026-10-12", abrio=555)
h = latir(base8c, BotTg(fallan=[111]), local(2026, 10, 15, 9))
caso("8. parcial (111 falla, 555 recibe): entregado, sin reintento",
     ([c for _l, _t, c in h["enviados"]], h["sin_entregar"], bool(base8c.estado[("lote-p", "aditivo_2")]["entregado_en"])),
     ([555], [], True))
caso("8. ... el siguiente latido no lo repite", tipos(latir(base8c, BotTg(), local(2026, 10, 15, 9, 15))), [])
caso("8. CONTROL: dos latidos con el mismo intentos -> gana UNO",
     (C.reclamar(base8b, "lote-t", "aditivo_2", 3), C.reclamar(base8b, "lote-t", "aditivo_2", 3)), (True, False))

# --- 9. RONDA 2: muestra_2 respeta hora_recordatorios ------------------------
base9 = Ciclo()
base9.nuevo_lote("lote-m", "L-13-10.2", "2026-10-13")
base9.etapas[("lote-m", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": 777}
base9.recordatorios[("lote-m", "muestra")] = local(2026, 10, 19, 2).isoformat()   # destilaron de madrugada
caso("9. muestra_2 a las 3 de la manana (25 h despues): NO", tipos(latir(base9, BotTg(), local(2026, 10, 20, 3))), [])
caso("9. ... a las 7: NO (antes de la hora del YAML)", tipos(latir(base9, BotTg(), local(2026, 10, 20, 7, 59))), [])
caso("9. ... a las 8: SI", tipos(latir(base9, BotTg(), local(2026, 10, 20, 8))), ["muestra_2"])

# --- 10. RONDA 2: la temperatura DICTADA del cuarto (fuente manual) ----------
caso("10. 'en el cuarto hay 22 grados' -> 22", C.leer_temperatura_manual("en el cuarto hay 22 grados"), 22)
caso("10. '19.5 grados en el cuarto' -> 19.5", C.leer_temperatura_manual("ahorita 19.5 grados en el cuarto"), 19.5)
caso("10. 'la temperatura esta en 21 C' -> 21", C.leer_temperatura_manual("la temperatura esta en 21 c"), 21)
caso("10. CONTROL 'a 24 grados' suelto NO es temperatura", C.leer_temperatura_manual("dos tambos de 200 litros a 24 grados"), None)
caso("10. CONTROL '18 kg 52 grados' NO es temperatura", C.leer_temperatura_manual("garrafa de 18 kg a 52 grados"), None)
base10 = Ciclo()
base10.nuevo_lote("lote-f", "L-19-10.1", "2026-10-19")
B._post_de_verdad = base10
B.enrutar = lambda *a, **k: (_ for _ in ()).throw(AssertionError("el modelo no debe llamarse"))
B._olvidar_chat(CHAT)
C.olvidar(CHAT)
P.olvidar(CHAT)
C._temperaturas.clear()


def temps(base_):
    return [c for r, c in base_.llamadas if c.get("accion") == "temperatura"]


u = Update(CHAT)
texto(u, "en el cuarto hay 22 grados")
# Ronda 3 (R2-A): ninguna temperatura se guarda sin pasar por Confirmar.
caso("10. solo temperatura: la ENSENA con Confirmar y NO la guarda todavia",
     (temps(base10), "Temperatura del cuarto: 22" in u.message.dichos[-1], u.message.teclados[-1]),
     ([], True, ["lttc:x", "lttn:x"]))
boton(u, "lttc")
caso("10. Confirmar: se guarda fuente=manual, min=max=prom=22",
     [(d["fuente"], d["t_min"], d["t_max"], d["t_prom"]) for d in base10.temperaturas], [("manual", 22.0, 22.0, 22.0)])
caso("10. ... y lo dice, con el lote", ("Anotado: 22" in u.message.dichos[-1], "L-19-10.1" in u.message.dichos[-1]), (True, True))
texto(u, "ya bajo, hay 18 grados en el cuarto")
caso("10. segunda lectura: ensenada, sin guardar", len(base10.temperaturas), 1)
texto(u, "si")
caso("10. ... 'si' escrito la confirma: min 18, max 22, prom (punto medio) 20",
     [(d["t_min"], d["t_max"], d["t_prom"]) for d in base10.temperaturas[-1:]], [(18.0, 22.0, 20.0)])
caso("10. ... el modelo no se llamo y no se abrio etapa ni plantilla", (C.sesion(CHAT), P.activa(CHAT)), (None, False))
texto(u, "en el cuarto hay 30 grados")
boton(u, "lttn")
caso("10. 'No la guardes': no se guarda", (len(base10.temperaturas), "no se guarda" in u.message.dichos[-1]), (2, True))
boton(u, "lttc")
caso("10. ... y un Confirmar viejo ya no guarda nada", (len(base10.temperaturas), "No tengo ninguna temperatura" in
                                                         u.message.dichos[-1]), (2, True))
# en medio de una destilacion: la temperatura (sola) NO se lee como garrafa
C.empezar(CHAT, "destilacion", "L-19-10.1")
texto(u, "en el cuarto hay 23 grados")
caso("10. en captura de destilacion: se ofrece la temperatura, no es garrafa",
     (u.message.teclados[-1], C.sesion(CHAT)["garrafas"]), (["lttc:x", "lttn:x"], []))
boton(u, "lttc")
caso("10. ... y con Confirmar se guarda", base10.temperaturas[-1]["t_max"], 23.0)
C.olvidar(CHAT)
base10.etapas[("lote-f", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": 555}
n = len(base10.temperaturas)
u = Update(CHAT)
texto(u, "en el cuarto hay 22 grados")
caso("10. CONTROL sin lote en fermentacion: NO se ofrece ni se guarda, y lo dice",
     (len(base10.temperaturas) - n, "No hay ningun lote en fermentacion" in u.message.dichos[-1], u.message.teclados[-1]),
     (0, True, []))
base10.etapas.pop(("lote-f", "destilacion"))

# --- 11. RONDA 3: mensajes COMPUESTOS (criterio nuevo del auditor) -----------
# Todo interceptor que corre antes del modelo o de la sesion: la otra mitad del
# mensaje NO se pierde, y la temperatura no se guarda sin Confirmar.
caso("11. pura: 'la temperatura del alcohol salio a 50 grados' NO es del cuarto",
     C.temperatura_del_mensaje("la temperatura del alcohol salio a 50 grados"), None)
caso("11. pura: 'temperatura de salida del alambique 78 grados' NO es del cuarto",
     C.temperatura_del_mensaje("temperatura de salida del alambique 78 grados"), None)
caso("11. pura: apertura + temperatura es COMPUESTO, con contexto de cuarto, y la otra mitad intacta",
     C.temperatura_del_mensaje("hoy empezamos lote, 40 kilos de chile guajillo, brix 12, temperatura ambiente 24 grados"),
     {"valor": 24, "solo": False, "cuarto": True, "sin": "hoy empezamos lote, 40 kilos de chile guajillo, brix 12"})
caso("11. pura: 'temperatura 22c' sola es SOLO", C.temperatura_del_mensaje("temperatura 22c")["solo"], True)
caso("11. pura: temperatura + 'y ya pague la luz' NO es solo",
     C.temperatura_del_mensaje("el cuarto esta a 22 grados y ya pague la luz")["solo"], False)

MODELO11 = []


def modelo11(respuesta):
    def enrutar(*a, **k):
        MODELO11.append(a[0])
        return True, dict(respuesta)
    return enrutar


B.enrutar = lambda *a, **k: (_ for _ in ()).throw(AssertionError("el modelo no debe llamarse"))
B._olvidar_chat(CHAT)
P.olvidar(CHAT)
C.olvidar(CHAT)
C._temperaturas.clear()
n = len(temps(base10))
# (a) apertura + temperatura, la frase EXACTA de la sonda del auditor
u = Update(CHAT)
texto(u, "hoy empezamos lote, 40 kilos de chile guajillo, brix 12, temperatura ambiente 24 grados")
s11 = P.sesion(CHAT)
caso("11a. apertura + temperatura: se abre la plantilla con los 40 kg de guajillo (sin modelo)",
     (bool(s11), (s11 or {}).get("campos", {}).get("kg_chile"), (s11 or {}).get("campos", {}).get("tipo_chile")),
     (True, 40, "guajillo"))
caso("11a. ... 'brix 12' sin decir cual NO se pierde: va a notas",
     any("Brix 12" in x for x in (s11 or {}).get("notas", [])), True)
caso("11a. ... el 24 NO se leyo como dato de la plantilla", 24 in ((s11 or {}).get("campos") or {}).values(), False)
caso("11a. ... pregunta lo que falta", any("Me falta" in d for d in u.message.dichos), True)
caso("11a. ... y DESPUES ofrece la temperatura con Confirmar", (u.message.dichos[-1].startswith("Tambien dijiste"),
                                                                u.message.teclados[-1]), (True, ["lttc:x", "lttn:x"]))
caso("11a. ... sin guardar ninguna temperatura", len(temps(base10)) - n, 0)
P.olvidar(CHAT)
C._temperaturas.clear()
# (b) plantilla viva + kg/brix + temperatura
u = Update(CHAT)
texto(u, "hoy empezamos lote")
texto(u, "40 kilos de chile guajillo brix chile 12, la temperatura del cuarto 24 grados")
s11 = P.sesion(CHAT) or {}
caso("11b. plantilla viva + kg/brix + temperatura: kg y brix entran a la plantilla",
     ((s11.get("campos") or {}).get("kg_chile"), (s11.get("campos") or {}).get("brix_chile")), (40, 12))
caso("11b. ... la temperatura se ofrece aparte y no se guarda", (u.message.teclados[-1], len(temps(base10)) - n),
     (["lttc:x", "lttn:x"], 0))
texto(u, "brix 18")
caso("11b. ... 'brix 18' con solo el Brix final pendiente -> Brix final",
     ((P.sesion(CHAT) or {}).get("campos") or {}).get("brix_final"), 18)
P.olvidar(CHAT)
C._temperaturas.clear()
# (c) garrafas + temperatura, dentro de la destilacion
u = Update(CHAT)
boton(u, "ltdes", "L-19-10.1")
texto(u, "2 garrafas: 18 kg 50% y 10 kg 30%, el cuarto estaba a 22 grados")
res = [d for d in u.message.dichos if "DESTILACION" in d]
caso("11c. garrafas + temperatura: el resumen trae las 2 garrafas",
     (bool(res), bool(res) and "Garrafa 1: 18.0 kg a 50.0%" in res[-1], bool(res) and "Garrafa 2: 10.0 kg a 30.0%" in res[-1]),
     (True, True, True))
caso("11c. ... la etapa queda en resumen con 2 garrafas", (C.sesion(CHAT) or {}).get("garrafas"), [(18.0, 50.0), (10.0, 30.0)])
caso("11c. ... la temperatura se ofrece DESPUES, sin guardarse",
     (u.message.dichos[-1].startswith("Tambien dijiste"), len(temps(base10)) - n), (True, 0))
caso("11c. ... y 'si' escrito NO confirma la temperatura de un compuesto (solo su boton)",
     (asyncio.run(C.atender(u, CHAT, "si", None, post=base10)), len(temps(base10)) - n), (False, 0))
boton(u, "lttc")
caso("11c. ... con su boton Confirmar, si", (len(temps(base10)) - n, base10.temperaturas[-1]["t_max"]), (1, 22.0))
C.olvidar(CHAT)
# (d) 'la temperatura del alcohol' en la destilacion: ni temperatura ni se pierde en silencio
B.enrutar = modelo11({"intencion": "otro", "confianza": "baja", "campos": {}})
n = len(temps(base10))
u = Update(CHAT)
boton(u, "ltdes", "L-19-10.1")
texto(u, "la temperatura del alcohol salio a 50 grados")
caso("11d. 'la temperatura del alcohol salio a 50 grados': NO se ofrece ni se guarda como del cuarto",
     (len(temps(base10)) - n, any(t == ["lttc:x", "lttn:x"] for t in u.message.teclados)), (0, False))
caso("11d. ... y sigue al modelo (no se traga)", MODELO11[-1:], ["la temperatura del alcohol salio a 50 grados"])
C.olvidar(CHAT)
B._olvidar_chat(CHAT)
# (e) envasado F0 + "destilamos": NO abre la destilacion; va al modelo -> F0/D81
for frase, campos in [
        ("envasamos 40 de 750 del L-12-10.1 que destilamos el viernes",
         {"codigo_lote": "L-12-10.1", "botellas": 40, "formato": "750"}),
        ("del L-12-10.1 salieron 40 de 250, lo destilaron el lunes",
         {"codigo_lote": "L-12-10.1", "botellas": 40, "formato": "250"})]:
    B.enrutar = modelo11({"intencion": "lote", "confianza": "alta", "campos": campos, "entendido": "envasado"})
    C.olvidar(CHAT)
    B._olvidar_chat(CHAT)
    n = len(base10.llamadas)
    u = Update(CHAT)
    texto(u, frase)
    props = [c for r, c in base10.llamadas[n:] if r == "/api/bot/lote/proponer"]
    caso("11e. '%s': NO abre la captura de destilacion" % frase,
         (C.sesion(CHAT), any("destilacion. Cuantas garrafas" in d for d in u.message.dichos)), (None, False))
    caso("11e. ... pasa por el modelo y va al camino F0/D81 con el envasado",
         (MODELO11[-1], [(c["propuesta"].get("codigo_lote"), c["envasado"]) for c in props]),
         (frase, [("L-12-10.1", [{"botellas": 40, "formato": campos["formato"]}])]))
B._olvidar_chat(CHAT)
# (f) pregunta con codigo L-: no abre la etapa
B.enrutar = modelo11({"intencion": "otro", "confianza": "baja", "campos": {}})
for frase in ("cuanto aditivo 2 lleva el L-12-10.1?", "cuantas garrafas salieron del L-12-10.1 que destilamos"):
    C.olvidar(CHAT)
    n = len(base10.llamadas)
    u = Update(CHAT)
    texto(u, frase)
    caso("11f. pregunta '%s': NO abre etapa, va al modelo" % frase,
         (C.sesion(CHAT), MODELO11[-1], [r for r, _c in base10.llamadas[n:] if "/etapa/" in r]), (None, frase, []))
# (g) CONTROL: la frase de H1 sigue abriendo la etapa sin modelo
B.enrutar = lambda *a, **k: (_ for _ in ()).throw(AssertionError("el modelo no debe llamarse"))
C.olvidar(CHAT)
u = Update(CHAT)
texto(u, "le pusimos 4 kilos de aditivo 2 al L-12-10.1")
caso("11g. CONTROL H1: 'le pusimos 4 kilos de aditivo 2 al L-12-10.1' sigue abriendo la etapa",
     ("LOTE L-12-10.1 - ADITIVO 2" in u.message.dichos[-1]), True)
C.olvidar(CHAT)
caso("11g. CONTROL: 'destilamos el L-12-10.1, garrafa 1 18 kilos a 50 grados' no trae temperatura del cuarto",
     C.temperatura_del_mensaje("destilamos el L-12-10.1, garrafa 1 18 kilos a 50 grados"), None)
B._olvidar_chat(CHAT)
P.olvidar(CHAT)
C._temperaturas.clear()


# --- 12. RONDA 3 (R2-C): el envio SI salio y el POST `entregado` fallo -------
class FallaEntregado(object):
    """La base de siempre, pero el POST `entregado` falla las primeras `n` veces."""

    def __init__(self, base_, n):
        self.base, self.n = base_, n

    def __call__(self, ruta, cuerpo):
        if cuerpo.get("accion") == "entregado" and self.n > 0:
            self.n -= 1
            self.base.llamadas.append((ruta, dict(cuerpo, fallo=True)))
            return 503, {"error": "timeout (inyectado)"}
        return self.base(ruta, cuerpo)


C._sin_marcar.clear()
base12 = Ciclo()
base12.nuevo_lote("lote-e", "L-12-10.6", "2026-10-12", abrio=555)
post12 = FallaEntregado(base12, 1)
bot12 = BotTg()
for i in range(4):
    base12.ahora = local(2026, 10, 15, 9, 15 * i)
    asyncio.run(C.tick(bot12, post12, ahora=base12.ahora, abrir=lambda u_, t_: {"daily": {}}))
caso("12. salio y 'entregado' fallo: 4 latidos -> 2 envios (los 2 destinatarios), no 4",
     sorted(c for c, _t, _d in bot12.enviados), [111, 555])
caso("12. ... el siguiente latido solo reintento la MARCA y quedo entregado",
     (bool(base12.estado[("lote-e", "aditivo_2")]["entregado_en"]), base12.estado[("lote-e", "aditivo_2")]["intentos"]),
     (True, 1))
caso("12. ... sin otro reclamo (ni reintentar)", [c.get("accion") for r, c in base12.llamadas
                                                 if c.get("accion") in ("reclamar", "reintentar")], ["reclamar"])
caso("12. ... y la marca local se limpio", C._sin_marcar, set())
# la muestra del confirmar: mismo hueco
C._sin_marcar.clear()
base12b = Ciclo()
base12b.nuevo_lote("lote-g", "L-13-10.3", "2026-10-13")
base12b.etapas[("lote-g", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": CHAT}
u = Update(CHAT)
asyncio.run(C.pedir_muestra(u, FallaEntregado(base12b, 1), "lote-g", "L-13-10.3"))
caso("12b. muestra al confirmar: sale una vez aunque 'entregado' falle",
     sum("Guarda una muestra" in d for d in u.message.dichos), 1)
bot12b = BotTg()
latir(base12b, bot12b, local(2026, 10, 19, 11))
caso("12b. ... el latido NO la reenvia (solo marca)", (bot12b.enviados, bool(base12b.estado[("lote-g", "muestra")]["entregado_en"])),
     ([], True))

# --- 13. RONDA 3: el REINTENTO de la primera muestra respeta la hora ---------
base13 = Ciclo()
base13.nuevo_lote("lote-h", "L-13-10.4", "2026-10-13")
base13.etapas[("lote-h", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": 777}
base13.recordatorios[("lote-h", "muestra")] = local(2026, 10, 19, 2).isoformat()
base13.estado[("lote-h", "muestra")] = {"intentos": 1, "entregado_en": None}   # reclamada, no salio
caso("13. reintento de la primera muestra a las 3: NO", tipos(latir(base13, BotTg(), local(2026, 10, 19, 3))), [])
caso("13. ... a las 8: SI", tipos(latir(base13, BotTg(), local(2026, 10, 19, 8))), ["muestra"])
base13b = Ciclo()
base13b.nuevo_lote("lote-i", "L-13-10.5", "2026-10-13")
base13b.etapas[("lote-i", "destilacion")] = {"fecha": "2026-10-19", "telegram_id": 777}
caso("13. CONTROL la PRIMERA (red, sin reclamo) sale a cualquier hora",
     tipos(latir(base13b, BotTg(), local(2026, 10, 19, 3))), ["muestra"])

fallos = [(n_, o, e) for n_, o, e in casos if o != e]
for n_, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n_ + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
