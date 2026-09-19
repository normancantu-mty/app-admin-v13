"""
bot_gastos.py — AG-01 Fase 1. El bot de captura de gastos del ERP.

Copia el patron de `Socio/asistente/telegram_socio.py` (long polling, candado de
instancia unica, un solo trabajador, latido). **No extiende aquel proceso**: es
otro bot, con otro token, otro publico y otro dominio.

LOS CINCO PASOS (D-E30), Y DONDE VIVE CADA UNO
----------------------------------------------
  1. Entra lenguaje natural (texto o nota de voz) ............ aqui
  2. El LLM emite UN objeto con intencion y campos ........... bot/enrutador.py
  3. Se propone una fila y se SELLA .......................... POST /api/bot/gasto/proponer
  4. La persona confirma o corrige UN CAMPO .................. aqui
  5. Se escribe el objeto exacto, verificando el sello ....... POST /api/bot/gasto/confirmar

Entre el paso 4 y el 5 **no hay ninguna llamada al modelo**, y no es cuestion de
disciplina: al confirmar solo se mandan `{telegram_id, borrador_id, sello}`. No
hay ningun campo que el modelo pudiera tocar aunque el codigo quisiera.

LA CORRECCION ES POR CAMPO, NO POR FRASE
----------------------------------------
El plan decia "corrige en lenguaje normal y se vuelve al paso 2", o sea
re-extraer todo. Dos ecosistemas coinciden en lo contrario (ver
`INVESTIGACION_previa_bot_telegram_2026-09-12.md`): el patron chino de captura
por voz edita el CAMPO, y el patron ruso AI-Gateway insiste en que el valor lo
ponga el sistema y no la pluma del modelo. Corregir la frase entera le da al
modelo licencia para cambiar campos que nadie pidio cambiar.
"""

import asyncio
import datetime as dt
import json
import logging
import os
import socket
import sys
import urllib.request
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (Application, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)
from telegram.error import NetworkError, TimedOut  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
# UNA sola llamada al modelo por mensaje, y sale de aqui. `extraer.py`,
# `extraer_abono.py` y `consultar.py` **siguen en el repo** -- nada se borra
# (regla 6) -- pero ya no los llama nadie: cada uno abre diciendolo en su
# primera linea. Mientras estuvieron cableados en paralelo con el enrutador, el
# mismo mensaje se podia leer de dos maneras distintas segun por donde entrara,
# y cual mandaba dependia del orden de unos `if`.
from enrutador import CATEGORIAS_SEMILLA, enrutar  # noqa: E402

NL = chr(10)
RAIZ = Path(__file__).resolve().parent
AUDIOS = RAIZ / "_audios"

# Mismo candado que el bot del Socio, en otro puerto: bind() en loopback es la
# primitiva mas barata de instancia unica y se libera sola cuando muere el proceso.
PUERTO_CANDADO = 47312
INTERVALO_LATIDO = 15 * 60

API = os.environ.get("ERP_API_URL", "http://localhost:3000").rstrip("/")
TOKEN_API = os.environ.get("BOT_API_TOKEN", "")
TOKEN_TG = os.environ.get("BOT_GASTOS_TELEGRAM_TOKEN", "")

class _TapaSecretos(logging.Filter):
    """Tapa el token de Telegram en CUALQUIER linea que pase por el log.

    No es hipotetico: el 2026-09-14 se conto el token **2,540 veces en claro**
    dentro de `bot_gastos.log` -- una por cada `getUpdates`, que `httpx` loguea
    con la URL completa, y la URL de Telegram LLEVA el token dentro. El archivo
    esta en `.gitignore`, asi que no se filtro a git; pero cualquiera a quien se
    le pase ese log para depurar se lleva el bot entero.

    Va como filtro y no solo callando a `httpx` porque el que calla a `httpx`
    depende de que nadie suba el nivel de vuelta. Esto tapa aunque eso pase.
    """

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if TOKEN_TG and TOKEN_TG in msg:
            record.msg = msg.replace(TOKEN_TG, "<TOKEN>")
            record.args = ()
        return True


_manejadores = [logging.FileHandler(RAIZ / "bot_gastos.log", encoding="utf-8"),
                logging.StreamHandler()]
for _m in _manejadores:
    _m.addFilter(_TapaSecretos())

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    handlers=_manejadores,
)
# `httpx` en INFO escribia una linea por sondeo: **el 81% del log era ruido**
# (2,540 de 3,136 lineas), y ese ruido es justo el que llevaba el token. En
# WARNING se siguen viendo los fallos de red, que es lo unico que ahi servia.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

log = logging.getLogger("bot_gastos")


def _post(ruta, cuerpo):
    """Llama a la app. Devuelve (status, objeto)."""
    datos = json.dumps(cuerpo).encode("utf-8")
    pet = urllib.request.Request(
        API + ruta, data=datos, method="POST",
        headers={"Content-Type": "application/json", "x-bot-token": TOKEN_API},
    )
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "error " + str(e.code)}
    except Exception as e:
        return 0, {"error": "no pude hablarle al ERP: " + str(e)}


# ===========================================================================
# EL TECLADO — la confirmacion, y la correccion por campo
# ===========================================================================

