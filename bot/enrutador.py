# -*- coding: utf-8 -*-
"""El enrutador: UNA llamada al modelo que decide que quiso decir Norman.

----------------------------------------------------------------------------
POR QUE EXISTE
----------------------------------------------------------------------------
Hasta hoy el bot probaba tres cosas EN FILA -- gasto, luego abono, luego
consulta -- y cada intento era su propia llamada al modelo con su propio
prompt. Una pregunta pagaba tres llamadas antes de contestarse, y cualquier
cosa fuera de esas tres cajas caia en un mensaje de ayuda fijo.

Norman, 2026-09-18: *"siento al bot muy rigido, muy cuadrado"* y *"quiero que
me pueda preguntar si le falto algo"*. Tenia razon y era literal: el bot era
cuadrado porque su enrutamiento era una cadena de if.

Aqui se decide la intencion UNA vez, y de paso se rescata lo que el modelo si
entendio del mensaje, para no volver a preguntarlo.

----------------------------------------------------------------------------
LO QUE ESTE MODULO NO HACE, Y ES A PROPOSITO
----------------------------------------------------------------------------
**No escribe nada.** Devuelve una intencion y unos campos; quien escribe sigue
siendo el flujo de borrador sellado (`/api/bot/*/proponer` -> boton VA ->
`/api/bot/*/confirmar`). Esa frontera es la mejor pieza de diseno del sistema
-- entre el "va" y el INSERT no hay ningun campo que el modelo pueda mandar --
y este archivo se construye ENCIMA de ella, nunca alrededor.
"""
import json
import shutil
import subprocess
import sys

TIMEOUT = 90

# Las intenciones que el bot sabe atender. "charla" es el cajon honesto: un
# saludo o algo que no cae en ninguna, y se contesta hablando, no con un menu.
INTENCIONES = (
    "gasto",
    "abono",
    "venta",
    "lote",
    "consulta",
    "cotizacion",
    "reporte",
    "charla",
)

CONSULTAS = ("stock", "cartera", "ventas", "margen", "lote", "otra")

PROMPT = u"""Eres el enrutador de un bot de Telegram de una destileria de chile en Mexico.
Norman te escribe o te dicta notas de voz mientras trabaja. Decides QUE quiso
hacer. NO ejecutas nada.

Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:

{
  "intencion": una de: gasto | abono | venta | lote | consulta | cotizacion | reporte | charla,
  "consulta": si intencion es consulta, una de: stock | cartera | ventas | margen | lote | otra. Si no, null,
  "entendido": frase MUY corta de lo que si entendiste, en sus palabras. Nunca vacia,
  "campos": objeto con lo que lograste sacar del mensaje. Solo lo que DE VERDAD dijo,
  "faltantes": lista de los campos obligatorios que NO dijo,
  "pregunta": UNA sola pregunta corta para el faltante mas importante, o null si no falta nada,
  "confianza": "alta" | "media" | "baja"
}

QUE ES CADA INTENCION
- gasto: salio dinero. Compras, pagos a proveedor, gasolina, viaticos.
  Campos: monto, descripcion, categoria, fecha.
- abono: un cliente o distribuidor le PAGO algo de lo que debia.
  Campos: deudor, monto, fecha.
- venta: se vendio producto. Entro dinero o se dejo a credito.
  Campos: productos (lista de {producto, cantidad}), comprador, monto, condicion_pago (CONTADO o CONCESION), fecha.
- lote: se produjo. Fermentacion, kilos de chile, litros, grados, envasado.
  Campos: codigo_lote, kg_chile, dias_fermentacion, horas_fermentacion, tandas (lista de {litros, grado}), botellas.
- cotizacion: quiere un precio para un cliente ANTES de vender. "cotizale a", "cuanto le sale".
  Campos: productos (lista de {producto, cantidad}), cliente, vigencia_dias.
- consulta: pregunta por algo que ya esta en el sistema. No escribe nada.
- reporte: quiere el resumen del dia o del periodo.
- charla: saludo, agradecimiento, o algo que no cae en ninguna de las anteriores.

REGLAS QUE NO SE ROMPEN
1. NUNCA inventes un valor. Si no lo dijo, va en "faltantes". Un monto inventado
   se convierte en un movimiento de dinero falso.
2. "pregunta" es UNA sola, corta, por el faltante que mas bloquea. Nunca una
   lista. Nunca dos preguntas en una.
3. NUNCA le repitas de vuelta lo que ya entendiste. El ya lo dijo.
4. Si el mensaje trae todo lo obligatorio, "pregunta" es null y "faltantes" vacia.
5. Escribe como se habla en Mexico, tuteando, sin formalismos y sin emojis.
   Telegram tiene que ser lo mas conciso posible: una linea.
6. Una VENTA no es un gasto. Salio producto y entro dinero: es venta.
   Un ABONO no es una venta: es un pago de algo que ya se debia.
7. Las cantidades en kilos, litros y grados casi siempre son de un LOTE.
8. Si dudas entre dos intenciones, escoge la que ESCRIBE (gasto, abono, venta,
   lote) sobre la que solo lee (consulta). Una escritura que se pierde no deja
   rastro de que se perdio; una consulta mal leida se vuelve a preguntar.
9. Si de plano no entiendes, intencion "charla" y en "entendido" di lo poco que
   si sacaste. Nunca contestes con un menu de opciones.
10. LA FECHA NUNCA ES OBLIGATORIA. Si no la dijo, es hoy. Jamas la pongas en
   "faltantes" ni preguntes por ella. Preguntar algo que se puede suponer bien
   es justo lo que hace que un bot se sienta cuadrado.
11. Solo va en "faltantes" lo que SIN ESO no se puede guardar: un gasto sin
   monto, un abono sin deudor o sin monto, una venta sin producto o sin monto,
   un lote sin kilos de chile. Todo lo demas se guarda vacio y se corrige
   despues.

CAMPOS QUE YA SE SABEN
Si abajo viene un borrador a medias, el mensaje nuevo lo COMPLETA: junta los dos
y saca "faltantes" del resultado, no del mensaje suelto.

EL MENSAJE:
"""


