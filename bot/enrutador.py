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
    # --- Fase 5, 2026-09-19. Las cuatro que faltaban para que el bot sea la
    # interfaz COMPLETA y no solo la de captura. Las tres primeras NO llevan
    # campos que identifiquen una fila: la fila se elige de una lista con
    # botones, por indice (D2). Dictar "anula el gasto de mil pesos" con dos
    # gastos de mil pesos es como se anula la fila equivocada.
    "anular",
    "corregir",
    "alta",
    "convertir",
    # --- 2026-09-19, D28/D29. "Si" y "no" DE LO QUE HAY EN PANTALLA.
    # Antes, un "sii" con una propuesta viva enfrente caia en `charla`: la lista
    # literal de `bot_gastos.py` acepta seis formas de decir que si y tres de
    # decir que no, y todo lo demas -- "ok", "sale", "va pues", "andale", "ya
    # quedo", "simon" -- se degradaba a conversacion. La lista literal se queda
    # (cuesta cero llamadas al modelo y es el camino rapido); lo que cambia es el
    # FALLO: lo que no esta en la lista lo resuelve el modelo **con la propuesta
    # a la vista**, en vez de contestar sobre otra cosa.
    "confirmar",
    "cancelar",
    "reporte",
    "charla",
)

# ---------------------------------------------------------------------------
# LAS CONSULTAS QUE DE VERDAD EXISTEN
# ---------------------------------------------------------------------------
# **Eran seis aqui y tres en el servidor.** El enrutador ofrecia `margen` y
# `lote`, `lib/bot-consultas.ts` solo conoce `stock`, `cartera` y `ventas`, y el
# endpoint contesta 422 a cualquier otra cosa. El resultado no era un error
# entendible: era que preguntar por el margen devolvia "Esa consulta no existe"
# despues de haber pagado la llamada al modelo.
#
# Ahora la lista del modelo es la MISMA lista cerrada del servidor, mas `otra`,
# que es el cajon honesto: el bot contesta diciendo que eso todavia no lo sabe
# consultar y QUE SI puede. Si algun dia el servidor aprende una consulta nueva,
# se agrega en los dos lados — `lib/bot-consultas.ts` manda, y lo que no empate
# se rechaza con 422, que es un fallo ruidoso.
CONSULTAS_QUE_CONTESTA = ("stock", "cartera", "ventas")
CONSULTAS = CONSULTAS_QUE_CONTESTA + ("otra",)

# El vocabulario de arranque del extractor de gastos. Vivia en `extraer.py`, que
# desde el 2026-09-19 ya no lo llama nadie (ver su cabecera). Es el MISMO que
# `CATALOGO_SEMILLA` de `lib/bot-gastos.ts`, duplicado a proposito porque Python
# no lee una constante de TypeScript. **No es autoridad**: en cuanto el servidor
# contesta la primera propuesta, manda `bot_categorias`.
CATEGORIAS_SEMILLA = (
    "Marketing_y_Relaciones",
    "Servicios_Basicos",
    "Logistica_Envios",
    "Nomina_y_Honorarios",
    "Gastos_Personales_Socio",
    "Insumos",
)