def _teclado_confirmar(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="va:" + borrador_id)],
        [InlineKeyboardButton("Cambiar categoria", callback_data="cat:" + borrador_id),
         InlineKeyboardButton("Cambiar monto", callback_data="monto:" + borrador_id)],
        [InlineKeyboardButton("Cambiar cuenta", callback_data="cta:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_movimientos(opciones):
    """La lista de lo que se puede anular. **POR INDICE, y es D2.**

    *"Un movimiento que se va a anular NO se identifica NUNCA por texto libre."*
    El enrutador tiene PROHIBIDO decir cual: dictar "anula el gasto de mil
    pesos" habiendo dos gastos de mil pesos es exactamente como se anula la fila
    equivocada, y una anulacion equivocada no se deshace -- el contrato del
    ledger tiene una sola transicion.

    El indice apunta a la lista que el servidor acaba de declarar, igual que
    `setcta`, `setdeu` y `setcomp`. El uuid no viaja en el boton: no cabe en los
    64 bytes (ya reventó una vez, el 2026-09-12) y ademas un indice contra una
    lista cerrada del servidor no se puede apuntar a una fila que no este en
    ella.
    """
    filas = [[InlineKeyboardButton(
        o["etiqueta"], callback_data="setanu:" + str(i))]
        for i, o in enumerate(opciones)]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_anulacion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, anulalo", callback_data="vaan:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_confirmar_correccion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, corrigelo", callback_data="vaan:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_campos_corregibles():
    """Que se le cambia. **Tres botones, y los tres hacen cosas distintas.**

    El concepto es una edicion de verdad (D6: es la unica columna que se edita);
    el monto y la categoria son anular-y-recapturar. Desde el celular se ven
    igual -- se pica y queda corregido -- y esa es justo la idea: la diferencia
    es del ledger, no de la persona.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("El monto", callback_data="setcorr:monto")],
        [InlineKeyboardButton("El concepto", callback_data="setcorr:desc")],
        [InlineKeyboardButton("La categoria", callback_data="setcorr:cat")],
        [InlineKeyboardButton("Mejor no", callback_data="no:x")],
    ])


def _teclado_alta(opciones):
    """Las listas cerradas del alta. **POR INDICE, igual que todo lo demas.**

    El servidor manda `{valor, etiqueta}` y aqui solo viaja el indice contra esa
    lista. El `valor` de una zona es `Zacatecas` o `Foraneo` -- texto exacto que
    va al CHECK de la base -- y mandarlo dentro del `callback_data` seria
    exponerlo a que alguien lo escriba a mano. Por indice no hay nada que
    escribir.
    """
    filas = [[InlineKeyboardButton(
        o.get("etiqueta", "?"), callback_data="setalta:" + str(i))]
        for i, o in enumerate(opciones)]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_alta(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, dalo de alta", callback_data="vaalt:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_conversion(opciones):
    """La lista de cotizaciones a convertir, y las dos preguntas que siguen.

    El mismo teclado sirve para las tres porque las tres son lo mismo: una lista
    cerrada que declaro el servidor, escogida por indice. La etiqueta lleva el
    folio, la fecha y el total -- que es lo que una persona necesita para
    reconocer cual es -- y nada de eso viaja en el dato del boton.
    """
    filas = []
    for i, o in enumerate(opciones):
        texto = o.get("etiqueta", "?")
        if o.get("detalle"):
            texto = texto + " · " + str(o["detalle"])
        filas.append([InlineKeyboardButton(texto, callback_data="setcnv:" + str(i))])
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_conversion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, hazla venta", callback_data="vacnv:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_categorias(categorias):
    """Las categorias van POR INDICE, por la misma razon que cuentas y deudores.

    Lo que habia antes era "setcat:<uuid de borrador>:<nombre>": 44 bytes fijos
    mas el nombre, contra el tope de 64 de `callback_data`. Una categoria de mas
    de 20 caracteres tumbaba el teclado entero con Button_data_invalid -- y el
    usuario no veia un error, veia que el bot no contestaba. Paso de verdad el
    2026-09-12 11:22:15 (`bot_gastos.log`, desde la linea 312).

    El uuid tampoco hacia falta: el borrador vivo es el de `_memoria[chat]`, que
    es la unica autoridad que `_reproponer` consulta. Mandarlo por el boton solo
    gastaba bytes.

    El indice apunta a la lista que ESTE teclado ofrecio, que queda guardada en
    `_memoria[chat]["categorias_ofrecidas"]`: asi el boton no puede nombrar una
    categoria que el servidor no acabe de declarar viva.
    """
    filas = [[InlineKeyboardButton(nombre, callback_data="setcat:" + str(i))]
             for i, nombre in enumerate(categorias)]
    # -1 es "ninguna". Va como indice y no como palabra para que el handler
    # tenga UN solo formato que interpretar.
    filas.append([InlineKeyboardButton("Ninguna (dejar sin categorizar)",
                                       callback_data="setcat:-1")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_abono(borrador_id):
    """El mismo VA de la Fase 1, con los campos que de verdad se corrigen aqui.

    No hay "cambiar categoria" porque un abono no tiene: lo que se equivoca es
    el DEUDOR o el MONTO. Y no hay "cambiar cuenta" del deudor porque esa la
    resuelve el servidor y es una sola (medido el 2026-09-12).
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="vaab:" + borrador_id)],
        [InlineKeyboardButton("Otro deudor", callback_data="deu:" + borrador_id),
         InlineKeyboardButton("Cambiar monto", callback_data="montoab:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_deudores(opciones):
    """Los deudores van POR INDICE, por la misma razon que las cuentas.

    `callback_data` topa en 64 bytes, y el indice solo puede apuntar a algo que
    el servidor acaba de declarar como candidato: el proceso del bot no tiene
    forma de nombrar una entidad que no este en esa lista.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + o["rol"] + ")",
        callback_data="setdeu:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_cuentas(cuentas):
    """Las cuentas van POR INDICE, no por uuid.

    Dos razones, y las dos importan. La de bulto: `callback_data` topa en 64
    bytes y "setcta:<uuid de borrador>:<uuid de cuenta>" son 80. La de fondo:
    el indice solo puede apuntar a algo que el servidor ya declaro usable en
    esta propuesta, asi que el proceso del bot no tiene forma de nombrar una
    cuenta que no este en esa lista.
    """
    filas = [[InlineKeyboardButton(c["nombre"], callback_data="setcta:" + str(i))]
             for i, c in enumerate(cuentas)]
    return InlineKeyboardMarkup(filas)



def _teclado_confirmar_venta(borrador_id):
    """El mismo VA de las Fases 1 y 2, con los campos que de verdad se corrigen
    en una venta.

    No hay "cambiar monto": **el monto de una venta no se dicta**, sale de
    `listas_precios` y de la cascada. Un boton para escribirlo a mano seria
    exactamente la puerta que la Fase 3 cierra. Lo que si se equivoca es el
    COMPRADOR (y con el, el precio, porque a un distribuidor no se le cobra
    lista) y la CUENTA donde entra el dinero.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="vavt:" + borrador_id)],
        [InlineKeyboardButton("Otro comprador", callback_data="comp:" + borrador_id),
         InlineKeyboardButton("Cambiar cuenta", callback_data="cta:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_compradores(opciones, permite_publico=False):
    """Los compradores van POR INDICE, igual que deudores, cuentas y categorias.

    `pub` no es un indice sino una palabra de tres letras porque no apunta a
    ninguna fila: "Publico en General" es la AUSENCIA de comprador, la forma
    legitima y de siempre de una venta de mostrador. Meterlo como indice -1
    habria obligado a que la lista y la ausencia se leyeran igual.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("rol") or "") + ")",
        callback_data="setcomp:" + str(i))] for i, o in enumerate(opciones)]
    if permite_publico:
        filas.append([InlineKeyboardButton("Publico en General",
                                           callback_data="setcomp:pub")])
    return InlineKeyboardMarkup(filas)


def _teclado_productos(opciones):
    """Un boton por producto, con su precio a la vista.

    El precio va en el boton a proposito: cuando el empate es ambiguo entre
    "Destilado Plata 250ml" y "Destilado Plata 50ml", los nombres se parecen y
    los precios no ($179 contra $69). Es el dato que de verdad distingue.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + "  $" + ("{:,.2f}".format(float(o.get("precio") or 0))),
        callback_data="setprod:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_lote(borrador_id):
    """El VA de un lote, con el unico campo que de verdad se corrige: el codigo.

    Aqui NO hay boton para cambiar litros, grados ni kilos. No es descuido: si
    el numero esta mal, lo que hay que hacer es dictarlo otra vez, porque un
    lote es un conjunto de mediciones y cambiar una sola desde un boton invita
    a "arreglar" la que no cuadra en vez de volver a medir. El codigo es lo
    unico que no se midio: se propuso.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="valt:" + borrador_id)],
        [InlineKeyboardButton("Otro codigo", callback_data="cod:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_insumos(opciones):
    """Un boton por insumo, con su unidad a la vista.

    La unidad va en el boton por la misma razon que el precio va en el de
    productos: es el dato que distingue. "8 de Chile Guajillo" puede ser kilos
    o piezas, y entre "Botella 750ml Vacia" (PIEZAS) y "Agua de proceso"
    (LITROS) la unidad dice mas que el nombre.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("unidad") or "") + ")",
        callback_data="setins:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_formatos(opciones):
    """Un boton por formato de botella, con sus mililitros.

    Los tres formatos se llaman casi igual ("Destilado Plata 750ml", "250ml",
    "50ml"); los mililitros son lo que los separa, y ademas son exactamente lo
    que decide el rendimiento del lote.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + "  " + str(int(float(o.get("ml") or 0))) + " ml",
        callback_data="setfmt:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_cotizacion(borrador_id):
    """El VA de una cotizacion, con los dos campos que de verdad se corrigen.

    El CLIENTE, porque decide el precio igual que en una venta: a un
    distribuidor se le cotiza su costo y a un prospecto la lista, y equivocarse
    manda por escrito un precio que despues no se puede sostener. Y la
    VIGENCIA, porque es lo unico de la cotizacion que se negocia de palabra
    ("te lo respeto un mes") y el default de 15 dias no siempre es lo dicho.

    No hay boton de precio, por la misma razon que no lo hay en la venta: el
    precio sale de `listas_precios` y de la cascada, no de la boca.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, guardala", callback_data="vact:" + borrador_id)],
        [InlineKeyboardButton("Otro cliente", callback_data="cli:" + borrador_id),
         InlineKeyboardButton("Cambiar vigencia", callback_data="vig:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_clientes(opciones, permite_prospecto=False, nombre_dicho=""):
    """Los clientes por indice, mas el boton que la venta NO tiene.

    "Es cliente nuevo" existe porque cotizar a alguien que todavia no compra es
    el caso NORMAL de una cotizacion. En una venta, un nombre fuera de la red es
    un error; aqui es un prospecto, y obligarlo a darse de alta como
    distribuidor antes de saber si va a comprar llenaria la red de nodos
    muertos.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("rol") or "") + ")",
        callback_data="setcli:" + str(i))] for i, o in enumerate(opciones)]
    if permite_prospecto and nombre_dicho:
        filas.append([InlineKeyboardButton(
            "Es cliente nuevo: " + nombre_dicho[:40], callback_data="setcli:pros")])
    return InlineKeyboardMarkup(filas)

# ===========================================================================
# EL CAMINO PRINCIPAL
# ===========================================================================

def _refrescar_catalogo(respuesta):
    """El catalogo del proceso se pone al dia con lo que dijo el servidor.

    **La base manda.** Esto existe solo para que el extractor conozca las
    categorias creadas con el uso; si se desincroniza, lo peor que pasa es que
    el modelo proponga como nueva una que ya existe, y la puerta del servidor
    la rechaza sin escribir nada.
    """
    global _catalogo
    vivas = respuesta.get("categorias")
    if isinstance(vivas, list) and vivas:
        _catalogo = list(vivas)


async def _contestar_consulta(update, chat, consulta, filtro=None):
    """Fase 3. Devuelve True si contesto una consulta.

    EL MODELO NO VE NI UN NUMERO. Clasifica la intencion, el servidor lee la
    vista y **devuelve el texto ya formateado**; aqui solo se reenvia. Por eso
    una consulta no puede contestar una cifra inventada: no hay ningun punto del
    camino donde el LLM pueda escribirla.

    **La clasificacion ya viene hecha.** Hasta el 2026-09-19 esta funcion
    llamaba otra vez al modelo (`consultar.clasificar`) para decidir de que
    consulta se trataba: una segunda opinion sobre algo que el enrutador acababa
    de decidir. Y las dos opiniones ni siquiera hablaban el mismo idioma --
    `consultar.py` conocia SEIS consultas y el servidor contesta TRES
    (`lib/bot-consultas.ts`), asi que las otras tres viajaban hasta el endpoint
    nada mas para que las rechazara. Ahora la lista cerrada vive en un solo
    lugar (`CONSULTAS_QUE_CONTESTA`) y aqui llega ya normalizada.
    """
    if not consulta or consulta == "otra":
        return False

    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat,
        "consulta": consulta,
        "filtro": filtro,
    })
    # Se registra QUE se consulto y COMO salio, nunca la respuesta: el log ya
    # lleva el token del bot en cada linea de la libreria y no se le agregan
    # cifras del negocio. Sin esta linea, un uso real del bot no dejaba rastro
    # del lado de la maquina y no habia con que comprobarlo despues.
    log.info("consulta por voz/texto: %s filtro=%s -> %s", consulta, filtro, estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude consultarlo."))
        return True

    await update.effective_message.reply_text(r["texto"])
    return True


async def _proponer_abono(update, chat, propuesta, id_deudor=None, nombre=None):
    """Fase 2. Devuelve True si propuso un abono (o si pidio elegir deudor).

    EL MODELO NO ELIGE A NADIE: el enrutador devuelve un NOMBRE y el servidor lo
    empata contra la cartera viva. Si hay mas de un candidato, o ninguno, vuelve
    con `hay_que_elegir` y lo resuelve un boton. Escribir dinero en la entidad
    equivocada no se corrige solo: hay que anular la fila y recapturar.

    **La propuesta SIEMPRE llega armada.** Antes esta funcion tenia dentro su
    propio extractor (`extraer_abono`), o sea una segunda lectura del mismo
    mensaje que el enrutador ya habia leido. El nombre del deudor que valia
    dependia de cual de las dos lecturas hubiera corrido, y eso en una funcion
    que mueve dinero de la cartera de alguien.
    """
    # El nombre llega por parametro. Si no hay, es porque el deudor ya quedo
    # resuelto por uuid (un boton) y el nombre ya no pinta nada.
    nombre_dicho = nombre

    cuerpo = {"telegram_id": chat, "propuesta": propuesta}
    if id_deudor:
        cuerpo["id_deudor"] = id_deudor
    else:
        cuerpo["deudor"] = nombre_dicho

    estado, r = _post("/api/bot/abono/proponer", cuerpo)
    _refrescar_deudores(r)
    log.info("abono propuesto: deudor=%s monto=%s -> %s",
             nombre_dicho or id_deudor, propuesta.get("monto"), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        _memoria[chat] = {"tipo": "abono_eligiendo",
                          "opciones": r.get("opciones", list(_deudores)),
                          "propuesta": propuesta}
        await update.effective_message.reply_text(
            r.get("mensaje", "Quien te pago?"),
            reply_markup=_teclado_deudores(r.get("opciones", [])))
        return True

    if estado != 200 or not r.get("ok"):
        # 422 y 403 SI se dicen: llegamos aqui porque el extractor lo leyo como
        # abono, asi que callarse dejaria a la persona sin saber por que no paso
        # nada. Solo un "no es un abono" (arriba) sigue de largo a la consulta.
        await update.effective_message.reply_text(r.get("error", "No pude proponer el abono."))
        return True

    _memoria[chat] = {
        "tipo": "abono",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "id_deudor": r.get("id_deudor"),
        "propuesta": propuesta,
        # La lista completa viaja con el borrador para que "Otro deudor" no
        # tenga que volver a preguntarle al servidor.
        "opciones": r.get("opciones", list(_deudores)),
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_abono(r["borrador_id"]))
    return True


def _refrescar_deudores(respuesta):
    """La cartera viva que reporto el servidor, para dos usos.

    Vocabulario para el extractor (solo los NOMBRES) y la lista de "otro
    deudor". **La base manda**: el servidor vuelve a empatar contra su propia
    lista en cada peticion, asi que esto no es autoridad, es comodidad.
    """
    global _deudores
    vivos = respuesta.get("opciones")
    if isinstance(vivos, list) and vivos:
        _deudores = list(vivos)


def _nombres_deudores():
    return [d.get("nombre") for d in _deudores if isinstance(d, dict) and d.get("nombre")]


def _propuesta_de_abono(campos):
    """Los campos del enrutador, en la forma que espera `/api/bot/abono/proponer`.

    El deudor NO va aqui: viaja aparte porque el servidor lo empata contra la
    cartera viva y puede contestar con botones. Meterlo en la propuesta lo
    volveria un dato mas, y es el que decide a quien se le acredita el dinero.
    """
    campos = campos or {}
    return {
        "monto": campos.get("monto"),
        "metodo_pago": campos.get("metodo_pago"),
        "nota": campos.get("nota") or campos.get("descripcion"),
        "fecha": campos.get("fecha"),
    }


def _tomar_borrador_a_medias(chat):
    """Saca de `_memoria` los campos de una captura que quedo incompleta.

    **Se CONSUME al leerlo.** Vive exactamente una vuelta: si el mensaje nuevo
    tampoco alcanza, el camino que corresponda lo vuelve a guardar, ya fundido
    con lo que se acabe de entender. Dejarlo pegado seria peor que no tenerlo --
    un "500 de gasolina" que quedo a medias el lunes contaminaria la primera
    frase del martes, y el sintoma seria un monto que aparece solo.
    """
    dato = _memoria.get(chat)
    if not isinstance(dato, dict) or dato.get("estado") != "incompleto":
        return None
    _memoria.pop(chat, None)
    campos = dato.get("campos")
    return dict(campos) if isinstance(campos, dict) and campos else None


def _recordar_a_medias(chat, intencion, campos):
    """Lo que si se entendio, esperando la pieza que falta. **Sin sello.**

    Un borrador sellado significa "esto es exactamente lo que se va a escribir".
    Este no lleva sello y no puede llevarlo: todavia le falta un campo, asi que
    no hay nada que sellar. Esa ausencia es la que impide que `_confirmar` lo
    tome por bueno si alguien contesta "va" antes de tiempo.
    """
    _memoria[chat] = {
        "estado": "incompleto",
        "intencion": intencion,
        "campos": dict(campos or {}),
    }


# ===========================================================================
# AQUI VIVIA `_proponer()`, LA CASCADA VIEJA. 2026-09-19.
# ===========================================================================
#
# Era el camino de siempre: llamar a `extraer`, y si decia "esto no parece un
# gasto", intentar abono, y si tampoco, intentar consulta. Tres llamadas al
# modelo en fila para contestar una pregunta, y un mensaje de ayuda fijo para
# todo lo que no cayera en esas tres cajas.
#
# Se quedo de red de seguridad cuando entro el enrutador, y esa fue la decision
# equivocada. Una red que lee el mismo mensaje con OTRO prompt no es una red: es
# una segunda opinion que puede diferir de la primera, y que se activa
# precisamente cuando algo ya salio raro. El gasto que el enrutador entendio de
# una forma y la cascada de otra se escribe distinto segun cual corriera, y
# desde afuera las dos cosas se ven igual.
#
# **La red de verdad son los comandos**: `/stock`, `/cartera`, `/ventas` y
# `/abono` no pasan por ningun modelo, asi que siguen funcionando aunque el
# modelo este caido. Y si se cae con un gasto en la mano, lo que toca es
# decirlo, no adivinarlo con otro prompt.
#
# `bot/extraer.py`, `bot/extraer_abono.py` y `bot/consultar.py` siguen en el
# repo sin llamador (regla 6: nada se borra).
# ===========================================================================


# Lo unico que el bot guarda en memoria: el ultimo borrador por chat, para poder
# mandar el sello al confirmar. **El payload NO vive aqui** — vive en la base, y
# por eso este proceso no puede alterarlo aunque tuviera un bug.
_memoria = {}
# AQUI VIVIA `_pendiente`, y lo sustituye el borrador a medias de `_memoria`.
# Guardaba el TEXTO literal de la vuelta anterior y lo pegaba con un ". " al de
# la siguiente, para que el modelo volviera a leer las dos frases juntas. O sea
# que cada vuelta re-extraia todo desde cero y podia cambiar de opinion sobre un
# campo que nadie habia vuelto a mencionar: contestar "de gasolina" despues de
# "gaste 340" podia acabar en un monto distinto, porque el modelo leia una frase
# nueva y no un hueco que llenar. Ahora lo que sobrevive entre vueltas son los
# CAMPOS ya extraidos (`estado='incompleto'`, y **sin sello**, que es lo que los
# distingue de un borrador de verdad), y el mensaje nuevo solo los completa.
_esperando_monto = {}
# Igual que `_esperando_monto`, pero para el codigo de un lote: el boton
# "Otro codigo" abre la captura y el siguiente texto ES el codigo, sin pasar
# por el modelo.
_esperando_codigo = {}
# Igual, pero para la vigencia de una cotizacion: el boton "Cambiar
# vigencia" abre la captura y el siguiente texto ES el numero de dias.
_esperando_vigencia = {}
# Fase 5. Que campo se esta corrigiendo de un movimiento ya escrito: "monto" o
# "desc". El siguiente texto ES el valor nuevo y **no pasa por el modelo**, por
# la misma razon que `_esperando_monto`: re-extraer la frase entera le daria al
# modelo licencia para cambiar campos que nadie toco -- y aqui lo que se toca es
# una fila que ya existe.
_esperando_correccion = {}
# Fase 5, Paso 5. Que dato del alta se esta esperando por texto: "nombre",
# "email" o el nombre de una columna de comision. El siguiente mensaje ES ese
# dato y **no pasa por el modelo**: volver a extraer la frase entera le daria
# licencia para cambiar la zona o el rol que ya se escogieron con boton, que son
# justo los dos que D9 saco del lenguaje natural a proposito.
_esperando_alta = {}
# Las categorias que el servidor reporto en la ultima propuesta. Arranca con las
# del diccionario local y se actualiza sola: **la autoridad es la base**, esto
# es solo para que el extractor tenga el vocabulario completo la proxima vez.
_catalogo = list(CATEGORIAS_SEMILLA)
# Los nombres de la cartera viva (Fase 2). Arranca VACIO a proposito: no hay
# una lista local de deudores que pudiera caducar. Hasta la primera respuesta
# del servidor, el extractor trabaja sin vocabulario y el servidor empata igual.
_deudores = []


async def _responder_natural(update, ruta):
    """Contesta hablando cuando no hay nada que escribir todavia.

    Este es el reemplazo del mensaje de ayuda fijo que Norman llamo "muy
    cuadrado". La diferencia no es el tono: es que aqui el bot DICE QUE
    ENTENDIO. Un bot que contesta "no te entendi" cuando si entendio la mitad
    entrena a la gente a no volver a intentarlo.
    """
    intencion = ruta.get("intencion")
    entendido = ruta.get("entendido") or ""

    if intencion == "venta":
        # Desde la Fase 3 las ventas SI se guardan: aqui solo se llega si el
        # camino de la venta no logro proponer nada. Decirle "esa va por el POS"
        # seria mentirle sobre lo que el bot sabe hacer.
        aviso = ("Entendido: " + entendido + ". Dimela otra vez diciendo que producto "
                 "y cuantas piezas.")
    elif intencion == "lote":
        # Desde la Fase 3.3 los lotes SI se guardan. Aqui solo se llega si el
        # camino del lote no logro proponer nada.
        aviso = ("Entendido: " + entendido + ". Dimelo otra vez diciendo cuanto chile entro y cuantos litros y grados salieron.")
    elif intencion == "cotizacion":
        # Desde la Fase 4 las cotizaciones SI se guardan. Aqui solo se llega si
        # el camino de la cotizacion no logro proponer nada.
        aviso = ("Entendido: " + entendido + ". Dimela otra vez diciendo que producto "
                 "y cuantas piezas.")
    elif intencion == "reporte":
        aviso = "Todavia no tengo el reporte del dia. Por ahora: /ventas, /stock o /cartera."
    elif intencion == "consulta":
        aviso = ("Entendido: " + entendido + ". Eso todavia no lo se consultar. "
                 "Hoy puedo: stock, cartera y ventas.")
    else:
        aviso = entendido if entendido else "No te entendi. Dime que hiciste o que quieres saber."

    await update.effective_message.reply_text(aviso)


def _propuesta_de_gasto(campos, catalogo):
    """Traduce los campos del enrutador al objeto que espera el servidor.

    La unica decision real es categoria contra categoria_nueva: si el nombre ya
    existe en el catalogo va como existente, y si no, como nueva. Se decide
    aqui y no en el prompt porque el catalogo es un hecho y no una opinion, y
    porque el servidor rechaza una "nueva" que ya existia.
    """
    categoria = campos.get("categoria")
    nombre = str(categoria).strip() if categoria else ""
    existente = None
    for c in catalogo:
        if str(c).strip().lower() == nombre.lower():
            existente = c
            break
    return {
        "monto": campos.get("monto"),
        "categoria": existente,
        "categoria_nueva": None if (existente or not nombre) else nombre,
        "descripcion": campos.get("descripcion"),
        "fecha": campos.get("fecha"),
    }


async def _proponer_gasto_directo(update, chat, propuesta):
    """Propone un gasto cuyos campos ya vienen resueltos por el enrutador.

    Es el mismo destino que `_proponer` -- la puerta sellada del servidor --
    pero sin volver a llamar al modelo, porque el enrutador ya leyo el mensaje.
    Ahorrar esa llamada es lo que hace que el bot conteste rapido, y la
    velocidad es parte de lo que Norman pidio: "Telegram tiene que ser lo mas
    conciso posible".
    """
    estado, r = _post("/api/bot/gasto/proponer", {
        "telegram_id": chat,
        "propuesta": propuesta,
    })
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponerlo."))
        return False

    _memoria[chat] = {
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "cuentas": r.get("cuentas", []),
        "id_cuenta": r.get("id_cuenta"),
        "categorias": r.get("categorias", list(_catalogo)),
        "propuesta": dict(propuesta),
    }
    _refrescar_catalogo(r)
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))
    return True




# ===========================================================================
# FASE 3 — LA VENTA. El bot CAPTURA; el ERP cobra.
# ===========================================================================

def _bajar(ruta):
    """Baja un archivo de la app con el token del bot. Devuelve bytes o None.

    **La imagen del comprobante no se puede mandar como URL.** `sendPhoto` con
    una URL hace que los servidores de Telegram vayan a pedirla, y ellos no
    llevan el `x-bot-token`: recibirian un 401. Asi que el proceso la baja aqui
    y la sube como archivo. De paso, el comprobante nunca queda accesible desde
    fuera de esta maquina.
    """
    pet = urllib.request.Request(API + ruta, headers={"x-bot-token": TOKEN_API})
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            return r.read()
    except Exception as e:
        log.warning("no pude bajar %s: %s", ruta, e)
        return None


def _renglones_de(campos):
    """Los renglones que dijo el enrutador, en la forma que espera la ruta.

    El enrutador devuelve `productos` como lista de `{producto, cantidad}`. Se
    acepta tambien la forma suelta (`producto` + `cantidad`) porque un mensaje
    de un solo renglon a veces sale asi. **La cantidad que falta es 1**: "vendi
    una plata de 750" y "vendi plata de 750" son la misma frase, y suponer 1 es
    el unico numero que no puede sorprender a nadie — se ensena antes del "va".
    """
    crudos = campos.get("productos")
    if not isinstance(crudos, list) or not crudos:
        if campos.get("producto"):
            crudos = [{"producto": campos.get("producto"),
                       "cantidad": campos.get("cantidad")}]
        else:
            return []
    renglones = []
    for c in crudos:
        if not isinstance(c, dict):
            # Una lista de puros nombres tambien se entiende.
            renglones.append({"producto": str(c), "cantidad": 1})
            continue
        cantidad = c.get("cantidad")
        try:
            cantidad = int(float(cantidad))
        except (TypeError, ValueError):
            cantidad = 1
        if cantidad <= 0:
            cantidad = 1
        renglones.append({"producto": c.get("producto") or c.get("nombre"),
                          "cantidad": cantidad})
    return [r for r in renglones if r["producto"]]


async def _proponer_venta(update, chat, peticion):
    """Manda la peticion a `/api/bot/venta/proponer` y ensena lo que salga.

    Devuelve True si atendio la venta (haya propuesto o haya preguntado).

    **La peticion completa se guarda en memoria.** Cuando un producto o el
    comprador salen ambiguos, el boton no manda un dato suelto: parcha ESTA
    peticion y se vuelve a proponer entera. Asi una venta de tres renglones con
    dos ambiguos se resuelve en dos botones, sin volver a dictarla y sin que el
    modelo vuelva a tocar nada.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/venta/proponer", peticion)
    log.info("venta propuesta: %s renglones -> %s",
             len(peticion.get("productos") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "venta_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
            "permite_publico": bool(r.get("permite_publico")),
        }
        if campo == "producto":
            teclado = _teclado_productos(opciones)
        else:
            teclado = _teclado_compradores(opciones, bool(r.get("permite_publico")))
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=teclado)
        return True

    if estado != 200 or not r.get("ok"):
        # 422 y 403 SI se dicen: llegamos aqui porque el enrutador lo leyo como
        # venta, y callarse dejaria a la persona sin saber por que no paso nada.
        await update.effective_message.reply_text(r.get("error", "No pude proponer la venta."))
        return True

    _memoria[chat] = {
        "tipo": "venta",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        "cuentas": r.get("cuentas", []),
        "id_cuenta": r.get("id_cuenta"),
        # La lista completa viaja con el borrador para que "Otro comprador" no
        # tenga que volver a preguntarle al servidor.
        "compradores": r.get("opciones") or [],
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_venta(r["borrador_id"]))
    return True


async def _confirmar_venta(update, chat):
    """El "va" de una venta. Aqui tampoco hay LLM, y no puede haberlo: solo
    viajan `{telegram_id, borrador_id, sello}`. Ninguna fila."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "venta":
        await update.effective_message.reply_text("No tengo ninguna venta pendiente que escribir.")
        return
    estado, r = _post("/api/bot/venta/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("venta confirmada: borrador=%s -> %s ticket=%s",
             dato["borrador_id"], estado, r.get("ticket_id"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude escribir la venta."))
        return

    _memoria.pop(chat, None)
    if r.get("condicion_pago") == "CONCESION":
        aviso = "Listo. Quedo a deber " + "{:,.2f}".format(float(r.get("total") or 0)) + "."
    else:
        aviso = "Listo. Quedo escrita."
    await update.effective_message.reply_text(aviso)

    # ── FASE 1b: el comprobante llega solo ──────────────────────────────────
    # Va DESPUES del aviso y sin condicionarlo: la venta ya esta escrita, asi
    # que si la imagen falla no se puede deshacer nada y callarse la escritura
    # seria peor que quedarse sin foto. Por eso el fallo se dice aparte.
    ruta = r.get("ruta_imagen")
    if not ruta:
        return
    imagen = await asyncio.to_thread(_bajar, ruta)
    if not imagen:
        await update.effective_message.reply_text(
            "La venta quedo escrita; el comprobante no lo pude generar.")
        return
    try:
        await update.effective_message.reply_photo(
            photo=imagen, filename="ticket.png")
    except Exception as e:
        log.warning("no pude mandar el comprobante: %s", e)
        await update.effective_message.reply_text(
            "La venta quedo escrita; el comprobante no se pudo enviar.")



def _peticion_de_lote(campos):
    """Traduce los campos del enrutador a lo que espera `/api/bot/lote/proponer`.

    El enrutador devuelve `kg_chile` como campo suelto porque asi se dicta
    ("meti ocho kilos de chile"), pero la ruta trabaja contra el catalogo, asi
    que se convierte en un renglon de insumo como cualquier otro. Si el modelo
    ya puso el chile en `insumos`, el suelto NO se agrega: el servidor suma los
    repetidos —porque `lote_entradas` no deja dos filas del mismo insumo— y
    sumarlo aqui duplicaria los kilos sin que nadie lo pidiera.

    `botellas` sale sin formato a proposito. No se completa con 750 porque sea
    el mas comun: el formato decide cuantos mililitros salieron del lote, y la
    ruta pregunta cual es.
    """
    insumos = []
    crudos = campos.get("insumos")
    if isinstance(crudos, list):
        for c in crudos:
            if not isinstance(c, dict):
                continue
            nombre = c.get("insumo") or c.get("nombre")
            if nombre:
                insumos.append({"insumo": nombre, "cantidad": c.get("cantidad")})

    kg = campos.get("kg_chile")
    ya_hay_chile = any("chile" in str(i.get("insumo")).lower() for i in insumos)
    if kg not in (None, "", 0) and not ya_hay_chile:
        insumos.append({"insumo": "chile-guajillo", "cantidad": kg})

    tandas = []
    for t in (campos.get("tandas") or []):
        if isinstance(t, dict) and t.get("litros") not in (None, ""):
            tandas.append({"litros": t.get("litros"), "grado": t.get("grado")})

    envasado = []
    botellas = campos.get("botellas")
    if botellas not in (None, "", 0):
        linea = {"botellas": botellas}
        if campos.get("formato"):
            linea["formato"] = campos.get("formato")
        envasado.append(linea)

    propuesta = {"tandas": tandas}
    for campo in ("codigo_lote", "dias_fermentacion", "horas_fermentacion", "fecha_inicio"):
        if campos.get(campo) not in (None, ""):
            propuesta[campo] = campos.get(campo)

    return {"insumos": insumos, "envasado": envasado, "propuesta": propuesta}


async def _proponer_lote(update, chat, peticion):
    """Manda la peticion a `/api/bot/lote/proponer` y ensena lo que salga.

    Devuelve True si atendio el lote (haya propuesto o haya preguntado).

    Igual que en la venta, **la peticion completa se guarda en memoria**: los
    botones parchan ESTA peticion y se vuelve a proponer entera, sin que el
    modelo vuelva a tocar nada. Un lote con dos insumos ambiguos se resuelve en
    dos botones sin volver a dictarlo.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/lote/proponer", peticion)
    log.info("lote propuesto: %s insumos, %s envasado -> %s",
             len(peticion.get("insumos") or []),
             len(peticion.get("envasado") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "lote_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
        }
        teclado = _teclado_insumos(opciones) if campo == "insumo" else _teclado_formatos(opciones)
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=teclado)
        return True

    if estado != 200 or not r.get("ok"):
        # El 403 de "esto es de la matriz" y el 422 de un grado imposible SI se
        # dicen: llegamos aqui porque el enrutador lo leyo como lote, y callarse
        # dejaria a la persona creyendo que se guardo.
        await update.effective_message.reply_text(r.get("error", "No pude proponer el lote."))
        return True

    _memoria[chat] = {
        "tipo": "lote",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        "codigo_lote": r.get("codigo_lote"),
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_lote(r["borrador_id"]))
    return True


async def _confirmar_lote(update, chat):
    """El "va" de un lote. Viajan `{telegram_id, borrador_id, sello}` y nada mas.

    El resumen que se manda despues NO lo arma este archivo: viene en `mensaje`,
    y la ruta lo saco de `v_lote_rendimiento` DESPUES de escribir. Es la misma
    fila que Norman va a ver en la pantalla, no una copia calculada aparte
    (D-198).
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "lote":
        await update.effective_message.reply_text("No tengo ningun lote pendiente que escribir.")
        return

    estado, r = _post("/api/bot/lote/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("lote confirmado: borrador=%s -> %s id=%s",
             dato["borrador_id"], estado, r.get("id_lote"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude escribir el lote."))
        return

    _memoria.pop(chat, None)
    aviso = "Listo. Quedo el lote " + str(r.get("codigo_lote") or "") + "."
    resumen = r.get("mensaje")
    if resumen:
        aviso = aviso + "\n\n" + resumen
    await update.effective_message.reply_text(aviso)

# ===========================================================================
# FASE 4 - LA COTIZACION. Un precio por escrito que todavia no es una venta.
# ===========================================================================

def _peticion_de_cotizacion(campos):
    """Traduce los campos del enrutador a lo que espera `/api/bot/cotizacion/proponer`.

    Los renglones se leen con `_renglones_de`, el mismo de la venta: una
    cotizacion y una venta dicen los productos exactamente igual, y dos lectores
    distintos del mismo "dos de 750" acabarian entendiendo cosas distintas.
    """
    peticion = {"productos": _renglones_de(campos), "propuesta": {}}
    cliente = campos.get("cliente") or campos.get("comprador")
    if cliente:
        peticion["cliente"] = cliente
    if campos.get("vigencia_dias") not in (None, ""):
        peticion["propuesta"]["vigencia_dias"] = campos.get("vigencia_dias")
    if campos.get("notas"):
        peticion["propuesta"]["notas"] = campos.get("notas")
    return peticion


async def _proponer_cotizacion(update, chat, peticion):
    """Manda la peticion a `/api/bot/cotizacion/proponer` y ensena lo que salga.

    Devuelve True si atendio la cotizacion (haya propuesto o haya preguntado).
    Mismo patron que la venta y el lote: la peticion completa se guarda y los
    botones la parchan.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/cotizacion/proponer", peticion)
    log.info("cotizacion propuesta: %s renglones -> %s",
             len(peticion.get("productos") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "cotizacion_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
            "permite_prospecto": bool(r.get("permite_prospecto")),
            "nombre_dicho": r.get("nombre_dicho") or "",
        }
        if campo == "producto":
            teclado = _teclado_productos(opciones)
        else:
            teclado = _teclado_clientes(opciones, bool(r.get("permite_prospecto")),
                                        r.get("nombre_dicho") or "")
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=teclado)
        return True

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude armar la cotizacion."))
        return True

    _memoria[chat] = {
        "tipo": "cotizacion",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        "para_quien": r.get("para_quien"),
        # La lista completa viaja con el borrador para que "Otro cliente" no
        # tenga que volver a preguntarle al servidor.
        "clientes": r.get("clientes") or [],
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_cotizacion(r["borrador_id"]))
    return True


async def _confirmar_cotizacion(update, chat):
    """El "va" de una cotizacion. Viajan `{telegram_id, borrador_id, sello}`.

    Igual que la venta, el documento llega solo despues (Fase 1b). Y por la
    misma razon se manda DESPUES del aviso y sin condicionarlo: la cotizacion ya
    quedo guardada, asi que un fallo de la imagen no se puede deshacer y
    callarse la escritura seria peor que quedarse sin foto.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "cotizacion":
        await update.effective_message.reply_text(
            "No tengo ninguna cotizacion pendiente que guardar.")
        return

    estado, r = _post("/api/bot/cotizacion/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("cotizacion confirmada: borrador=%s -> %s folio=%s",
             dato["borrador_id"], estado, r.get("folio"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude guardar la cotizacion."))
        return

    _memoria.pop(chat, None)
    await update.effective_message.reply_text(r.get("mensaje", "Listo."))

    ruta = r.get("ruta_imagen")
    if not ruta:
        return
    imagen = await asyncio.to_thread(_bajar, ruta)
    if not imagen:
        await update.effective_message.reply_text(
            "La cotizacion quedo guardada; el documento no lo pude generar.")
        return
    try:
        await update.effective_message.reply_photo(
            photo=imagen, filename="cotizacion.png")
    except Exception as e:
        log.warning("no pude mandar la cotizacion: %s", e)
        await update.effective_message.reply_text(
            "La cotizacion quedo guardada; el documento no se pudo enviar.")


def _recaptura_con(valores, campo, nuevo):
    """La fila corregida: la de siempre con UN campo cambiado.

    **La fecha se conserva**, y es la parte que importa. Una correccion que
    reescribe la fila con la fecha de HOY mueve el gasto de mes -- y de paso se
    regala ventana de edicion, porque la ventana se cuenta desde
    `fecha_movimiento`. Por eso `mensajeDeRecaptura` la ensena antes del "va":
    para que se pueda cazar ahi y no en el corte.
    """
    valores = valores or {}
    propuesta = {
        "monto": valores.get("monto"),
        "categoria": valores.get("categoria"),
        "descripcion": valores.get("descripcion"),
        "fecha": (valores.get("fecha") or "")[:10] or None,
    }
    propuesta[campo] = nuevo
    return propuesta


async def _proponer_correccion_de_campo(update, chat, campo, nuevo):
    """Despacha la correccion de UN campo por el camino que le toca.

    El concepto es la unica columna que se EDITA de verdad (D6), y encima tiene
    que volver a pasar por el filtro fiscal en el servidor porque
    `v_pasivo_fiscal` lee ese texto. El monto y la categoria no se editan: se
    anula la fila y se escribe otra, en un solo "va".
    """
    dato = _memoria.get(chat) or {}
    elegido = dato.get("elegido") or {}
    if not elegido:
        await update.effective_message.reply_text(
            "Ya no tengo ese movimiento. Dime otra vez que quieres corregir.")
        return
    cuerpo = {
        "telegram_id": chat,
        "tabla": elegido.get("tabla"),
        "id_movimiento": elegido.get("id"),
    }
    if campo == "descripcion":
        cuerpo["modo"] = "editar_descripcion"
        cuerpo["descripcion_nueva"] = nuevo
    else:
        cuerpo["modo"] = "recapturar"
        cuerpo["recaptura"] = _recaptura_con(elegido.get("valores"), campo, nuevo)
    await _proponer_anulacion(update, chat, cuerpo, accion="corregir")


async def _proponer_alta(update, chat, cuerpo):
    """Paso 5. El alta de un distribuidor o un local, una pregunta a la vez.

    Este endpoint contesta VARIAS veces antes de dar un borrador, y cada
    respuesta resuelve UN hueco. Hay tres formas de respuesta y se distinguen
    solas:

      · `hay_que_elegir` con `opciones` .. lista cerrada -> botones.
      · `campo` sin `opciones` .......... hace falta un texto -> se pregunta y
                                          el siguiente mensaje ES la respuesta.
      · `borrador_id` ................... ya esta todo -> se ensena y se sella.

    El cuerpo se acumula en `_memoria[chat]["peticion"]` y se vuelve a mandar
    entero en cada vuelta. No se guarda a medias en el servidor: mientras no
    haya borrador, no hay nada escrito en ningun lado.
    """
    estado, r = _post("/api/bot/entidad/proponer", cuerpo)
    log.info("alta propuesta: campo=%s -> %s", r.get("campo"), estado)

    if estado != 200:
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No cree nada."))
        return True

    # --- Hace falta escoger de una lista cerrada ---------------------------
    if r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No hay de donde escoger."))
            return True
        _memoria[chat] = {"tipo": "alta_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_teclado_alta(opciones))
        return True

    # --- Hace falta un texto ----------------------------------------------
    if r.get("campo") and not r.get("borrador_id"):
        _memoria[chat] = {"tipo": "alta_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": []}
        _esperando_alta[chat] = r.get("campo")
        await update.effective_message.reply_text(r.get("mensaje", "Que dato falta?"))
        return True

    if not r.get("ok") or not r.get("borrador_id"):
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No cree nada."))
        return True

    _memoria[chat] = {"tipo": "alta",
                      "borrador_id": r["borrador_id"],
                      "sello": r["sello"],
                      "peticion": dict(cuerpo)}
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_alta(r["borrador_id"]))
    return True


async def _confirmar_alta(update, chat):
    """El "va" del alta. Viajan `{telegram_id, borrador_id, sello}` y nada mas.

    La contrasena viene en la RESPUESTA, no en el borrador: se genera al crear
    la cuenta y se ensena una vez. Por eso este mensaje no se puede volver a
    pedir -- y por eso se manda tal cual lo mando el servidor, sin recortarlo.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "alta":
        await update.effective_message.reply_text("No tengo ninguna alta pendiente.")
        return
    estado, r = _post("/api/bot/entidad/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("alta confirmada: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        _esperando_alta.pop(chat, None)
        await update.effective_message.reply_text(r.get("mensaje", "Listo, quedo dado de alta."))
    else:
        await update.effective_message.reply_text(r.get("error", "No pude darlo de alta."))


async def _proponer_conversion(update, chat, cuerpo):
    """Paso 6. Volver venta una cotizacion que ya existe.

    Misma mecanica que el alta: el endpoint pregunta lo que la cotizacion no
    sabe -- cual es, de contado o a consignacion, y a que cuenta entra -- y cada
    respuesta se acumula en el cuerpo.
    """
    estado, r = _post("/api/bot/convertir/proponer", cuerpo)
    log.info("conversion propuesta: campo=%s -> %s", r.get("campo"), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No hay de donde escoger."))
            return True
        _memoria[chat] = {"tipo": "conversion_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_teclado_conversion(opciones))
        return True

    if estado != 200 or not r.get("ok"):
        mensaje = r.get("error", "No pude prepararlo. No escribi nada.")
        # Fuera de los 7 dias la cotizacion puede seguir siendo buena para el
        # cliente: lo que caduco es cerrarla a ciegas. Se dice la salida en vez
        # de dejar a la persona en un callejon.
        if r.get("ofrecer_recotizar"):
            mensaje = mensaje + NL + NL + 'Si quieres te la recotizo con los precios de hoy: dime "cotizale otra vez".'
        await update.effective_message.reply_text(mensaje)
        return True

    _memoria[chat] = {"tipo": "conversion",
                      "borrador_id": r["borrador_id"],
                      "sello": r["sello"],
                      "folio": r.get("folio"),
                      "peticion": dict(cuerpo)}
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_conversion(r["borrador_id"]))
    return True


async def _confirmar_conversion(update, chat):
    """El "va" de una conversion. Escribe la venta Y marca la cotizacion."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "conversion":
        await update.effective_message.reply_text("No tengo ninguna cotizacion pendiente de cerrar.")
        return
    estado, r = _post("/api/bot/convertir/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("conversion confirmada: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        await update.effective_message.reply_text(r.get("mensaje", "Listo, quedo vendida."))
    else:
        await update.effective_message.reply_text(r.get("error", "No pude convertirla."))


async def _proponer_anulacion(update, chat, cuerpo, accion="anular"):
    """Fase 5. La lista, o la propuesta sellada de lo que se va a tocar.

    Devuelve True si contesto algo. `accion` es lo que Norman pidio -- anular o
    corregir -- y solo sirve para saber que preguntar despues de que escoja la
    fila; lo que de verdad se va a hacer lo decide el `modo` que viaja al
    servidor y queda dentro del sello.
    """
    # `accion` viaja SOLO para que el servidor escoja el verbo de la pregunta:
    # con /corregir la lista decia "Cual anulo?", que es justo la palabra que
    # nadie quiere leer cuando lo que pidio fue arreglar un concepto. Lo que de
    # verdad se escribe lo decide `modo`, que va dentro del sello.
    cuerpo = dict(cuerpo)
    cuerpo["accion"] = accion
    estado, r = _post("/api/bot/anular/proponer", cuerpo)
    log.info("anulacion propuesta: accion=%s modo=%s -> %s",
             accion, cuerpo.get("modo") or "anular", estado)

    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No encontre nada."))
            return True
        _memoria[chat] = {"tipo": "anulacion_eligiendo",
                          "accion": accion,
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_teclado_movimientos(opciones))
        return True

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No toque nada."))
        return True

    _memoria[chat] = {
        "tipo": "anulacion",
        "accion": accion,
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "modo": r.get("modo") or "anular",
        "peticion": dict(cuerpo),
        "valores": r.get("valores"),
    }
    teclado = (_teclado_confirmar_anulacion(r["borrador_id"]) if accion == "anular"
               else _teclado_confirmar_correccion(r["borrador_id"]))
    await update.effective_message.reply_text(r["mensaje"], reply_markup=teclado)
    return True


async def _confirmar_anulacion(update, chat):
    """El "va" de una anulacion o de una correccion.

    Aqui tampoco hay LLM y no puede haberlo: viajan `{telegram_id, borrador_id,
    sello}` y nada mas. Cual fila se toca lo dice el borrador sellado.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "anulacion":
        await update.effective_message.reply_text("No tengo nada pendiente que anular.")
        return
    estado, r = _post("/api/bot/anular/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("anulacion confirmada: borrador=%s modo=%s -> %s",
             dato["borrador_id"], dato.get("modo"), estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        modo = r.get("modo") or "anular"
        if modo == "recapturar":
            await update.effective_message.reply_text(
                "Listo. Anule la vieja y escribi la corregida.")
        elif modo == "editar_descripcion":
            await update.effective_message.reply_text("Listo. Le cambie el concepto.")
        elif r.get("idTicket"):
            await update.effective_message.reply_text(
                "Listo. Quedo anulada la venta completa y el stock se devolvio.")
        else:
            await update.effective_message.reply_text("Listo. Quedo anulado.")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude anularlo."))


async def _enrutar_y_despachar(update, chat, texto):
    """UNA llamada al modelo decide que quiso decir Norman, y se despacha.

    Antes esto era una cascada de tres intentos EN FILA -- gasto, abono,
    consulta -- asi que una pregunta pagaba tres llamadas al modelo antes de
    contestarse, y todo lo que no cayera en esas tres cajas terminaba en un
    mensaje de ayuda fijo.

    Ahora la intencion se decide una vez. Y como el enrutador ya extrajo los
    campos, un gasto completo tambien se resuelve en UNA llamada: antes era
    una, ahora sigue siendo una, y todo lo demas bajo de tres a una.

    **Y ya no hay cascada detras.** Se habia quedado de red cuando entro el
    enrutador, y era la decision equivocada: una red que vuelve a leer el mismo
    mensaje con OTRO prompt no es una red, es una segunda opinion -- y se activa
    justo cuando algo ya salio raro. La red de verdad son los comandos, que no
    pasan por ningun modelo y por lo tanto siguen de pie aunque el modelo no.

    El segundo argumento de `enrutar` es el BORRADOR A MEDIAS. Hasta el
    2026-09-19 era un `None` literal: el enrutador tenia sitio para los campos
    que ya se sabian y el bot nunca se los mandaba, asi que una captura a medias
    volvia a empezar de cero en cada vuelta.
    """
    ok, ruta = await asyncio.to_thread(
        enrutar, texto, _tomar_borrador_a_medias(chat), list(_catalogo),
        _nombres_deudores())

    if not ok:
        log.warning("el enrutador fallo: %s", ruta)
        await update.effective_message.reply_text(
            "No pude leer ese mensaje: se me cayo el modelo. Dimelo otra vez. "
            "Si corre prisa, /stock, /cartera, /ventas y /abono no pasan por el "
            "modelo y siguen funcionando.")
        return

    log.info("enrutado como %s (confianza %s)", ruta.get("intencion"), ruta.get("confianza"))
    intencion = ruta.get("intencion")
    campos = ruta.get("campos") or {}

    if intencion == "gasto":
        # Si al enrutador le falto lo indispensable, se PREGUNTA una sola cosa
        # y se guarda el texto para juntarlo con la respuesta. Nada se inventa.
        if not campos.get("monto") or not campos.get("descripcion"):
            _recordar_a_medias(chat, "gasto", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Cuanto fue?")
            return
        await _proponer_gasto_directo(update, chat, _propuesta_de_gasto(campos, _catalogo))
        return

    if intencion == "abono":
        # Lo indispensable de un abono es CUANTO. Por el deudor no se pregunta
        # aqui: el servidor lo empata contra la cartera viva y, si duda, manda
        # botones. Preguntar un nombre que se acaba de decir es de las cosas que
        # hacen que un bot se sienta cuadrado.
        if not campos.get("monto"):
            _recordar_a_medias(chat, "abono", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "De cuanto fue el abono?")
            return
        if await _proponer_abono(update, chat, _propuesta_de_abono(campos),
                                 nombre=campos.get("deudor")):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "venta":
        # FASE 3. Lo indispensable de una venta es QUE se vendio; el comprador
        # vacio en CONTADO es "publico en general", que es una venta legitima y
        # de todos los dias, asi que no se pregunta por el.
        renglones = _renglones_de(campos)
        if not renglones:
            _recordar_a_medias(chat, "venta", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Que vendiste?")
            return
        peticion = {
            "productos": renglones,
            "propuesta": {
                "condicion_pago": campos.get("condicion_pago"),
                # Lo que dijo de monto NO se escribe: la ruta lo compara contra
                # el precio de lista y avisa si no cuadran. Ver `lib/bot-venta.ts`.
                "monto": campos.get("monto"),
            },
        }
        if campos.get("comprador"):
            peticion["comprador"] = campos.get("comprador")
        if await _proponer_venta(update, chat, peticion):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "lote":
        # FASE 3.3. Lo indispensable de un lote es que algo haya entrado o
        # salido; el codigo lo propone el servidor y la fecha es hoy, asi que
        # por ninguno de los dos se pregunta.
        peticion = _peticion_de_lote(campos)
        if not peticion["insumos"] and not peticion["propuesta"]["tandas"] and not peticion["envasado"]:
            _recordar_a_medias(chat, "lote", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Cuanto chile entro?")
            return
        if await _proponer_lote(update, chat, peticion):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "cotizacion":
        # FASE 4. Lo indispensable es QUE se cotiza. Por el cliente no se
        # pregunta aqui: el servidor lo pregunta con botones, y entre ellos va
        # "es cliente nuevo", que es el caso normal de una cotizacion.
        peticion = _peticion_de_cotizacion(campos)
        if not peticion["productos"]:
            _recordar_a_medias(chat, "cotizacion", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Que le cotizo?")
            return
        if await _proponer_cotizacion(update, chat, peticion):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "anular":
        # FASE 5. El enrutador NO dice cual: lo dice la persona, con un boton,
        # contra una lista que arma el servidor (D2).
        await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="anular")
        return

    if intencion == "corregir":
        # FASE 5. Misma lista; lo que cambia es la pregunta de despues. Y
        # "corregir" casi nunca acaba en un UPDATE: acaba en anular y volver a
        # escribir, en un solo "va" (D6).
        await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="corregir")
        return

    if intencion == "alta":
        # PASO 5. El nombre es lo unico que el modelo aporta; la zona y el rol
        # NUNCA (D9), y las comisiones se preguntan una por una segun el rol.
        # Si ni el nombre vino, se pregunta por el y ya.
        nombre = (campos.get("nombre") or "").strip()
        if not nombre:
            _recordar_a_medias(chat, "alta", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Como se llama?")
            return
        peticion = {"telegram_id": chat, "nombre": nombre}
        if campos.get("email"):
            peticion["email"] = campos.get("email")
        if campos.get("telefono"):
            peticion["telefono"] = campos.get("telefono")
        await _proponer_alta(update, chat, peticion)
        return

    if intencion == "convertir":
        # PASO 6. El folio, si lo dijo, solo sirve para no ensenar la lista; y
        # aun asi la fila se busca por id, no por folio dictado. Si no lo dijo,
        # se ensena la lista con botones, que es lo normal.
        await _proponer_conversion(update, chat, {"telegram_id": chat})
        return

    if intencion == "consulta":
        # `ruta["consulta"]` en vez de volver a clasificar con el modelo. Y el
        # filtro tal cual: quien lo prueba contra el producto y contra el punto
        # de venta es el servidor, no este proceso.
        if await _contestar_consulta(update, chat, ruta.get("consulta"), ruta.get("filtro")):
            return
        await _responder_natural(update, ruta)
        return

    await _responder_natural(update, ruta)


async def manejar_texto(update, context):
    chat = update.effective_chat.id
    texto = (update.message.text or "").strip()

    # "va" escrito, no solo el boton: el usuario ocasional contesta como habla.
    if texto.lower() in ("va", "si", "sí", "correcto", "asi es", "dale"):
        await _confirmar(update, chat)
        return
    if texto.lower() in ("no", "cancela", "cancelar"):
        _memoria.pop(chat, None)
        await update.message.reply_text("Cancelado. No escribi nada.")
        return

    # Corrigiendo el monto de una propuesta viva: entra el numero y se
    # repropone con ese campo cambiado. **No pasa por el modelo.**
    if _esperando_monto.pop(chat, False):
        limpio = texto.replace("$", "").replace(",", "").replace("pesos", "").strip()
        try:
            monto = float(limpio)
        except ValueError:
            _esperando_monto[chat] = True
            await update.message.reply_text("No lo lei como numero. Solo la cifra, por favor.")
            return
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") == "abono":
            propuesta = dict(dato.get("propuesta") or {})
            propuesta["monto"] = monto
            # Se repropone con el MISMO deudor ya resuelto (por uuid), no con el
            # nombre: cambiar el monto no puede cambiar a quien se le abona.
            await _proponer_abono(update, chat, propuesta,
                                  id_deudor=dato.get("id_deudor"))
            return
        await _reproponer(update, chat, {"propuesta": {"monto": monto}})
        return

    # Contestando una pregunta del alta: el correo, o una comision. **No pasa
    # por el modelo**, por la misma razon que el monto: si la frase se volviera
    # a extraer, el modelo podria "corregir" la zona o el rol que ya se
    # escogieron con boton, y esos dos salieron del lenguaje natural a proposito.
    campo_alta = _esperando_alta.pop(chat, None)
    if campo_alta:
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        if campo_alta.startswith("comision"):
            comisiones = dict(peticion.get("comisiones") or {})
            comisiones[campo_alta] = texto.replace("%", "").strip()
            peticion["comisiones"] = comisiones
        else:
            peticion[campo_alta] = texto.strip()
        await _proponer_alta(update, chat, peticion)
        return

    # Corrigiendo un movimiento YA ESCRITO: entra el valor nuevo y se propone
    # la correccion. **Tampoco pasa por el modelo.**
    cual = _esperando_correccion.pop(chat, None)
    if cual == "monto":
        limpio = texto.replace("$", "").replace(",", "").replace("pesos", "").strip()
        try:
            monto = float(limpio)
        except ValueError:
            _esperando_correccion[chat] = "monto"
            await update.message.reply_text("No lo lei como numero. Solo la cifra, por favor.")
            return
        await _proponer_correccion_de_campo(update, chat, "monto", monto)
        return
    if cual == "desc":
        await _proponer_correccion_de_campo(update, chat, "descripcion", texto.strip())
        return

    # Cambiando el codigo de un lote vivo: entra el texto y se repropone con
    # ese campo cambiado. **Tampoco pasa por el modelo.**
    if _esperando_codigo.pop(chat, False):
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.message.reply_text("Ya no tengo ese lote. Dictamelo otra vez.")
            return
        propuesta = dict(peticion.get("propuesta") or {})
        propuesta["codigo_lote"] = texto.strip()
        peticion["propuesta"] = propuesta
        await _proponer_lote(update, chat, peticion)
        return

    # Cambiando la vigencia de una cotizacion viva. **Tampoco pasa por el
    # modelo.** El tope de dias lo pone el servidor, no esta linea.
    if _esperando_vigencia.pop(chat, False):
        digitos = "".join(c for c in texto if c.isdigit())
        dias = int(digitos) if digitos else 0
        if dias <= 0:
            _esperando_vigencia[chat] = True
            await update.message.reply_text("Cuantos dias? Solo el numero.")
            return
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.message.reply_text(
                "Ya no tengo esa cotizacion. Dictamela otra vez.")
            return
        propuesta = dict(peticion.get("propuesta") or {})
        propuesta["vigencia_dias"] = dias
        peticion["propuesta"] = propuesta
        await _proponer_cotizacion(update, chat, peticion)
        return

    # Si veniamos preguntando un dato que faltaba, quien lo recoge es el
    # enrutador con el borrador a medias. Aqui ya no se pegan frases.
    await update.message.chat.send_action("typing")
    await _enrutar_y_despachar(update, chat, texto)


async def manejar_voz(update, context):
    chat = update.effective_chat.id
    AUDIOS.mkdir(parents=True, exist_ok=True)
    archivo = await context.bot.get_file(update.message.voice.file_id)
    destino = AUDIOS / ("tg_" + dt.datetime.now().strftime("%Y%m%d_%H%M%S") + ".ogg")
    await archivo.download_to_drive(str(destino))

    await update.message.chat.send_action("typing")
    from transcribir_nota import transcribir
    # El vocabulario VIVO: lo que el servidor ya declaro en esta sesion. Sin
    # esto Whisper llega a un nombre propio de la cartera sin haberlo oido
    # nunca. La lista se arma aqui y no en el transcriptor porque la autoridad
    # sobre que existe es del servidor, no del proceso del bot.
    dato = _memoria.get(chat) or {}
    vocab = list(_catalogo)
    vocab += [d.get("nombre") for d in (_deudores or []) if isinstance(d, dict)]
    vocab += [c.get("nombre") for c in (dato.get("cuentas") or []) if isinstance(c, dict)]
    ok, texto = await asyncio.to_thread(transcribir, str(destino), [v for v in vocab if v])
    if not ok:
        await update.message.reply_text(str(texto))
        return
    await update.message.reply_text('Te entendi: "' + texto + '"')

    # 1.b. **La voz entra por el mismo sitio que el texto.** Hasta el
    # 2026-09-19 esta linea llamaba a `_proponer`, o sea a la cascada vieja: una
    # nota de voz NUNCA llegaba al enrutador. Dictar "cotizale 20 cajas a
    # Delirio" no cotizaba nada -- se intentaba leer como gasto, fallaba; como
    # abono, fallaba; y contestaba el mensaje de ayuda. Todo lo que las fases 3 y
    # 4 agregaron existia solo para quien escribiera, y Norman dicta.
    await _enrutar_y_despachar(update, chat, texto)


# ===========================================================================
# PASO 5 — confirmar. Aqui no hay LLM, y no puede haberlo.
# ===========================================================================

async def _confirmar_abono(update, chat):
    """El "va" de un abono. Aqui tampoco hay LLM, y no puede haberlo: solo
    viajan `{telegram_id, borrador_id, sello}`."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "abono":
        await update.effective_message.reply_text("No tengo ningun abono pendiente que escribir.")
        return
    estado, r = _post("/api/bot/abono/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("abono confirmado: borrador=%s -> %s filas=%s",
             dato["borrador_id"], estado, r.get("filas_escritas"))
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        cubiertos = r.get("pedidos_cubiertos") or 0
        sobrante = r.get("sobrante") or 0
        detalle = "Listo. Quedo registrado"
        if cubiertos:
            detalle += " y cubre " + str(cubiertos) + " pedido(s)"
        if sobrante:
            detalle += "; " + ("{:,.2f}".format(sobrante)) + " quedaron a cuenta"
        await update.effective_message.reply_text(detalle + ".")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude escribir el abono."))


async def _confirmar(update, chat):
    dato = _memoria.get(chat)
    if not dato:
        await update.effective_message.reply_text("No tengo nada pendiente que escribir.")
        return
    # Un borrador a medias NO se confirma, y este es el candado que lo impide.
    # Comparte casilla con los borradores de verdad, pero no tiene sello -- y
    # sin sello no hay nada que mandar al servidor. Un "va" adelantado se
    # contesta diciendo que falta, no escribiendo una fila incompleta.
    if dato.get("estado") == "incompleto":
        await update.effective_message.reply_text(
            "Todavia me falta un dato para poder escribirlo. Contestame lo que te pregunte.")
        return
    # Un "va" escrito vale para lo que este pendiente, sea gasto o abono: la
    # persona contesta como habla y no tiene por que saber que hay dos caminos.
    if dato.get("tipo") == "abono":
        await _confirmar_abono(update, chat)
        return
    if dato.get("tipo") == "anulacion":
        await _confirmar_anulacion(update, chat)
        return
    if dato.get("tipo") == "anulacion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime cual, con uno de los botones.")
        return
    if dato.get("tipo") == "correccion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime que le cambio, con uno de los botones.")
        return
    if dato.get("tipo") == "alta":
        await _confirmar_alta(update, chat)
        return
    if dato.get("tipo") == "alta_eligiendo":
        await update.effective_message.reply_text(
            "Todavia me falta un dato del alta. Contestame lo que te pregunte.")
        return
    if dato.get("tipo") == "conversion":
        await _confirmar_conversion(update, chat)
        return
    if dato.get("tipo") == "conversion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime cual, con uno de los botones.")
        return
    if dato.get("tipo") == "venta":
        await _confirmar_venta(update, chat)
        return
    if dato.get("tipo") == "lote":
        await _confirmar_lote(update, chat)
        return
    if dato.get("tipo") == "cotizacion":
        await _confirmar_cotizacion(update, chat)
        return
    if dato.get("tipo") == "cotizacion_eligiendo":
        pendiente = ("que producto" if dato.get("campo") == "producto"
                     else "a quien se la cotizo")
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "lote_eligiendo":
        pendiente = "el insumo" if dato.get("campo") == "insumo" else "el formato de las botellas"
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "venta_eligiendo":
        pendiente = "el producto" if dato.get("campo") == "producto" else "el comprador"
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "abono_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime de quien fue el pago, con uno de los botones.")
        return
    estado, r = _post("/api/bot/gasto/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        creada = r.get("categoria_creada")
        if creada:
            if creada not in _catalogo:
                _catalogo.append(creada)
            await update.effective_message.reply_text(
                "Listo. Quedo escrito, y la categoria " + str(creada) +
                " quedo creada: desde ahora la uso sola.")
        else:
            await update.effective_message.reply_text("Listo. Quedo escrito.")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude escribirlo."))


async def _reproponer(update, chat, cambios):
    """Vuelve a proponer con UN campo cambiado. **Sin pasar por el LLM.**

    Es la diferencia entre corregir el campo y corregir la frase: re-extraer
    todo le daria al modelo licencia para cambiar campos que nadie toco.
    """
    dato = _memoria.get(chat)
    if not dato or "propuesta" not in dato:
        await update.effective_message.reply_text("Ya no tengo esa propuesta. Dictamelo otra vez.")
        return
    propuesta = dict(dato["propuesta"])
    propuesta.update(cambios.get("propuesta", {}))
    id_cuenta = cambios.get("id_cuenta", dato.get("id_cuenta"))

    cuerpo = {"telegram_id": chat, "propuesta": propuesta}
    if id_cuenta:
        cuerpo["id_cuenta"] = id_cuenta
    estado, r = _post("/api/bot/gasto/proponer", cuerpo)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude reproponerlo."))
        return
    _memoria[chat] = {
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "propuesta": propuesta,
        "cuentas": r.get("cuentas", dato.get("cuentas", [])),
        "id_cuenta": r.get("id_cuenta"),
        "categorias": r.get("categorias", list(_catalogo)),
    }
    _refrescar_catalogo(r)
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))


async def manejar_boton(update, context):
    q = update.callback_query
    await q.answer()
    chat = q.message.chat.id
    partes = q.data.split(":", 2)
    accion = partes[0]

    if accion == "valt":
        await _confirmar_lote(update, chat)
    elif accion == "cod":
        _esperando_codigo[chat] = True
        await q.message.reply_text("Que codigo le pongo?")
    elif accion == "setins":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        lineas = [dict(x) for x in (peticion.get("insumos") or [])]
        try:
            elegido = opciones[int(partes[1])]
            lineas[int(dato.get("indice"))]["id_insumo"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Ese insumo ya no esta en la lista. Dictamelo otra vez.")
            return
        peticion["insumos"] = lineas
        await _proponer_lote(update, chat, peticion)
    elif accion == "setfmt":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        lineas = [dict(x) for x in (peticion.get("envasado") or [])]
        try:
            elegido = opciones[int(partes[1])]
            lineas[int(dato.get("indice"))]["id_producto"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Ese formato ya no esta en la lista. Dictamelo otra vez.")
            return
        peticion["envasado"] = lineas
        await _proponer_lote(update, chat, peticion)
    elif accion == "vact":
        await _confirmar_cotizacion(update, chat)
    elif accion == "cli":
        # "Otro cliente": la lista COMPLETA que mando el servidor la ultima
        # vez. Sin boton de prospecto: para cotizarle a alguien que no esta en
        # la red hay que decir su nombre, y eso se dicta, no se escoge.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("clientes") or []
        if not opciones:
            await q.message.reply_text(
                "Dictamela otra vez diciendo a quien se la cotizo.")
        else:
            await q.message.reply_text(
                "A quien?", reply_markup=_teclado_clientes(opciones))
    elif accion == "vig":
        _esperando_vigencia[chat] = True
        await q.message.reply_text("Cuantos dias se la respeto? Solo el numero.")
    elif accion == "setcli":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await q.message.reply_text("Ya no tengo esa cotizacion. Dictamela otra vez.")
            return
        peticion.pop("cliente", None)
        peticion.pop("id_comprador", None)
        peticion.pop("prospecto", None)
        if partes[1] == "pros":
            # El nombre del prospecto es el que se DIJO, guardado por el
            # servidor en la pregunta. El boton no lo lleva: no cabe en los 64
            # bytes de `callback_data` y ademas se reescribiria a mano.
            nombre = dato.get("nombre_dicho") or ""
            if not nombre:
                await q.message.reply_text("No me quedo el nombre. Dictamela otra vez.")
                return
            peticion["prospecto"] = nombre
        else:
            opciones = dato.get("opciones") or dato.get("clientes") or []
            try:
                elegido = opciones[int(partes[1])]
            except (ValueError, IndexError, TypeError):
                await q.message.reply_text("Ese ya no esta en la lista. Dictamela otra vez.")
                return
            peticion["id_comprador"] = elegido["id"]
        await _proponer_cotizacion(update, chat, peticion)
    elif accion == "vavt":
        await _confirmar_venta(update, chat)
    elif accion == "comp":
        # "Otro comprador": se vuelve a preguntar con la lista COMPLETA que el
        # servidor mando la ultima vez. Es la correccion que de verdad importa
        # en una venta, porque el comprador decide el precio.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("compradores") or []
        if not opciones:
            await q.message.reply_text("Dictamela otra vez diciendo a quien se la vendiste.")
        else:
            peticion = dato.get("peticion") or {}
            publico = str(peticion.get("propuesta", {}).get("condicion_pago") or "").upper() != "CONCESION"
            await q.message.reply_text(
                "A quien?", reply_markup=_teclado_compradores(opciones, publico))
    elif accion == "setcomp":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await q.message.reply_text("Ya no tengo esa venta. Dictamela otra vez.")
            return
        peticion.pop("comprador", None)
        peticion.pop("id_comprador", None)
        peticion.pop("publico", None)
        if partes[1] == "pub":
            peticion["publico"] = True
        else:
            opciones = dato.get("opciones") or dato.get("compradores") or []
            try:
                elegido = opciones[int(partes[1])]
            except (ValueError, IndexError, TypeError):
                await q.message.reply_text("Ese ya no esta en la lista. Dictamela otra vez.")
                return
            peticion["id_comprador"] = elegido["id"]
        await _proponer_venta(update, chat, peticion)
    elif accion == "setprod":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        renglones = [dict(x) for x in (peticion.get("productos") or [])]
        try:
            elegido = opciones[int(partes[1])]
            indice = int(dato.get("indice"))
            renglones[indice]["id_producto"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Ese producto ya no esta en la lista. Dictamela otra vez.")
            return
        peticion["productos"] = renglones
        await _proponer_venta(update, chat, peticion)
    elif accion == "vaan":
        await _confirmar_anulacion(update, chat)
    elif accion == "vaalt":
        await _confirmar_alta(update, chat)
    elif accion == "setalta":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        campo = dato.get("campo")
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            # El indice solo significa algo contra la lista que se ofrecio.
            await q.message.reply_text("Ese ya no esta en la lista. Empecemos otra vez.")
            return
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        valor = elegido.get("valor")
        if campo == "duplicado":
            if valor != "si":
                _memoria.pop(chat, None)
                await q.message.reply_text("Va, no lo creo. No escribi nada.")
                return
            # La persona ya vio con quien se parece y dijo que es otro. La
            # bandera la pone el BOT, nunca el modelo: es un consentimiento, no
            # un dato extraido de una frase.
            peticion["aun_con_parecidas"] = True
        elif campo and campo.startswith("comision"):
            comisiones = dict(peticion.get("comisiones") or {})
            comisiones[campo] = valor
            peticion["comisiones"] = comisiones
        elif campo:
            peticion[campo] = valor
        await _proponer_alta(update, chat, peticion)
    elif accion == "vacnv":
        await _confirmar_conversion(update, chat)
    elif accion == "setcnv":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        campo = dato.get("campo")
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Esa ya no esta en la lista. Pidemela otra vez.")
            return
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        if campo == "cotizacion":
            peticion["id_cotizacion"] = elegido.get("id")
        elif campo == "condicion_pago":
            peticion["condicion_pago"] = elegido.get("valor")
        elif campo == "cuenta":
            peticion["id_cuenta_destino"] = elegido.get("valor")
        await _proponer_conversion(update, chat, peticion)
    elif accion == "setanu":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            # El indice solo significa algo contra la lista que se ofrecio. Si
            # ya no esta, NO se adivina: se vuelve a pedir la lista.
            await q.message.reply_text("Ese ya no esta en la lista. Pidemela otra vez.")
            return
        if dato.get("accion") == "corregir":
            if not elegido.get("valores"):
                await q.message.reply_text(
                    "Ese no se corrige: es un movimiento de inventario y el stock se "
                    "replaya desde el ledger entero. Lo puedo anular y lo recapturas.")
                return
            if elegido.get("arrastra_venta"):
                await q.message.reply_text(
                    "Ese renglon es de una venta y su concepto lleva el folio dentro. "
                    "Lo puedo anular entero, pero no reescribirlo.")
                return
            _memoria[chat] = {"tipo": "correccion_eligiendo",
                              "accion": "corregir",
                              "elegido": elegido,
                              "opciones": opciones}
            await q.message.reply_text(
                "Que le cambio?" + NL + elegido.get("detalle", ""),
                reply_markup=_teclado_campos_corregibles())
            return
        await _proponer_anulacion(update, chat, {
            "telegram_id": chat,
            "tabla": elegido.get("tabla"),
            "id_movimiento": elegido.get("id"),
            "modo": "anular",
        }, accion="anular")
    elif accion == "setcorr":
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") != "correccion_eligiendo":
            await q.message.reply_text("Ya no tengo ese movimiento. Dimelo otra vez.")
            return
        cual = partes[1]
        if cual == "monto":
            _esperando_correccion[chat] = "monto"
            await q.message.reply_text("De cuanto era? Solo el numero.")
        elif cual == "desc":
            _esperando_correccion[chat] = "desc"
            await q.message.reply_text("Como le pongo?")
        else:
            # La categoria reusa el teclado de siempre. La lista que se ofrece
            # se guarda EXACTA, porque el indice del boton solo significa algo
            # contra ella y no contra lo que el catalogo diga despues.
            vivas = list(_catalogo)
            dato["categorias_ofrecidas"] = vivas
            await q.message.reply_text("Cual es?", reply_markup=_teclado_categorias(vivas))
    elif accion == "vaab":
        await _confirmar_abono(update, chat)
    elif accion == "deu":
        # "Otro deudor": se vuelve a preguntar con la lista COMPLETA que el
        # servidor mando la ultima vez.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        if not opciones:
            await q.message.reply_text("Dictamelo otra vez diciendo de quien fue el pago.")
        else:
            await q.message.reply_text("De quien fue?", reply_markup=_teclado_deudores(opciones))
    elif accion == "setdeu":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Ese ya no esta en la lista. Dictamelo otra vez.")
            return
        await _proponer_abono(update, chat, dato.get("propuesta"),
                              id_deudor=elegido["id_entidad"])
    elif accion == "montoab":
        _esperando_monto[chat] = True
        await q.message.reply_text("De cuanto fue el abono? Solo el numero.")
    elif accion == "va":
        await _confirmar(update, chat)
    elif accion == "no":
        _memoria.pop(chat, None)
        await q.message.reply_text("Cancelado. No escribi nada.")
    elif accion == "cat":
        dato = _memoria.get(chat)
        if not dato:
            await q.message.reply_text("Ya no tengo ese borrador. Dictamelo otra vez.")
            return
        vivas = dato.get("categorias") or list(_catalogo)
        # Se guarda la lista EXACTA que se ofrecio: el indice del boton solo
        # significa algo contra ella, no contra lo que el catalogo diga despues.
        dato["categorias_ofrecidas"] = list(vivas)
        await q.message.reply_text("Cual es?", reply_markup=_teclado_categorias(vivas))
    elif accion == "setcat":
        dato = _memoria.get(chat) or {}
        ofrecidas = dato.get("categorias_ofrecidas") or dato.get("categorias") or []
        # El teclado de categorias es el mismo para capturar y para corregir,
        # pero el camino NO. Sin esta bifurcacion, cambiarle la categoria a un
        # movimiento ya escrito lo volveria a proponer como un gasto NUEVO: dos
        # filas donde deberia haber una corregida.
        if dato.get("tipo") == "correccion_eligiendo":
            try:
                i = int(partes[1])
            except (ValueError, IndexError, TypeError):
                await q.message.reply_text("No entendi ese boton. Dimelo otra vez.")
                return
            try:
                nueva = None if i == -1 else ofrecidas[i]
            except IndexError:
                await q.message.reply_text("Esa categoria ya no esta en la lista.")
                return
            if not nueva:
                await q.message.reply_text("Para corregir la categoria tienes que escoger una.")
                return
            await _proponer_correccion_de_campo(update, chat, "categoria", nueva)
            return
        try:
            i = int(partes[1])
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("No entendi ese boton. Dictamelo otra vez.")
            return
        if i == -1:
            nueva = None
        else:
            try:
                nueva = ofrecidas[i]
            except IndexError:
                await q.message.reply_text("Esa categoria ya no esta en la lista. Dictamelo otra vez.")
                return
        await _reproponer(update, chat, {"propuesta": {"categoria": nueva}})
    elif accion == "monto":
        _esperando_monto[chat] = True
        await q.message.reply_text("De cuanto fue? Solo el numero.")
    elif accion == "cta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        if len(cuentas) < 2:
            await q.message.reply_text("Solo tienes una cuenta dada de alta; no hay a cual cambiar.")
        else:
            await q.message.reply_text("Contra cual?", reply_markup=_teclado_cuentas(cuentas))
    elif accion == "setcta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        try:
            elegida = cuentas[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Esa cuenta ya no esta en la lista. Dictamelo otra vez.")
            return
        # Las dos fases comparten el boton de cuenta, pero NO la ruta que
        # repropone. Sin esta bifurcacion, cambiarle la cuenta a una venta la
        # volveria a proponer como gasto: el peor error posible en este archivo.
        if dato.get("tipo") == "venta":
            peticion = dict(dato.get("peticion") or {})
            peticion["id_cuenta"] = elegida["id"]
            await _proponer_venta(update, chat, peticion)
            return
        await _reproponer(update, chat, {"id_cuenta": elegida["id"]})


async def _consulta_directa(update, consulta, filtro=None):
    """Los comandos /stock /cartera /ventas: la consulta SIN pasar por el modelo.

    Existe por latencia, no por seguridad: el camino de lenguaje natural paga
    DOS llamadas al modelo (una para descartar el gasto y otra para clasificar
    la pregunta). Lo que se usa a diario no tiene por que pagar eso, y ademas
    un comando escrito no se puede clasificar mal.
    """
    chat = update.effective_chat.id
    await update.effective_message.chat.send_action("typing")
    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat, "consulta": consulta, "filtro": filtro,
    })
    log.info("comando /%s filtro=%s -> %s", consulta, filtro, estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude consultarlo."))
        return
    await update.effective_message.reply_text(r["texto"])


async def comando_stock(update, context):
    await _consulta_directa(update, "stock", " ".join(context.args or []).strip() or None)


async def comando_cartera(update, context):
    await _consulta_directa(update, "cartera")


async def comando_ventas(update, context):
    await _consulta_directa(update, "ventas")


async def comando_abono(update, context):
    """`/abono <nombre> <monto>` — la cobranza SIN pasar por el modelo.

    Existe por la misma razon que /stock y /cartera: latencia. El camino de
    lenguaje natural paga DOS llamadas al modelo antes de llegar aqui (una para
    descartar el gasto, otra para leer el abono), y lo que se usa a diario no
    tiene por que pagar eso. Ademas un comando escrito no se puede clasificar
    mal — y aqui una clasificacion mala mueve dinero.

    El monto es el ULTIMO token; todo lo anterior es el nombre. El servidor
    sigue empatando el nombre contra la cartera y sigue preguntando si hay duda:
    este atajo se salta el modelo, **no las defensas**.
    """
    chat = update.effective_chat.id
    args = list(context.args or [])
    if len(args) < 2:
        await update.effective_message.reply_text(
            "Se usa asi: /abono Gilberto 5000" + NL
            + "(el ultimo numero es el monto; lo de antes, de quien fue el pago)")
        return
    crudo = args[-1].replace("$", "").replace(",", "")
    try:
        monto = float(crudo)
    except ValueError:
        await update.effective_message.reply_text(
            "No lei \"" + args[-1] + "\" como monto. El ultimo dato tiene que ser el numero.")
        return
    nombre = " ".join(args[:-1]).strip()
    await update.effective_message.chat.send_action("typing")
    # El nombre no se resuelve aqui: viaja al servidor como se tecleo, y el
    # servidor lo empata o pregunta. Es el mismo camino que el de la voz.
    await _proponer_abono(update, chat,
                          {"monto": monto, "metodo_pago": None,
                           "nota": None, "fecha": None},
                          nombre=nombre)


async def comando_anular(update, context):
    """/anular — la lista, sin pasar por el modelo. Igual que /stock.

    Existe por latencia y por confianza, no por seguridad: el camino de lenguaje
    natural paga una llamada al modelo para decidir que "cancela el gasto de
    ayer" es una anulacion y no un gasto. Lo que se usa a diario no tiene por que
    pagar eso, y ademas un comando escrito no se puede clasificar mal -- que en
    este camino importa mas que en los otros, porque leer "anula" como "gasto"
    escribe una fila de dinero que nadie pidio.

    No anula nada: ofrece la lista. Lo que anula es el "va".
    """
    chat = update.effective_chat.id
    await update.effective_message.chat.send_action("typing")
    await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="anular")


async def comando_corregir(update, context):
    """/corregir — la misma lista, y despues se pregunta que campo."""
    chat = update.effective_chat.id
    await update.effective_message.chat.send_action("typing")
    await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="corregir")


async def comando_alta(update, context):
    """/alta — el alta sin pasar por el modelo. Misma razon que /anular.

    Empieza preguntando el nombre, porque es lo unico que el modelo aportaba en
    este camino. Todo lo demas ya iba por boton.
    """
    chat = update.effective_chat.id
    _memoria[chat] = {"tipo": "alta_eligiendo", "campo": "nombre",
                      "peticion": {"telegram_id": chat}, "opciones": []}
    _esperando_alta[chat] = "nombre"
    await update.effective_message.reply_text(
        "Va. Como se llama el distribuidor o el local?")


async def comando_convertir(update, context):
    """/convertir — la lista de cotizaciones abiertas, sin modelo."""
    chat = update.effective_chat.id
    await update.effective_message.chat.send_action("typing")
    await _proponer_conversion(update, chat, {"telegram_id": chat})


async def comando_inicio(update, context):
    await update.message.reply_text(
        "Soy el bot del ERP. Capturo y consulto." + NL + NL
        + "PARA CAPTURAR, dime lo que gastaste como lo dirias en persona, por"
          " texto o nota de voz:" + NL
        + '  "gaste 340 de gasolina yendo a Zacatecas"' + NL
        + "Te enseno la fila exacta antes de escribir nada. Nada entra sin tu VA." + NL + NL
        + "PARA CONSULTAR:" + NL
        + "  /stock            que hay, y donde" + NL
        + "  /stock chile 750  solo de un producto, o de un punto de venta" + NL
        + "  /cartera          quien debe, cuanto, y desde cuando" + NL
        + "  /ventas           los ultimos 6 meses" + NL + NL
        + "PARA REGISTRAR UN PAGO QUE TE HICIERON:" + NL
        + "  /abono Gilberto 5000   o dilo hablando: \"me deposito Gilberto 5 mil\"" + NL
        + "Te enseno a que pedidos se aplica ANTES de escribir nada." + NL
        + "Tambien puedes preguntarlo hablando: \"cuanto me debe Delirio\"." + NL + NL
        + "PARA DESHACER O CORREGIR ALGO QUE YA QUEDO ESCRITO:" + NL
        + "  /anular           te enseno los ultimos y escoges con un boton" + NL
        + "  /corregir         igual, y despues te pregunto que le cambio" + NL
        + "Nunca te voy a pedir que me digas cual de oido: siempre lo escoges de"
          " una lista." + NL + NL
        + "Los numeros salen de las vistas del ERP, nunca del modelo.")


async def manejar_no_autorizado(update, context):
    # Un telegram_id sin alta no escribe y tampoco averigua nada del sistema.
    log.warning("mensaje de chat no dado de alta: %s", update.effective_chat.id)


async def _latir(app):
    """El latido. Su valor es el silencio: sin lineas durante mas de 15 min, el
    bot esta colgado aunque el proceso siga en la lista de tareas (E-25)."""
    while True:
        await asyncio.sleep(INTERVALO_LATIDO)
        log.info("latido: vivo, %d borrador(es) en memoria", len(_memoria))


async def _al_arrancar(app):
    app.create_task(_latir(app))


def _candado():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", PUERTO_CANDADO))
    except OSError:
        print("Ya hay otra instancia del bot de gastos corriendo. Salgo.")
        sys.exit(1)
    return s


async def manejar_error(update, context):
    """Sin esto, python-telegram-bot escribe *"No error handlers are
    registered"* y vuelca un traceback de 30 lineas por cada hipo de la red.

    El 2026-09-12 hubo 9 de esos, todos por `Bad Gateway` o `ReadError` de
    api.telegram.org -- transitorios, que la libreria ya reintenta sola. El
    traceback no aportaba nada y enterraba lo que si importaba.

    **Y la mitad que de verdad cuenta:** si el error salta a medio encargo, el
    usuario se queda mirando una pantalla que no contesta. Aqui al menos se le
    dice, que es lo unico peor que fallar: fallar en silencio.
    """
    err = context.error
    transitorio = isinstance(err, (NetworkError, TimedOut))
    if transitorio:
        log.warning("red inestable con Telegram (%s). La libreria reintenta.",
                    type(err).__name__)
        return
    log.error("error no atendido: %s", err, exc_info=err)
    try:
        if isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text(
                "Algo se me rompio aqui adentro y NO escribi nada. "
                "Vuelve a dictarmelo, porfa.")
    except Exception:
        pass


def main():
    if not TOKEN_TG:
        print("Falta BOT_GASTOS_TELEGRAM_TOKEN. Ver bot/LEEME.md")
        sys.exit(1)
    if not TOKEN_API or len(TOKEN_API) < 24:
        print("Falta BOT_API_TOKEN (minimo 24 caracteres). Ver bot/LEEME.md")
        sys.exit(1)

    candado = _candado()  # noqa: F841 - vive hasta que muere el proceso
    log.info("arrancando bot de gastos contra %s", API)

    app = Application.builder().token(TOKEN_TG).post_init(_al_arrancar).build()
    app.add_handler(CommandHandler("start", comando_inicio))
    app.add_handler(CommandHandler("stock", comando_stock))
    app.add_handler(CommandHandler("cartera", comando_cartera))
    app.add_handler(CommandHandler("ventas", comando_ventas))
    app.add_handler(CommandHandler("abono", comando_abono))
    app.add_handler(CommandHandler("anular", comando_anular))
    app.add_handler(CommandHandler("corregir", comando_corregir))
    app.add_handler(CommandHandler("alta", comando_alta))
    app.add_handler(CommandHandler("convertir", comando_convertir))
    app.add_handler(CallbackQueryHandler(manejar_boton))
    app.add_handler(MessageHandler(filters.VOICE, manejar_voz))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, manejar_texto))
    app.add_error_handler(manejar_error)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