def _claude():
    ruta = shutil.which("claude")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    # Sonnet, por la misma razon que en extraer.py: enrutar es criterio, no
    # mecanica. Equivocar la intencion manda un dinero real a la tabla
    # equivocada, y eso no se nota hasta que cuadran las cuentas.
    return [ruta, "-p", "--model", "sonnet"]


def _pedazo_contexto(borrador, catalogo, deudores):
    """Lo que el modelo necesita saber del mundo, y nada mas."""
    partes = []
    if borrador:
        partes.append("BORRADOR A MEDIAS (completalo con el mensaje nuevo):")
        partes.append(json.dumps(borrador, ensure_ascii=False))
    if catalogo:
        partes.append("CATEGORIAS DE GASTO QUE EXISTEN: " + ", ".join(sorted(catalogo)))
    if deudores:
        partes.append("QUIENES DEBEN HOY: " + ", ".join(deudores))
    if not partes:
        return ""
    return "\n".join(partes) + "\n\n"


def _normaliza(obj):
    """Deja el objeto del modelo en una forma con la que el bot pueda trabajar.

    Todo lo que viene del modelo es sospechoso hasta que se revisa. Un valor
    fuera de la lista no es un error del que haya que quejarse: se degrada a
    "charla", que es el caso seguro porque no escribe nada.
    """
    intencion = str(obj.get("intencion") or "").strip().lower()
    if intencion not in INTENCIONES:
        intencion = "charla"

    consulta = obj.get("consulta")
    consulta = str(consulta).strip().lower() if consulta else None
    if consulta not in CONSULTAS:
        consulta = None

    campos = obj.get("campos")
    if not isinstance(campos, dict):
        campos = {}

    faltantes = obj.get("faltantes")
    if not isinstance(faltantes, list):
        faltantes = []
    faltantes = [str(f) for f in faltantes if f]

    pregunta = obj.get("pregunta")
    pregunta = str(pregunta).strip() if pregunta else None

    confianza = str(obj.get("confianza") or "media").strip().lower()
    if confianza not in ("alta", "media", "baja"):
        confianza = "media"

    # Una pregunta sin faltantes no tiene a quien contestarle, y unos faltantes
    # sin pregunta dejan a Norman esperando. Se arregla aqui y no en el prompt,
    # porque un prompt se puede desobedecer y esto no.
    if faltantes and not pregunta:
        pregunta = "Me falta " + faltantes[0] + ". Me lo dices?"
    if pregunta and not faltantes:
        faltantes = ["dato"]

    return {
        "intencion": intencion,
        "consulta": consulta,
        "entendido": str(obj.get("entendido") or "").strip(),
        "campos": campos,
        "faltantes": faltantes,
        "pregunta": pregunta,
        "confianza": confianza,
    }


def enrutar(texto, borrador=None, catalogo=None, deudores=None):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo.

    `borrador` es lo que ya se sabia de una captura a medias. Si viene, el
    mensaje nuevo lo COMPLETA en vez de empezar de cero: eso es lo que hace que
    una conversacion de tres mensajes termine en un solo movimiento y no en tres
    intentos fallidos.
    """
    if not str(texto or "").strip():
        return False, "mensaje vacio"

    entrada = PROMPT + _pedazo_contexto(borrador, catalogo, deudores) + str(texto).strip()

    try:
        salida = subprocess.run(
            _claude(),
            input=entrada,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, "el modelo no contesto a tiempo"
    except Exception as e:
        return False, "no pude llamar al modelo: " + str(e)

    if salida.returncode != 0:
        return False, "el modelo devolvio error: " + (salida.stderr or "")[-200:]

    crudo = (salida.stdout or "").strip()
    ini, fin = crudo.find("{"), crudo.rfind("}")
    if ini == -1 or fin == -1:
        return False, "el modelo no devolvio un objeto"
    try:
        obj = json.loads(crudo[ini:fin + 1])
    except json.JSONDecodeError as e:
        return False, "el objeto del modelo no es JSON: " + str(e)
    if not isinstance(obj, dict):
        return False, "el modelo no devolvio un objeto"

    return True, _normaliza(obj)


if __name__ == "__main__":
    ok, r = enrutar(" ".join(sys.argv[1:]))
    print(json.dumps(r, ensure_ascii=False, indent=2) if ok else "ERROR: " + str(r))
