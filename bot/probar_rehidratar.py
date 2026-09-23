# -*- coding: utf-8 -*-
"""D77 — proponer, REINICIAR el proceso, y que el VA confirme el mismo borrador.

Todo contra un ERP FALSO local (un `http.server` en 127.0.0.1): no hay dinero
posible. Tres procesos de bot distintos, en fila:

  1. `proponer`: un proceso nuevo recibe "vendi una botella de 750" (la salida
     del modelo es la GRABACION real `d49_un_solo_hecho`) y propone. Muere.
  2. `confirmar`: OTRO proceso nuevo recibe el toque del boton `vavt:<id>`.
     Debe rehidratar de `/api/bot/pendiente` y confirmar ESE id con ESE sello.
  3. `sin_rehidratar` (CONTROL): igual que 2, con `_rehidratar` apagado. Debe
     contestar "no tengo ninguna venta pendiente" y no confirmar nada.

Uso: python bot/probar_rehidratar.py  (sale 0 si pasa)
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

CARPETA = os.path.dirname(os.path.abspath(__file__))
AQUI = os.path.dirname(os.path.abspath(__file__))
CHAT = 6571822622

BORRADORES = {}
CONFIRMADOS = []
LLAMADAS = []


class ErpFalso(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        cuerpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        LLAMADAS.append(self.path)
        if self.path == "/api/bot/catalogo":
            r = {"ok": True, "productos": [{"id": "c1000000-0000-0000-0000-000000000001",
                                            "nombre": "Destilado Plata 750ml"}]}
        elif self.path == "/api/bot/venta/proponer":
            bid, sello = str(uuid.uuid4()), uuid.uuid4().hex
            from datetime import datetime, timezone
            BORRADORES[bid] = {"sello": sello, "estado": "PENDIENTE",
                               "creado_en": datetime.now(timezone.utc).isoformat()}
            r = {"ok": True, "borrador_id": bid, "sello": sello, "cuentas": [],
                 "mensaje": "VENTA 1 x 750 $599 (ERP falso)"}
        elif self.path == "/api/bot/pendiente":
            r = {"ok": True, "pendientes": [
                {"borrador_id": b, "sello": d["sello"], "tipo": "venta", "creado_en": d["creado_en"]}
                for b, d in BORRADORES.items() if d["estado"] == "PENDIENTE"]}
        elif self.path == "/api/bot/venta/confirmar":
            d = BORRADORES.get(cuerpo.get("borrador_id"))
            if d and d["sello"] == cuerpo.get("sello") and d["estado"] == "PENDIENTE":
                d["estado"] = "CONFIRMADO"
                CONFIRMADOS.append(cuerpo.get("borrador_id"))
                r = {"ok": True, "condicion_pago": "CONTADO", "total": 599}
            else:
                r = {"ok": False, "error": "sello o borrador invalido"}
        else:
            r = {"ok": False, "error": "no doblada " + self.path}
        datos = json.dumps(r).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)


BOT = r'''
import asyncio, json, os, sys
sys.path.insert(0, sys.argv[1])
import bot_gastos as B
import grabar_enrutador as G
modo, CHAT = sys.argv[2], int(sys.argv[3])
class M:
    def __init__(s):
        s.chat = type("C", (), {})(); s.chat.id = CHAT; s.chat.send_action = s.n; s.dichos = []; s.text = "vendi una botella de 750"
    async def n(s, *a, **k): return None
    async def reply_text(s, t, **k): s.dichos.append(str(t))
    async def reply_photo(s, **k): s.dichos.append("[foto]")
class Q:
    def __init__(s, data): s.data = data; s.message = M()
    async def answer(s): return None
class U:
    def __init__(s, q=None):
        s.callback_query = q; s.message = None if q else M()
    @property
    def effective_message(s): return s.callback_query.message if s.callback_query else s.message
    @property
    def effective_chat(s): return s.effective_message.chat
if modo == "proponer":
    B.enrutar = lambda *a, **k: (True, G.grabada("d49_un_solo_hecho"))
    u = U(); asyncio.run(B.manejar_texto(u, None))
    print(json.dumps({"dichos": u.message.dichos, "borrador": B._memoria.get(CHAT, {}).get("borrador_id")}))
else:
    if modo == "sin_rehidratar":
        B._rehidratar = lambda chat: 0
    u = U(Q("vavt:" + sys.argv[4])); asyncio.run(B.manejar_boton(u, None))
    print(json.dumps({"dichos": u.callback_query.message.dichos}))
'''


def bot(modo, *extra):
    entorno = dict(os.environ, BOT_ENSAYO="0", ERP_API_URL="http://127.0.0.1:%d" % PUERTO,
                   BOT_API_TOKEN="falso", BOT_LOG=os.path.join(tempfile.gettempdir(), "probar_rehidratar_%d.log" % os.getpid()))
    p = subprocess.run([sys.executable, "-c", BOT, CARPETA, modo, str(CHAT)] + list(extra),
                       capture_output=True, text=True, env=entorno, timeout=120)
    ultima = [l for l in p.stdout.splitlines() if l.startswith("{")]
    if not ultima:
        raise RuntimeError(p.stderr[-2000:])
    return json.loads(ultima[-1])


servidor = HTTPServer(("127.0.0.1", 0), ErpFalso)
PUERTO = servidor.server_address[1]
threading.Thread(target=servidor.serve_forever, daemon=True).start()

r1 = bot("proponer")
bid = r1["borrador"]
r3 = bot("sin_rehidratar", bid)   # CONTROL primero: no debe tocar el borrador
confirmados_control = list(CONFIRMADOS)
r2 = bot("confirmar", bid)
servidor.shutdown()

casos = [
    ("proceso 1 propone y deja un borrador PENDIENTE", bool(bid) and BORRADORES[bid]["estado"] != "", True),
    ("CONTROL: proceso nuevo SIN rehidratar no confirma nada", confirmados_control, []),
    ("CONTROL: ...y dice que no tiene venta pendiente",
     any("No tengo ninguna venta" in d for d in r3["dichos"]), True),
    ("proceso nuevo CON rehidratar confirma ESE borrador", CONFIRMADOS, [bid]),
    ("...y contesta 'Listo'", any(d.startswith("Listo") for d in r2["dichos"]), True),
]
ok = True
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    ok = ok and bien
    print("  [%s] %s%s" % ("PASA" if bien else "FALLA", nombre, "" if bien else "  obtuve %r" % (obtenido,)))
print("rutas:", LLAMADAS)
print("RESULTADO:", "pasa" if ok else "FALLA")
sys.exit(0 if ok else 1)
