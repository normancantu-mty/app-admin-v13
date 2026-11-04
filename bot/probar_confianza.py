# -*- coding: utf-8 -*-
"""LA GUARDA DE CONFIANZA, EJERCITADA. **D41 · D42 · D43 · D45 (Fase 6).**

─── POR QUE ESTA PRUEBA NO EXISTIA Y TENIA QUE EXISTIR ─────────────────────────

Al cerrar la Fase 5 habia 744 pruebas en verde y **ninguna tocaba la guarda de
confianza**. Por eso el defecto `D30` se pudo dar por cerrado estando abierto: el
`if` sobre `confianza` estaba escrito, una prueba de `readFileSync` encontraba su
texto, y el `if` **no se evaluaba nunca** porque los despachos de `confirmar` y
`cancelar` hacian `return` veintitres lineas antes.

*Una prueba que lee el codigo fuente no es una prueba.* `expect(fuente).toContain`
sigue pasando cuando el codigo esta detras de un `return` inalcanzable, que es
exactamente como se colo `D30`. Esta corre la tuberia real -- `manejar_texto` ->
`_enrutar_y_despachar` -> despacho -> `_post` -- y mira QUE RUTAS SE LLAMARON.

─── LAS DOS MITADES, Y LA SEGUNDA ES LA QUE DA VALOR ───────────────────────────

Por cada una de las DIEZ intenciones que escriben:

  1. con `confianza: baja`  -> **no se llama ninguna ruta de escritura**;
  2. con `confianza: alta`  -> **si se llama** (el control negativo).

Sin la segunda, un `return` puesto al principio de `_enrutar_y_despachar` pasaria
la prueba entera en verde sin despachar una sola intencion. Eso no es un caso
hipotetico: es el modo de fallo que se esta cerrando.

─── CERO ESCRITURAS A PRODUCCION, Y COMO SE GARANTIZA ──────────────────────────

`_post` esta doblado: ninguna peticion sale de este proceso. Y por si alguien
algun dia afloja el doble, el filtro `SOLO_LECTURA` de abajo es una segunda
barda: cualquier ruta que no sea de lectura se APUNTA, no se ejecuta.

El log tambien va a un archivo temporal (`BOT_LOG`, D46): sin eso, correr esta
prueba le reiniciaria el reloj al detector de cuelgue de `decidir_reinicio.py`.

Corre con:  python bot/probar_confianza.py
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# **ANTES de importar el modulo**: el `FileHandler` se instala al importar, y el
# punto entero de D46 es que esta prueba no toque `bot/bot_gastos.log`.
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_confianza.log")

import bot_gastos as B  # noqa: E402
# E2 (auditoria IA 2026-10-17): estas pruebas no son de la puerta de privado
# (esa se prueba en probar_minimo_privilegio.py); aqui el chat privado es de
# alguien dado de alta.
async def _alta_ok(update, clave):
    return True
B._puerta_de_privado = _alta_ok
import grabar_enrutador as G  # noqa: E402
import enrutador as E  # noqa: E402

CHAT = 555000111
UUID = "7c2d9e41-3b55-4a18-9f60-2e8d1c4b7a03"

# Lo que puede llamarse sin escribir nada. Todo lo demas es una escritura, y una
# escritura bajo `confianza: baja` es el defecto.
# Fase 8 (D77): `/api/bot/pendiente` solo lee (la rehidratacion tras reinicio).
SOLO_LECTURA = ("/api/bot/catalogo", "/api/bot/consulta", "/api/bot/cancelar",
                "/api/bot/pendiente", B.RUTA_LEER_CUENTAS)

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


# ═══════════════ EL ARNES ════════════════════════════════════════════════════
# Mismo molde que `probar_conversacion.py`, a proposito: dos arneses distintos
# para la misma tuberia acaban divergiendo, y entonces una prueba verde aqui no
# dice nada de la otra.

class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id, "send_action": None})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        return None

    async def reply_photo(self, *a, **kw):
        return None

    async def send_action(self, _a):
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class PostDoble(object):
    """Contesta que si a todo. **Ninguna peticion sale de este proceso.**

    Que conteste 200/ok a todo es deliberado: la prueba tiene que fallar si una
    ruta de escritura SE LLAMA, no depender de que la ruta ademas tenga exito.
    """

    def __init__(self):
        self.llamadas = []

    def __call__(self, ruta, cuerpo):
        self.llamadas.append(ruta)
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": [
                {"id": "c1000000-0000-0000-0000-000000000001",
                 "sku": "plata-750ml", "nombre": "Destilado Plata 750ml",
                 "ml_por_unidad": 750}]}
        return 200, {"ok": True, "borrador_id": UUID, "sello": "s3ll0",
                     "mensaje": "Listo.", "opciones": [], "movimientos": [],
                     "cotizaciones": [], "clientes": [], "cuentas": []}

    def escrituras(self):
        return [r for r in self.llamadas if r not in SOLO_LECTURA]


def hablar(texto, ruta_del_modelo, preparar=None):
    """Mete una frase por la tuberia real y devuelve (lo dicho, las rutas)."""
    u = UpdateDeTexto(CHAT, texto)
    doble = PostDoble()
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        return True, dict(ruta_del_modelo)

    B.enrutar, B._post = enrutar_doble, doble
    try:
        if preparar:
            preparar()
        asyncio.run(B.manejar_texto(u, None))
    finally:
        B.enrutar, B._post = enrutar_original, post_original
    return u.message.dichos, doble


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._esperando_monto.pop(CHAT, None)
    B._esperando_vigencia.pop(CHAT, None)
    B._esperando_correccion.pop(CHAT, None)


def propuesta_sellada(tipo="gasto"):
    """Una propuesta COMPLETA esperando el "va". Es la escena del defecto."""
    B._memoria[CHAT] = {"tipo": tipo, "borrador_id": UUID, "sello": "s3ll0",
                        "propuesta": {"monto": 1000.0}}


# ═══════════════ LAS DIEZ QUE ESCRIBEN ═══════════════════════════════════════
#
# El texto de cada una es el que Norman diria de verdad; los campos son los
# minimos para que el despacho llegue hasta la ruta (si faltara uno, el bot
# preguntaria y la prueba daria verde sin haber ejercitado nada -- por eso el
# control negativo de `alta` exige VER la ruta llamada).

UN_PRODUCTO = [{"producto": "750 ml", "cantidad": 2,
                "id_producto": "c1000000-0000-0000-0000-000000000001"}]

LAS_QUE_ESCRIBEN = [
    ("gasto", "pague 500 de gasolina",
     {"monto": 500, "descripcion": "gasolina"}, None),
    ("abono", "el eden me abono 1000",
     {"monto": 1000, "deudor": "Dulceria el Eden"}, None),
    ("venta", "vendi 2 de 750",
     {"productos": UN_PRODUCTO}, None),
    ("lote", "entraron 80 kilos de chile",
     {"kg_chile": 80}, None),
    ("cotizacion", "cotizale 2 de 750 a aeropuerto",
     {"productos": UN_PRODUCTO, "cliente": "Aeropuerto"}, None),
    ("anular", "anula el movimiento anterior", {}, None),
    ("corregir", "estaba mal el monto", {}, None),
    ("alta", "da de alta a Dulceria Nueva",
     {"nombre": "Dulceria Nueva"}, None),
    ("convertir", "convierte la cotizacion en venta", {}, None),
    # 2026-11-03: alta de categoria/subcategoria (propone; escribe el clic de Norman).
    ("categoria", "agrega la subcategoria Diesel en Logistica_Envios",
     {"categoria": "Logistica_Envios", "subcategoria": "Diesel"}, None),
    # `confirmar` es la que de verdad aprieta el gatillo, y la que el defecto
    # dejaba pasar: necesita una propuesta sellada en pantalla para despachar.
    # D63 (Fase 7): el texto es un "si" EXPLICITO. Con "sale pues" el bot ya
    # no escribe aunque el modelo diga `alta` -- eso lo mide la seccion D64.
    ("confirmar", "si escribelo", {}, propuesta_sellada),
]

escribieron_dudando = []
no_escribieron_seguras = []

for intencion, texto, campos, preparar in LAS_QUE_ESCRIBEN:
    # ── 1. CON DUDA: no se puede tocar ninguna ruta de escritura ────────────
    limpiar()
    _, doble = hablar(texto, dict(intencion=intencion, confianza="baja",
                                  entendido="x", campos=dict(campos),
                                  respuesta="No te entendi bien.",
                                  pregunta="Me lo dices de otra forma?"),
                      preparar=preparar)
    if doble.escrituras():
        escribieron_dudando.append((intencion, doble.escrituras()))

    # ── 2. CON CERTEZA: **tiene que llamarla** ──────────────────────────────
    #    Este es el control negativo. Sin el, un `return` al principio de
    #    `_enrutar_y_despachar` pasaria la mitad de arriba entera.
    limpiar()
    _, doble = hablar(texto, dict(intencion=intencion, confianza="alta",
                                  entendido="x", campos=dict(campos),
                                  respuesta="Va."),
                      preparar=preparar)
    if not doble.escrituras():
        no_escribieron_seguras.append((intencion, doble.llamadas))

caso("VERDE - con `confianza: baja` NINGUNA de las 10 escribe",
     escribieron_dudando, [], "")
caso("ROJO  - con `confianza: alta` las 10 SI llaman su ruta",
     no_escribieron_seguras, [], "")

# Y la comprobacion de que la lista del codigo no se volvio a quedar corta: las
# diez que esta prueba ejercita tienen que ser, exactamente, las que el modulo
# declara. Si manana alguien agrega una intencion que escribe y no la declara,
# esto se pone rojo aqui y no seis semanas despues en produccion.
caso("VERDE - `INTENCIONES_QUE_ESCRIBEN` cubre exactamente las 10 ejercitadas",
     sorted(B.INTENCIONES_QUE_ESCRIBEN),
     sorted(i for i, _, _, _ in LAS_QUE_ESCRIBEN), "")

# ── CONTROL NEGATIVO: `cancelar` con duda SI tiene que pasar ─────────────────
#    Esta a proposito fuera de la lista. Un "olvidalo" bloqueado por dudar deja
#    vivo justo lo que Norman acaba de rechazar, que es el fallo caro al reves.
limpiar()
dichos, doble = hablar("no nada olvidalo",
                       dict(intencion="cancelar", confianza="baja",
                            entendido="x", campos={}, respuesta=""),
                       preparar=propuesta_sellada)
caso("ROJO  - `cancelar` con duda SI cancela (no esta en la lista)",
     "/api/bot/cancelar" in doble.llamadas, True, str(doble.llamadas))
caso("ROJO  - ...y lo dice", dichos, ["Cancelado. No escribi nada."])

# ── CONTROL NEGATIVO: la duda NO puede matar la propuesta que esta en pantalla
#    `_recordar_a_medias` pisa `_memoria[chat]`, que es donde vive el borrador
#    sellado. Si la guarda lo llamara para `confirmar`, dudar una vez borraria
#    la propuesta que Norman tenia enfrente -- cambiariamos un defecto por otro.
limpiar()
propuesta_sellada()
hablar("sale pues", dict(intencion="confirmar", confianza="baja",
                         entendido="x", campos={}, respuesta="",
                         pregunta="Que confirmo?"))
caso("ROJO  - dudar de un `confirmar` NO borra la propuesta sellada",
     (B._memoria.get(CHAT) or {}).get("borrador_id"), UUID,
     repr(B._memoria.get(CHAT)))
limpiar()


# ═══════════════ D45 — EL DEFAULT DE CONFIANZA ES EL RESTRICTIVO ═════════════
#
# Se dobla `subprocess.run` y no `enrutar`: asi corre `enrutar` DE VERDAD --
# armado del prompt, recorte del JSON, `_normaliza`-- y lo unico falso es el
# modelo. Un modelo que no se compromete no autoriza una escritura.

class SalidaFalsa(object):
    def __init__(self, texto):
        self.returncode = 0
        self.stdout = texto
        self.stderr = ""


def enrutar_con(crudo):
    """Corre `enrutar` de verdad con esa salida cruda del modelo."""
    run_original, which_original = E.subprocess.run, E.shutil.which
    E.subprocess.run = lambda *a, **kw: SalidaFalsa(crudo)
    E.shutil.which = lambda _n: "claude"
    try:
        return E.enrutar("pague 500 de gasolina")
    finally:
        E.subprocess.run, E.shutil.which = run_original, which_original


BASE = {"intencion": "gasto", "entendido": "un gasto", "respuesta": "Va.",
        "campos": {"monto": 500, "descripcion": "gasolina"}, "faltantes": [],
        "pregunta": None}

sin_campo = dict(BASE)
ok, r = enrutar_con(json.dumps(sin_campo))
caso("VERDE - sin campo `confianza`, el enrutador devuelve 'baja'",
     (ok, r.get("confianza")), (True, "baja"), "")

con_basura = dict(BASE, confianza="segurisimo")
ok, r = enrutar_con(json.dumps(con_basura))
caso("VERDE - con basura en `confianza`, tambien 'baja'",
     (ok, r.get("confianza")), (True, "baja"), "")

con_nulo = dict(BASE, confianza=None)
ok, r = enrutar_con(json.dumps(con_nulo))
caso("VERDE - con `confianza: null`, tambien 'baja'",
     (ok, r.get("confianza")), (True, "baja"), "")

# CONTROL NEGATIVO: el que le da valor a los tres de arriba. Si `_normaliza`
# devolviera "baja" SIEMPRE, la guarda bloquearia el bot entero y los de arriba
# pasarian igual.
con_alta = dict(BASE, confianza="alta")
ok, r = enrutar_con(json.dumps(con_alta))
caso("ROJO  - con 'alta' explicito devuelve 'alta'",
     (ok, r.get("confianza")), (True, "alta"), "")

con_media = dict(BASE, confianza="media")
ok, r = enrutar_con(json.dumps(con_media))
caso("ROJO  - con 'media' explicito devuelve 'media'",
     (ok, r.get("confianza")), (True, "media"), "")

# Y el que amarra las dos mitades: el default tiene que ser un valor que la
# guarda de `bot_gastos.py` DE VERDAD bloquee. Dos constantes que se creen
# iguales y viven en archivos distintos es como se abren estos huecos.
ok, r = enrutar_con(json.dumps(sin_campo))
caso("VERDE - y ese default es, exactamente, el que la guarda bloquea",
     r.get("confianza") == "baja" and "gasto" in B.INTENCIONES_QUE_ESCRIBEN,
     True, "")

# ═══════════════ D64 (Fase 7): `confirmar` EXIGE `alta` Y UN "SI" EXPLICITO ════
#
# Con salidas REALES del modelo (grabaciones_enrutador.json, D66), no dobladas a
# mano. Con una propuesta sellada en pantalla:
# - los "si" explicitos SI llegan a la ruta (control negativo: sin esto, un
#   `return` al principio del despacho pasaria todo lo demas);
# - los ambiguos NO, y el bot vuelve a pedir el VA.

GRABADAS = G.cargar()["frases"]
explicitos = sorted(c for c in GRABADAS if c.startswith("d64_explicito_"))
ambiguos = sorted(c for c in GRABADAS if c.startswith("d64_ambiguo_"))
caso("VERDE - hay grabaciones de 5 explicitos y de al menos 5 ambiguos",
     (len(explicitos), len(ambiguos) >= 5), (5, True), "")

no_escribieron = []
for clave in explicitos:
    limpiar()
    _, doble = hablar(GRABADAS[clave]["texto"], G.grabada(clave),
                      preparar=propuesta_sellada)
    if not doble.escrituras():
        no_escribieron.append((clave, G.grabada(clave).get("confianza")))
caso("ROJO  - D64: un 'si' explicito (salida real) SI llama la ruta",
     no_escribieron, [], "")

escribieron, sin_pedir_va = [], []
for clave in ambiguos:
    limpiar()
    dichos, doble = hablar(GRABADAS[clave]["texto"], G.grabada(clave),
                           preparar=propuesta_sellada)
    if doble.escrituras():
        escribieron.append((clave, G.grabada(clave).get("confianza")))
    if G.grabada(clave).get("intencion") == "confirmar" and not any(
            "No me quedo claro" in d for d in dichos):
        sin_pedir_va.append((clave, dichos))
caso("VERDE - D64: ningun ambiguo (salida real) escribe", escribieron, [], "")
caso("VERDE - D64: el ambiguo leido como confirmar pide el VA explicito",
     sin_pedir_va, [], "")

# La SEGUNDA llave. El 2026-09-22, con el PROMPT de la regla 20 recien escrita
# (md5 90dde8f0, `matriz_despues.json` de la Fase 7), el modelo real emitio
# `confirmar` con `alta` para "va pues?" (2 de 2) y "ps va" (1 de 2). Esa salida
# EXISTIO; aqui se reproduce tal cual para medir que el codigo la para aunque
# el modelo se equivoque.
for texto in ("va pues?", "ps va"):
    limpiar()
    dichos, doble = hablar(texto, dict(intencion="confirmar", confianza="alta",
                                       entendido="confirma la propuesta",
                                       respuesta="Va.", campos={}),
                           preparar=propuesta_sellada)
    caso("VERDE - D63: %r con `alta` (salida real vista) NO escribe" % texto,
         doble.escrituras(), [], str(dichos))

# Vuelve a ensenar LA propuesta, con sus botones, si es la de ahora...
limpiar()
def _con_lo_mostrado():
    propuesta_sellada()
    B._memoria[CHAT]["mostrado"] = (UUID, "TOTAL: $599.00 (la que viste)", None)
dichos, doble = hablar("ok pues", G.grabada("d64_ambiguo_ok_pues"),
                       preparar=_con_lo_mostrado)
caso("VERDE - D63: con duda, vuelve a ensenar la propuesta que esta en pantalla",
     any("TOTAL: $599.00 (la que viste)" in d for d in dichos), True, str(dichos))
# ...y NUNCA una vieja: si el borrador cambio, no la ensena.
limpiar()
def _con_lo_mostrado_viejo():
    propuesta_sellada()
    B._memoria[CHAT]["mostrado"] = ("otro-borrador", "TOTAL: $1.00 (vieja)", None)
dichos, doble = hablar("ok pues", G.grabada("d64_ambiguo_ok_pues"),
                       preparar=_con_lo_mostrado_viejo)
caso("ROJO  - D63: una propuesta de OTRO borrador no se vuelve a ensenar",
     any("(vieja)" in d for d in dichos), False, str(dichos))
caso("ROJO  - ...y tampoco escribe", doble.escrituras(), [], "")


print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-62s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