PROMPT = u"""Eres el asistente de Norman en su destileria de chile en Mexico:
ENTIENDES, CONTESTAS y CAPTURAS. Norman te escribe o te dicta notas de voz
mientras trabaja, y del otro lado no hay nadie mas: le hablas A EL, tuteandolo.

Hasta el 2026-09-19 este prompt decia "eres el enrutador... NO ejecutas nada", y
se notaba: devolvias una etiqueta y contestaba Python con noventa cadenas fijas.
Ahora tambien REDACTAS lo que se le dice. El dinero no: los montos, las
confirmaciones y los botones los sigue escribiendo Python, palabra por palabra.

Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:

{
  "intencion": una de: gasto | abono | venta | lote | consulta | cotizacion | anular | corregir | alta | convertir | confirmar | cancelar | reporte | charla,
  "consulta": si intencion es consulta, una de: stock | cartera | ventas | otra. Si no, null,
  "filtro": SOLO para consulta stock: el nombre propio que menciono (un producto O un punto de venta), tal cual lo dijo. Si no menciona ninguno, o la consulta no es stock, null,
  "entendido": frase MUY corta de lo que si entendiste. **ES TELEMETRIA: va al log, NUNCA a la pantalla.** Nunca vacia,
  "respuesta": QUE DECIRLE A NORMAN, en segunda persona, tuteandolo, UNA LINEA. Nunca hables de el en tercera persona. Nunca vacia,
  "campos": objeto con lo que lograste sacar del mensaje. Solo lo que DE VERDAD dijo,
  "faltantes": lista de los campos obligatorios que NO dijo,
  "pregunta": UNA sola pregunta corta para el faltante mas importante, o null si no falta nada,
  "otro_hecho": si el mensaje trae UN SEGUNDO hecho economico que NO cabe en la intencion que elegiste, {"tipo": gasto|abono|venta|lote|cotizacion, "monto": el numero si lo dijo o null, "descripcion": DE QUE es, en tres palabras}. Si el mensaje trae un solo hecho, null,
  "confianza": "alta" | "media" | "baja"
}

QUE ES CADA INTENCION
- gasto: salio dinero. Compras, pagos a proveedor, gasolina, viaticos.
  Campos: monto, descripcion, categoria, fecha.
- abono: un cliente o distribuidor le PAGO algo de lo que debia.
  Campos: deudor, monto, fecha.
- venta: se vendio producto. Entro dinero o se dejo a credito.
  Campos: productos (lista de {producto, cantidad, id_producto}), comprador, monto, condicion_pago (CONTADO o CONCESION), fecha,
  descuento.
- lote: se produjo. Fermentacion, kilos de chile, litros, grados, envasado.
  Campos: codigo_lote, kg_chile, dias_fermentacion, horas_fermentacion, tandas (lista de {litros, grado}), botellas.
- cotizacion: quiere un precio para un cliente ANTES de vender. "cotizale a", "cuanto le sale".
  Campos: productos (lista de {producto, cantidad, id_producto}), cliente, vigencia_dias,
  monto_objetivo, descuento.
  **monto_objetivo** es para cuando pide un TOTAL en vez de cantidades: "una de
  unos 15 mil", "que salga en 20,000", "lo mas cercano a 15,000 manteniendo la
  proporcion". Pon ahi el numero y **deja `productos` vacio**: el servidor escala
  la cotizacion anterior con los precios del catalogo. **Tu no calculas las
  cantidades ni los precios.**
  **descuento** (sirve igual en venta y en cotizacion) es para las promociones:
  {"porcentaje": el numero si dijo un porcentaje, "total_final": el numero si
  dijo en cuanto se lo deja, "motivo": como le llamo a la promocion o null}.
  "con 10% de descuento" -> {"porcentaje": 10}. "dejaselo en 5,000" ->
  {"total_final": 5000}. "promocion de septiembre, 15%" ->
  {"porcentaje": 15, "motivo": "promocion de septiembre"}.
  **Pon UNO SOLO de los dos numeros, nunca los dos**, y **no calcules nada**: ni
  el importe, ni el total, ni el porcentaje que sale de un total. El servidor
  saca la cuenta con los precios del catalogo y tiene un tope propio.
  Si no hubo descuento, no pongas el campo.
- consulta: pregunta por algo que ya esta en el sistema. No escribe nada.
  Campos: ninguno. Lo que menciona va en "filtro", no en "campos".
- anular: quiere DESHACER algo que ya se escribio. "cancela", "borra", "quitale",
  "ese gasto estuvo mal", "anula la venta de ayer".
  Campos: ninguno. NO intentes decir CUAL: el bot le ensena la lista y el escoge
  con un boton. Un movimiento identificado de oido se anula equivocado.
- corregir: quiere CAMBIAR algo que ya se escribio. "estaba mal el monto",
  "no eran 500 eran 1500", "cambiale el concepto".
  Campos: ninguno, por la misma razon que anular. Si dice el valor nuevo,
  ponlo en campos.valor_nuevo, pero NUNCA adivines de que fila habla.
- alta: quiere dar de alta a un distribuidor o a un local nuevo en la red.
  "da de alta a", "agrega el local", "abrimos punto de venta en".
  Campos: nombre, email, telefono, comision.
  **NUNCA pongas zona ni rol**: esos dos van por boton, porque un "Foraneo"
  transcrito con acento revienta contra el CHECK de la base.
- convertir: quiere volver VENTA una cotizacion que ya existe. "cerramos la
  cotizacion", "acepto el precio, hazlo venta", "convierte la COT-0007".
  Campos: folio, si lo dijo. Si no lo dijo, ninguno: se escoge con boton.
- confirmar: esta diciendo que SI a la propuesta que tiene en pantalla.
  **Solo existe si hay algo en pantalla.** Campos: ninguno.
- cancelar: esta diciendo que NO a lo que tiene en pantalla, o abandonando lo
  que estaba dictando. "olvidalo", "mejor no", "no nada", "ya no".
  Campos: ninguno. **No es lo mismo que "anular":** cancelar tira algo que
  todavia NO se ha escrito; anular deshace algo que YA se escribio.
- reporte: quiere el resumen del dia o del periodo.
- charla: saludo, agradecimiento, o algo que no cae en ninguna de las anteriores.

REGLAS QUE NO SE ROMPEN
1. NUNCA inventes un valor. Si no lo dijo, va en "faltantes". Un monto inventado
   se convierte en un movimiento de dinero falso.
2. "pregunta" es UNA sola, corta, por el faltante que mas bloquea. Nunca una
   lista. Nunca dos preguntas en una.
3. NUNCA le repitas de vuelta lo que ya entendiste. El ya lo dijo. Y NUNCA
   hables de Norman en tercera persona: "quiere anular" y "solo dijo que si"
   son telemetria, no conversacion. Se dice "?cual anulo?", no "quiere anular".
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
12. "anular", "corregir" y "convertir" NUNCA llevan faltantes ni pregunta. El
   bot ensena una lista con botones y la persona escoge; preguntarle "cual?"
   antes de ensenarle la lista es pedirle que recuerde un identificador, que es
   justo lo que este bot existe para no pedir.
13. DESHACER NO ES GASTAR. "cancela ese gasto" es intencion "anular", no
   "gasto". Y "corregir" no es capturar de nuevo: es cambiar algo que ya entro.
   Si la frase habla de algo que YA se escribio, no es una captura nueva.
14. EL PRODUCTO SE ESCOGE DE LA LISTA, NO SE INVENTA. Si abajo viene PRODUCTOS
   QUE SE VENDEN, pon en cada renglon el `id_producto` de la fila que le
   corresponde, copiado tal cual. La botella se nombra por su TAMANO: "750",
   "750 ml", "750ml", ".750", "3/4" y "la grande" son el mismo producto. Si de
   verdad no puedes decidir cual es, deja `id_producto` vacio y NO adivines: el
   servidor pregunta con botones. **Jamas escribas un id que no este en la lista.**
15. SI HAY ALGO EN PANTALLA, ESO ES DE LO QUE SE ESTA HABLANDO. Cuando abajo
   venga EN PANTALLA AHORA MISMO, un "si", "sii", "ok", "sale", "va pues",
   "andale", "ya quedo", "simon" o "correcto" es intencion "confirmar", y un
   "no", "nel", "olvidalo", "mejor no", "nada", "ya no" o "dejalo" es intencion
   "cancelar". **No los leas como charla: la propuesta esta enfrente.** Si NO
   viene nada en pantalla, un "si" suelto si es charla: no hay que confirmar.

16. **NUNCA PROMETAS NADA QUE VAYAS A HACER DESPUES.** No tienes cola, no
   tienes memoria de pendientes y no hay una sola linea de codigo que encole un
   movimiento para escribirlo mas tarde. El 2026-09-19, preguntado "?tienes
   pensado aplicar el envio como un gasto?", contestaste *"Si, el envio se
   captura como gasto en Logistica_Envios, y no importa en que orden lo hagas"*
   **y ese gasto no se escribio nunca.** Norman solo lo supo porque volvio a
   preguntar.
   **Solo puedes hablar en PASADO de lo que ya quedo escrito**, y de eso ya se
   encarga Python con sus propias frases. De lo que no se ha escrito se habla en
   presente y en negativo: "eso no lo he escrito; dimelo y lo capturo".
   Prohibido: "se captura", "queda registrado", "lo voy a meter", "se aplica",
   "ahorita lo hago", "no importa en que orden".
   **Un bot que dice "no puedo" es util. Un bot que dice "si" y no lo hace
   obliga a auditar cada respuesta.**

17. **SI EL MENSAJE TRAE DOS HECHOS ECONOMICOS, EL SEGUNDO NO SE TIRA.** Es el
   otro lado de la regla 16, y es el mismo incidente: *"Se acaba de vender una
   botella grande de 599 pesos, lo enviamos a domicilio y nosotros absorbimos el
   costo del envio y de envio fueron 45 pesos"* son **una venta de $599 y un
   gasto de $45**. Escoge como "intencion" el hecho principal --el que trae mas
   datos-- y pon el otro en "otro_hecho". El bot le dira a Norman que lo oyo y
   que NO lo escribio. **Nunca pongas en "otro_hecho" el mismo hecho de la
   intencion**: si el mensaje trae un solo hecho, es null.

18. **EL DESCUENTO LO DICTAS, NO LO CALCULAS.** Norman lo pidio: *"en ocasiones
   vamos a poner promociones, mi pregunta es si las podemos meter por medio de
   este bot"*. Tu trabajo aqui termina en copiar el numero que dijo dentro de
   "descuento". **No multipliques, no restes, no conviertas un total en un
   porcentaje ni al reves.** Un descuento mal calculado es dinero regalado, y el
   sello no lo atrapa porque el sello congela lo que Norman vio -- y lo que
   Norman ve es TU numero. El servidor hace la cuenta con los precios del
   catalogo, ensena las dos cifras (lista y cobrado) y tiene un tope duro:
   arriba de ese tope no escribe nada, por mas que tu lo hayas propuesto.

19. **SI SE REFIERE AL CLIENTE ANTERIOR SIN NOMBRARLO, COPIA LA FRASE TAL CUAL.**
   *"cotizame para el mismo cliente 35 grandes"*, *"ahora al mismo 20 grandes"*,
   *"para el mismo distribuidor 5 grandes"*, *"cotizale otra vez al anterior"*.
   En esos casos "cliente" **NO es null**: vale exactamente la forma corta que
   uso, sin nada mas -- **"el mismo cliente"**, **"el mismo"**, **"al mismo"**,
   **"el anterior"** o **"el de antes"**. El bot tiene guardado el ultimo cliente
   de este chat, lo resuelve el, y lo dice en voz alta; si no lo tiene, pregunta.
   **Tu no adivines el nombre: nunca pongas en "cliente" un nombre que Norman no
   haya dicho.** Esto es lo que fallo delante de el el 2026-09-19: habia cotizado
   a Aeropuerto tres mensajes antes, dijo *"para el mismo cliente"*, y el campo
   se fue en null -- asi que el bot tiro el dato que si tenia y volvio a
   preguntar.

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


def _linea_de_producto(p):
    """Una fila del catalogo, con su tamano a la vista.

    El tamano va porque es lo UNICO que distingue a los tres destilados entre
    si, y porque es como Norman los nombra: "750 ml", "las grandes", "las mini".
    """
    ml = p.get("ml_por_unidad")
    tamano = (" | " + str(int(float(ml))) + " ml") if ml else ""
    return "  " + str(p.get("id")) + " = " + str(p.get("nombre")) + tamano


def _pedazo_contexto(borrador, catalogo, deudores, productos=None, en_pantalla=None):
    """Lo que el modelo necesita saber del mundo, y nada mas.

    **Lo que faltaba y costo la conversacion del 2026-09-19 (D35):** el catalogo
    de productos. Al modelo se le mandaba el borrador, las categorias de gasto y
    los deudores; **de lo que se vende, nada**. Extraia el nombre del producto a
    ciegas y el empate lo hacia despues un comparador literal de TypeScript, que
    se rompe con un espacio de mas. Son tres filas: cabe de sobra y no encarece.

    **Y lo segundo que faltaba (D28):** que hay EN PANTALLA ahora mismo. Sin eso,
    un "sii" con una propuesta viva enfrente llega al modelo sin nada contra que
    interpretarlo, y sale `charla`. Con el ultimo turno basta -- no hace falta
    historial largo, y ahi esta lo barato.
    """
    partes = []
    if en_pantalla:
        partes.append("EN PANTALLA AHORA MISMO (es de esto de lo que se esta hablando):")
        partes.append("  " + str(en_pantalla))
    if borrador:
        partes.append("BORRADOR A MEDIAS (completalo con el mensaje nuevo):")
        partes.append(json.dumps(borrador, ensure_ascii=False))
    if productos:
        partes.append("PRODUCTOS QUE SE VENDEN (id = nombre | tamano). "
                      "Copia el id tal cual en `id_producto`; no inventes ninguno:")
        for prod in productos:
            if isinstance(prod, dict) and prod.get("id"):
                partes.append(_linea_de_producto(prod))
    if catalogo:
        partes.append("CATEGORIAS DE GASTO QUE EXISTEN: " + ", ".join(sorted(catalogo)))
    if deudores:
        partes.append("QUIENES DEBEN HOY: " + ", ".join(deudores))
    if not partes:
        return ""
    return "\n".join(partes) + "\n\n"


# Los tipos de hecho economico que el bot sabe capturar. **Lista cerrada**, por
# la misma razon que `INTENCIONES`: un tipo que no esta aqui no se menciona.
TIPOS_DE_HECHO = ("gasto", "abono", "venta", "lote", "cotizacion")


def _normaliza_otro_hecho(crudo, intencion):
    """El SEGUNDO hecho economico del mensaje, o `None`. **D49.**

    ─── QUE PROBLEMA CIERRA ────────────────────────────────────────────────
    *"Se acaba de vender una botella grande de 599 pesos... y de envio fueron 45
    pesos"* son dos hechos: una venta y un gasto. Hasta el 2026-09-19 el segundo
    **se perdia en silencio**, y ese silencio era el defecto -- Norman solo lo
    descubrio porque pregunto. Verificado contra `finanzas_ledger`: la fila de
    $45 no existe.

    ─── LO QUE NO HACE, Y ES DELIBERADO ────────────────────────────────────
    **No encola nada.** Devuelve un dato para que el bot lo DIGA. Escribir dos
    movimientos de un solo "va" iria contra el diseno entero de sellos: entre lo
    que Norman lee y lo que se escribe no puede haber un renglon que el no vio.

    ─── POR QUE SE RECHAZA `tipo == intencion` ─────────────────────────────
    Porque no hay forma de distinguir un segundo hecho de verdad ("vendi una a
    Juan y otra a Pedro") del ECO del primero, y el eco es el error caro: el bot
    escribiria la venta y acto seguido diria *"tambien oi una venta de $599 que
    no escribi"* sobre la que acaba de escribir. Eso es una mentira nueva en la
    direccion contraria, y arreglar una mentira con otra no es un arreglo.
    """
    if not isinstance(crudo, dict):
        return None
    tipo = str(crudo.get("tipo") or "").strip().lower()
    if tipo not in TIPOS_DE_HECHO or tipo == intencion:
        return None
    descripcion = " ".join(str(crudo.get("descripcion") or "").split())[:80]
    if not descripcion:
        # Sin descripcion no hay nada que decirle a Norman que el pueda
        # reconocer, y "oi algo mas" es peor que callarse.
        return None
    monto = crudo.get("monto")
    try:
        monto = float(monto)
    except (TypeError, ValueError):
        monto = None
    if monto is not None and not (monto > 0):
        monto = None
    return {"tipo": tipo, "monto": monto, "descripcion": descripcion}


# Lo mas alto que puede valer un `total_final` dictado. Es el mismo orden de
# magnitud que `TOPE_VENTA` del lado de TypeScript; aqui solo sirve para tirar
# basura obvia antes de que viaje. **El tope de verdad --el del PORCENTAJE-- no
# esta aqui: esta en la ruta** (`lib/bot-descuento.ts`), porque un tope que vive
# en el proceso del bot lo puede saltar cualquiera que le hable al endpoint.
TOPE_TOTAL_DICTADO = 1000000


def _normaliza_descuento(crudo):
    """El descuento dictado, o `None`. **D55.**

    ─── LO QUE VALIDA, Y LO QUE NO ─────────────────────────────────────────
    Valida la FORMA: que sea un objeto, que traiga un numero positivo, que no
    traiga los dos numeros a la vez, que el motivo sea texto corto.

    **No valida el tope y no hace ninguna cuenta.** Las dos cosas son de
    `aplicarDescuento` en la ruta, y estan alla por la misma razon por la que el
    `id_producto` se revalida contra el catalogo aunque el modelo lo haya
    escogido de una lista: **el proceso del bot no es la autoridad sobre el
    dinero.** Un tope duplicado aqui daria la falsa sensacion de que basta con
    este, y el dia que alguien le hable al endpoint por fuera no habria ninguno.

    Los dos numeros a la vez se tiran ENTEROS y no se escoge uno: un
    `porcentaje` y un `total_final` que no concuerdan son el sintoma exacto del
    modelo calculando --que es justo lo que la regla 18 le prohibe--, y quedarse
    con el que a uno le guste seria elegir por Norman a ciegas.
    """
    if not isinstance(crudo, dict):
        return None

    def numero(valor):
        if valor is None or valor == "":
            return None
        try:
            n = float(valor)
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    porcentaje = numero(crudo.get("porcentaje"))
    total_final = numero(crudo.get("total_final"))
    if porcentaje is not None and total_final is not None:
        return None
    if porcentaje is None and total_final is None:
        return None
    if total_final is not None and total_final > TOPE_TOTAL_DICTADO:
        return None

    salida = {}
    if porcentaje is not None:
        salida["porcentaje"] = porcentaje
    if total_final is not None:
        salida["total_final"] = total_final
    motivo = " ".join(str(crudo.get("motivo") or "").split())[:60]
    if motivo:
        salida["motivo"] = motivo
    return salida


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

    # El filtro solo significa algo en `stock`, igual que en el servidor
    # (`app/api/bot/consulta/route.ts` lo prueba contra el producto Y contra el
    # punto de venta). La lista cerrada se aplica AQUI tambien y no solo alla:
    # un filtro colgado de `cartera` viajaria hasta el endpoint para que lo
    # ignore, y un dato que viaja para ser ignorado acaba usandose algun dia.
    filtro = obj.get("filtro")
    filtro = str(filtro).strip()[:60] if filtro else None
    if consulta != "stock":
        filtro = None

    campos = obj.get("campos")
    if not isinstance(campos, dict):
        campos = {}

    # D55: el descuento se criba aqui para que lo que viaje al endpoint tenga
    # forma conocida. Si no pasa la criba **se borra el campo**, no se deja a
    # medias: un descuento con la mitad de los datos es peor que ninguno.
    descuento = _normaliza_descuento(campos.get("descuento"))
    if descuento:
        campos["descuento"] = descuento
    else:
        campos.pop("descuento", None)

    faltantes = obj.get("faltantes")
    if not isinstance(faltantes, list):
        faltantes = []
    faltantes = [str(f) for f in faltantes if f]

    pregunta = obj.get("pregunta")
    pregunta = str(pregunta).strip() if pregunta else None

    # D44 (Fase 6): **el default es el RESTRICTIVO.** Hasta hoy un modelo que no
    # declaraba `confianza` -- o que la declaraba con basura -- quedaba en
    # "media", que es justo el valor que la guarda de `bot_gastos.py` deja
    # pasar. O sea: el unico caso en el que de verdad no sabemos que tan seguro
    # estaba el modelo era el caso que autorizaba escribir dinero.
    #
    # **Un modelo que no se compromete no autoriza una escritura.** El costo de
    # equivocarse hacia "baja" es una pregunta de mas; hacia "media", una fila
    # de dinero que hay que anular.
    confianza = str(obj.get("confianza") or "baja").strip().lower()
    if confianza not in ("alta", "media", "baja"):
        confianza = "baja"

    # Una pregunta sin faltantes no tiene a quien contestarle, y unos faltantes
    # sin pregunta dejan a Norman esperando. Se arregla aqui y no en el prompt,
    # porque un prompt se puede desobedecer y esto no.
    if faltantes and not pregunta:
        pregunta = "Me falta " + faltantes[0] + ". Me lo dices?"
    if pregunta and not faltantes:
        faltantes = ["dato"]

    # D27: lo que el modelo REDACTA para Norman. Se recorta a una linea aqui y
    # no en el prompt, porque un prompt se puede desobedecer y esto no. Puede
    # salir vacio: entonces contesta la cadena de Python, que es el caso seguro.
    respuesta = obj.get("respuesta")
    respuesta = " ".join(str(respuesta).split())[:400] if respuesta else ""

    return {
        "intencion": intencion,
        "consulta": consulta,
        "filtro": filtro,
        # **`entendido` es TELEMETRIA y no sale a pantalla nunca** (D26). Se
        # queda porque sirve para depurar el log; lo que se le DICE a Norman
        # es `respuesta`.
        "entendido": str(obj.get("entendido") or "").strip(),
        "respuesta": respuesta,
        "campos": campos,
        "faltantes": faltantes,
        "pregunta": pregunta,
        # D49: el segundo hecho economico del mensaje, ya validado contra la
        # lista cerrada. `None` cuando el mensaje trae uno solo.
        "otro_hecho": _normaliza_otro_hecho(obj.get("otro_hecho"), intencion),
        "confianza": confianza,
    }


def enrutar(texto, borrador=None, catalogo=None, deudores=None,
            productos=None, en_pantalla=None):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo.

    `borrador` es lo que ya se sabia de una captura a medias. Si viene, el
    mensaje nuevo lo COMPLETA en vez de empezar de cero: eso es lo que hace que
    una conversacion de tres mensajes termine en un solo movimiento y no en tres
    intentos fallidos.
    """
    if not str(texto or "").strip():
        return False, "mensaje vacio"

    entrada = (PROMPT
               + _pedazo_contexto(borrador, catalogo, deudores, productos, en_pantalla)
               + str(texto).strip())

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
