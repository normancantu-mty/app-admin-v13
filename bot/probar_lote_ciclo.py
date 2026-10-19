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
                                  recordatorios=[{"id_lote": lid, "tipo": k[1], "enviado_en": v}
                                                 for k, v in self.recordatorios.items() if k[0] == lid]))
            return 200, {"ok": True, "lotes": lotes, "admins": [111, 555], "temperaturas": list(self.temperaturas),
                         "codigos": [l["codigo_lote"] for l in self.lotes.values()]}
        if ruta == C.RUTA_CICLO and a == "reclamar":
            k = (cuerpo["id_lote"], cuerpo["tipo"])
            if k in self.recordatorios:
                return 200, {"ok": True, "reclamado": False}
            self.recordatorios[k] = self.ahora.isoformat()
            return 200, {"ok": True, "reclamado": True}
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
        return 200, {"ok": True}


class BotTg(object):
    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, reply_markup=None, **k):
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

fallos = [(n_, o, e) for n_, o, e in casos if o != e]
for n_, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n_ + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
