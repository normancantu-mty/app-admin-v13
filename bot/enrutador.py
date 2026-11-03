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
import re
import shutil
import subprocess
import claude_cli  # auditoria IA E1: minimo privilegio
import sys
import unicodedata

import tope  # Cazador F0 (item 6): el limite de la suscripcion

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
    # --- Fase 8 (D74), 2026-09-22. Cambiar UN dato de la propuesta que esta en
    # pantalla sin volver a dictarla: "fue venta a concesion". Hasta hoy eso se
    # leia como una venta nueva a medias y REEMPLAZABA a la propuesta, y Norman
    # tuvo que re-pegar todo (log 2026-09-22 09:33-09:39).
    "ajustar",
    "reporte",
    # --- Cazador F0 (WP-9a), 2026-10-17. Una OBSERVACION que se guarda y no
    # mueve nada: va a la bitacora con etiquetas (lote, persona, cliente).
    # No esta en TIPOS_DE_HECHO a proposito: no escribe ninguna fila del ERP.
    "nota",
    # --- 2026-11-03. Agregar una categoria/subcategoria a la lista cerrada
    # (`categorias_movimiento`). Escribe: propone y espera el clic de Norman.
    "categoria",
    "charla",
)

# D78 (Fase 8): cuantos hechos que escriben se aceptan de un solo mensaje. Mas
# que esto no es un mensaje, es una captura masiva, y se le dice.
MAX_HECHOS = 5

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
# Fase 8 (D83): `produccion` -- cuantas botellas se envasaron (hoy, ayer,
# semana, mes o un lote). `tests/bot-enrutador.spec.ts` compara esta tupla
# contra `CONSULTAS` de `lib/bot-consultas.ts`.
CONSULTAS_QUE_CONTESTA = ("stock", "cartera", "ventas", "produccion", "precios", "gastos")
CONSULTAS = CONSULTAS_QUE_CONTESTA + ("otra",)

# ---------------------------------------------------------------------------
# D65 (Fase 7): EL VOCABULARIO QUE CRUZA LA FRONTERA VIVE EN UN SOLO LUGAR
# ---------------------------------------------------------------------------
# Todo valor que el PROMPT le pide al modelo que ESCRIBA y que el codigo luego
# COMPARA es un contrato entre dos lectores: el modelo (lee prosa) y Python (lee
# esta tupla). Hasta la Fase 6 cada lado tenia su copia, escrita por dos manos,
# y nada las amarraba: `probar_promesas.py` paso verde toda la Fase 6 con la
# regla 19 ausente del PROMPT (auditoria §12.4). Ahora el PROMPT se ARMA con
# estas tuplas (`_armar_prompt`, abajo): cambiar una cambia los dos lados.
NIVELES_DE_CONFIANZA = ("alta", "media", "baja")

# Regla 19: las formas cortas con que Norman se refiere al cliente anterior. El
# modelo las copia TAL CUAL en `campos.cliente`, y `bot_gastos._dice_el_mismo`
# las reconoce. El bot acepta ademas variantes (su expresion regular), pero
# ESTAS tienen que empatar siempre: `probar_promesas.py` lo comprueba una por una.
FORMAS_DEL_MISMO = ("el mismo cliente", "el mismo", "al mismo", "el anterior",
                    "el de antes")

# Regla 20 / D63: lo UNICO que es un "si" explicito. De aqui salen el texto de
# la regla 20 (lo que se le pide al modelo) y `es_afirmacion_explicita` (lo que
# el bot comprueba por su cuenta antes de dejar que `confirmar` escriba).
AFIRMACIONES_EXPLICITAS = ("va", "si", "sii", "dale", "escribelo", "escribela",
                           "confirmalo", "confirmala", "confirmado", "correcto")
_SEPARADORES = re.compile(r"[\s,.;:!]+")


def es_afirmacion_explicita(texto):
    """True si el mensaje esta hecho SOLO de `AFIRMACIONES_EXPLICITAS`. **Pura.**

    Sin mayusculas ni acentos ("Sí" es "si"); comas, puntos y "!" separan y no
    cuentan. **Un "?" o un "¿" lo tumba**: "va?" pregunta, no autoriza. Una
    palabra de mas tambien ("ahi va", "ps va", "mmm va"): cuesta un toque de
    mas, y lo contrario cuesta una fila de dinero que nadie decidio.
    """
    t = unicodedata.normalize("NFD", str(texto or "").strip().lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    if not t or "?" in t or "\u00bf" in t:
        return False
    palabras = [p for p in _SEPARADORES.split(t) if p]
    return bool(palabras) and all(p in AFIRMACIONES_EXPLICITAS for p in palabras)

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
ENTIENDES, CONTESTAS y CAPTURAS. Casi siempre te escribe Norman, en privado,
mientras trabaja: le hablas A EL, tuteandolo. Pero tambien estas en GRUPOS de
Telegram con varias personas (Kevin, distribuidores): entonces el contexto trae
"QUIEN TE ESCRIBE" y le hablas A ESA PERSONA, tuteandola, nunca como si fuera
Norman. En el historial de un grupo cada turno dice quien lo dijo.

Hasta el 2026-09-19 este prompt decia "eres el enrutador... NO ejecutas nada", y
se notaba: devolvias una etiqueta y contestaba Python con noventa cadenas fijas.
Ahora tambien REDACTAS lo que se le dice. El dinero no: los montos, las
confirmaciones y los botones los sigue escribiendo Python, palabra por palabra.

Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:

{
  "intencion": una de: <<INTENCIONES>>. Si el mensaje trae hechos (ver "hechos"), la del PRIMERO,
  "consulta": si intencion es consulta, una de: <<CONSULTAS>>. Si no, null,
  "filtro": SOLO para consulta stock, cartera, produccion, precios o gastos. En gastos, la categoria o concepto por el que pregunta ("gasolina", "insumos"), tal cual lo dijo. En stock y cartera, el nombre propio que menciono, tal cual lo dijo (en stock, un producto O un punto de venta; en cartera, quien debe). En produccion, el periodo -- "hoy", "ayer", "semana" o "mes" -- o el codigo del lote tal cual lo dijo. En precios, el distribuidor o punto de venta por el que pregunta, tal cual lo dijo. Si no menciona ninguno, o es otra consulta, null,
  "entendido": frase MUY corta de lo que si entendiste. **ES TELEMETRIA: va al log, NUNCA a la pantalla.** Nunca vacia,
  "respuesta": QUE DECIRLE A QUIEN TE ESCRIBE (Norman, salvo que el contexto diga otro nombre), en segunda persona, tuteandolo, UNA LINEA. Nunca hables de el en tercera persona. Nunca vacia,
  "campos": objeto con lo que lograste sacar del mensaje. Solo lo que DE VERDAD dijo. Si hay hechos, los del primero,
  "faltantes": lista de los campos obligatorios que NO dijo,
  "pregunta": UNA sola pregunta corta para el faltante mas importante, o null si no falta nada,
  "hechos": la LISTA de los hechos que ESCRIBEN (<<TIPOS_DE_HECHO>>) que trae el mensaje, en el orden en que los dijo, maximo <<MAX_HECHOS>>. Cada uno es {"intencion", "campos", "faltantes", "pregunta", "confianza"}, con el mismo significado que arriba pero SOLO de ese hecho. Un mensaje con un solo hecho es una lista de UNO. Si la intencion no es de esas, [],
  "confianza": <<NIVELES>>
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
  Campos: codigo_lote, kg_chile, dias_fermentacion, horas_fermentacion, tandas (lista de {litros, grado}), botellas, formato.
  **formato** es el tamano de la botella en ml: "750", "250" o "50". Asi se nombran: "la grande" = "750", "la chica" / "las chicas" = "250", "la mini" / "las minis" = "50". Si no lo dijo, no lo pongas: el servidor pregunta.
  **Envasar tambien es lote**: "hoy envasamos 24 de 750", "del lote L-0915 salieron 40 de 250". Si no dice el codigo, el servidor lo busca.
  **Una lectura de fermentacion tambien es lote**: "tanque 2 va en el dia 5, 4.5 brix", "el tambo 1 ya lleva 3 dias",
  "revise el L-1012, dia 9, grado 3.2". El dia va en dias_fermentacion y el brix o grado en tandas ({"grado": ...}, sin litros si no los dijo).
  "tanque" y "tambo" son lo mismo: donde fermenta. **La temperatura NO es campo del lote** (sale sola del clima): si la dice,
  no la pongas en campos, y NO conviertas por eso la lectura en nota. Si ademas trae una observacion ("huele bien",
  "se subio la temperatura"), esa va como un segundo hecho: nota.
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
  "cuantas botellas se hicieron hoy", "cuanto envasamos esta semana", "que salio del lote L-0915" es consulta "produccion".
  "a como le sale a Aeropuerto", "que precio tiene Casa Verde", "precios", "a como damos la grande" es consulta "precios":
  pregunta el PRECIO de lista, sin cantidades. Si trae cantidades o dice "cotizale", es cotizacion, no consulta.
  "cuantas botellas quedan", "que hay en inventario", "cuanto tenemos de la grande" es consulta "stock".
  "cuanto llevamos gastado", "gastos del mes", "cuanto se ha ido en gasolina" es consulta "gastos": pregunta,
  no reporta un gasto. Si dice que GASTO algo ("gaste 300 de gasolina"), es gasto, no consulta.
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
- ajustar: CAMBIA un dato de la propuesta que esta EN PANTALLA, todavia sin
  escribir. "fue venta a concesion", "eran 3, no 2", "el monto es 450".
  **Solo existe si hay una propuesta en pantalla.** Ver la regla 22.
- reporte: quiere el resumen del dia o del periodo.
- nota: una OBSERVACION que hay que guardar y que NO mueve dinero ni
  inventario: "el lote 7 salio mas picoso", "el de ayer quedo mas clarito",
  "a Casa Verde le gusto la chica", "Kevin dice que el tambo 2 huele raro".
  Campos: lote (el codigo o numero tal cual lo dijo), persona (de quien habla o
  quien lo dijo, si lo nombra), cliente (si habla de uno), tema (3 a 6 palabras).
  Pon solo los que de verdad dijo. **Una nota no escribe nada**: si el mensaje
  trae ademas un gasto, venta, abono o lote, es ESE hecho (va en "hechos"). Un
  "gracias" es charla, no nota.
- categoria: quiere AGREGAR una categoria o subcategoria a la lista de categorias
  de gastos (o de ingresos). "agrega la subcategoria Diesel en Logistica",
  "crea la categoria Mantenimiento de planta con subcategoria Soldadura",
  "agrega Fumigacion a Servicios". NO es un gasto: no trae monto.
  Campos: categoria (la de arriba, tal cual la dijo), subcategoria (la nueva,
  tal cual la dijo), tipo ("INGRESO" solo si dijo que es de ingresos; si no, no
  pongas el campo). Si falta la subcategoria, pregunta cual.
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
   monto, un abono sin deudor o sin monto, una venta sin producto o sin monto.
   **Un lote no tiene nada obligatorio** (Fase 8): se abre con lo que diga
   (codigo, dias u horas de fermentacion, chile, tandas, botellas) y lo que no
   se sabe al abrirlo se agrega despues con su codigo. Envasar tampoco pide
   nada mas. Todo lo demas se guarda vacio y se corrige despues.
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
   **Que sea "confirmar" no quiere decir que sea "alta"**: eso lo decide la
   regla 20.

16. **NUNCA PROMETAS NADA QUE VAYAS A HACER DESPUES.** Tu no escribes nada, y
   no hay una sola linea de codigo que escriba un movimiento mas tarde sin que
   Norman le de VA a su propuesta. Lo que va a pasar lo dice el bot, no tu. El 2026-09-19, preguntado "?tienes
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

17. **SI EL MENSAJE TRAE VARIOS HECHOS QUE ESCRIBEN, VAN TODOS EN "hechos".**
   Es el otro lado de la regla 16, y es el mismo incidente: *"Se acaba de vender
   una botella grande de 599 pesos, lo enviamos a domicilio y nosotros
   absorbimos el costo del envio y de envio fueron 45 pesos"* son **dos hechos:
   una venta de $599 y un gasto de $45** -> "hechos" trae los dos, cada uno con
   sus propios campos y faltantes. El bot propone cada uno aparte, con su boton
   VA: nada se escribe sin que Norman lo vea. El 2026-09-19 el segundo solo se
   anuncio, no se escribio, y al volver a dictarlo salio una venta DUPLICADA.
   **Nunca pongas el mismo hecho dos veces** (el eco): la venta de $599 dicha
   con otras palabras dentro de la misma frase es UNA venta. **Y no inventes un
   segundo**: si el mensaje trae un solo hecho, la lista es de uno. Dos ventas
   son dos solo si son dos cosas distintas ("una a Juan y otra a Pedro").
   Consulta, charla, reporte, confirmar, cancelar, ajustar, anular, corregir,
   alta y convertir NO van en la lista: esas son una sola respuesta.

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
   uso, sin nada mas -- <<FORMAS_DEL_MISMO>>. El bot tiene guardado el ultimo cliente
   de este chat, lo resuelve el, y lo dice en voz alta; si no lo tiene, pregunta.
   **Tu no adivines el nombre: nunca pongas en "cliente" un nombre que Norman no
   haya dicho.** Esto es lo que fallo delante de el el 2026-09-19: habia cotizado
   a Aeropuerto tres mensajes antes, dijo *"para el mismo cliente"*, y el campo
   se fue en null -- asi que el bot tiro el dato que si tenia y volvio a
   preguntar.

20. **"confianza" DICE CUANTAS LECTURAS CABEN, NO QUE TAN BIEN TE SALIO.**
   - "alta": el mensaje dice la intencion sin ambiguedad; no cabe otra
     lectura. Ej.: *"Se vendio una botella grande de 599 pesos"* -> venta.
   - "media": hay una lectura dominante, pero cabe otra. Ej.: *"y la deuda?"*
     -> consulta (puede ser la cartera entera o la de un solo cliente).
   - "baja": no se puede decidir. Ej.: *"sii"* sin nada en pantalla -> charla
     (dice que si, pero no a que).
   **Y "confirmar" tiene su propia vara, porque es el unico paso que ESCRIBE
   dinero:** solo es "alta" si el mensaje esta hecho SOLO de estas palabras,
   sueltas o juntas ("si, dale"): <<AFIRMACIONES>>. **Todo lo demas que leas
   como "confirmar" es "media" o menos**: una palabra de mas o una muletilla
   delante, un signo de interrogacion, las de la regla 15 que no estan en esa
   lista ("ok", "sale", "andale", "simon", "ya quedo"), una pregunta, un
   agradecimiento. El bot aplica la misma regla por su cuenta, con la misma
   lista: un "alta" que no la cumpla no escribe. No es desconfianza de
   Norman: con "media" el bot
   le vuelve a ensenar la propuesta y le pide el VA, y eso cuesta un toque. Un
   "ok pues" leido como si fuera un VA cuesta una fila de dinero que nadie
   decidio.

21. **LO QUE SE DIJO ANTES ES PASADO.** Si abajo viene LO QUE SE DIJO ANTES, ya
   se atendio. Sirve SOLO para saber DE QUIEN o DE QUE se habla cuando el
   mensaje no lo dice: *"cuanto me debe aeropuerto"* y luego *"y la deuda?"* ->
   consulta cartera con filtro "Aeropuerto". **Montos, cantidades y productos
   salen SOLO del mensaje actual, del borrador a medias o de lo que esta en
   pantalla, NUNCA de lo que se dijo antes**: si antes se hablo de una botella
   de $599 y ahora dice *"vendi una chica"*, la venta nueva NO lleva $599. Si el
   mensaje actual contradice lo de antes, manda el mensaje actual.

22. **UNA CORRECCION A LO QUE ESTA EN PANTALLA SE SUMA, NO EMPIEZA DE CERO.** Si
   en pantalla hay una propuesta esperando su VA y el mensaje CAMBIA un dato de
   ella -- *"fue venta a concesion"*, *"eran 3, no 2"*, *"a nombre de
   Delirio"*, *"el monto es 450"* -- la intencion es "ajustar". En "campos" van
   SOLO los datos que cambian, con los nombres de campo de esa intencion
   (venta: condicion_pago, comprador, productos, monto, descuento; gasto:
   monto, descripcion, categoria; abono: deudor, monto; cotizacion: cliente,
   productos, vigencia_dias, descuento), mas "sobre": el tipo de la propuesta
   que cambias (uno de los de "hechos"). El bot conserva todo lo demas y la
   vuelve a ensenar con su boton. **Un hecho NUEVO no es "ajustar"** (otra
   venta, otro gasto): es su intencion de siempre.

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
    return claude_cli.comando(claude_cli.SONNET, ruta)


def _linea_de_producto(p):
    """Una fila del catalogo, con su tamano a la vista.

    El tamano va porque es lo UNICO que distingue a los tres destilados entre
    si, y porque es como Norman los nombra: "750 ml", "las grandes", "las mini".
    """
    ml = p.get("ml_por_unidad")
    tamano = (" | " + str(int(float(ml))) + " ml") if ml else ""
    return "  " + str(p.get("id")) + " = " + str(p.get("nombre")) + tamano


def _pedazo_historial(historial):
    """D73 (Fase 8): los turnos anteriores de ESTE chat, marcados como pasado.

    `historial` es una lista de `(hace_min, dijo, contesto)`, del mas viejo al
    mas nuevo, ya recortada por el bot (15 turnos, 30 minutos). Va ANTES de lo
    que esta en pantalla y del mensaje, y con la regla 21 del PROMPT encima: de
    aqui solo se saca DE QUIEN se habla, nunca un monto.
    """
    if not historial:
        return []
    partes = ["LO QUE SE DIJO ANTES EN ESTE CHAT (PASADO: ya se atendio; solo sirve "
              "para saber de quien o de que se habla; montos y cantidades NO salen de aqui):"]
    for turno in historial:
        # D100 (Fase 9): en un grupo el turno trae, en cuarta posicion, QUIEN lo
        # dijo. En privado son tres y quien habla es Norman.
        hace, dijo, contesto = turno[:3]
        quien = (turno[3] if len(turno) > 3 else None) or "Norman"
        cuando = "hace %d min" % int(hace) if hace >= 1 else "hace un momento"
        partes.append("  [%s] %s: %s" % (cuando, quien, " ".join(str(dijo or "").split())[:300]))
        if contesto:
            partes.append("  [%s] Bot: %s" % (cuando, " ".join(str(contesto).split())[:300]))
    return partes


def _pedazo_contexto(borrador, catalogo, deudores, productos=None, en_pantalla=None,
                     historial=None, hablante=None):
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
    if hablante:
        # D100 (Fase 9): solo en un grupo. En privado no se agrega nada y el
        # contexto queda identico al de siempre.
        partes.append("QUIEN TE ESCRIBE: " + str(hablante) + " (es un GRUPO de Telegram con "
                      "varias personas; le hablas a " + str(hablante) + ").")
    partes += _pedazo_historial(historial)
    if en_pantalla:
        # D74 (Fase 8): trae el CONTENIDO (lo que Norman ve), no solo el tipo,
        # y puede ser mas de una propuesta: una por renglon.
        partes.append("EN PANTALLA AHORA MISMO (es de esto de lo que se esta hablando):")
        for renglon in str(en_pantalla).splitlines():
            if renglon.strip():
                partes.append("  " + renglon.strip())
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


def _enumera(piezas):
    """"a", "b" o "c" -- como se enumera en prosa."""
    piezas = list(piezas)
    return piezas[0] if len(piezas) == 1 else ", ".join(piezas[:-1]) + " o " + piezas[-1]


def _armar_prompt(plantilla):
    """D65: pone en el PROMPT el vocabulario de las tuplas. **Falla al importar**
    si una marca no esta exactamente una vez o si queda alguna sin llenar: un
    PROMPT mal armado no arranca el bot, en vez de arrancar mintiendo."""
    piezas = (
        ("<<INTENCIONES>>", " | ".join(INTENCIONES)),
        ("<<CONSULTAS>>", " | ".join(CONSULTAS)),
        ("<<TIPOS_DE_HECHO>>", _enumera(TIPOS_DE_HECHO)),
        ("<<MAX_HECHOS>>", str(MAX_HECHOS)),
        ("<<NIVELES>>", " | ".join('"%s"' % n for n in NIVELES_DE_CONFIANZA)),
        ("<<FORMAS_DEL_MISMO>>", _enumera('**"%s"**' % f for f in FORMAS_DEL_MISMO)),
        ("<<AFIRMACIONES>>", _enumera('"%s"' % a for a in AFIRMACIONES_EXPLICITAS)),
    )
    for marca, texto in piezas:
        if plantilla.count(marca) != 1:
            raise RuntimeError("PROMPT mal armado: %s aparece %d veces"
                               % (marca, plantilla.count(marca)))
        plantilla = plantilla.replace(marca, texto)
    if "<<" in plantilla:
        raise RuntimeError("PROMPT mal armado: queda una marca sin llenar")
    return plantilla


PROMPT = _armar_prompt(PROMPT)


# ─── D78 (Fase 8): LA LISTA DE HECHOS ───────────────────────────────────────
#
# Hasta la Fase 7 el contrato era UNA intencion + un `otro_hecho` que solo se
# ANUNCIABA ("lo oi y no lo escribi", D49). El 2026-09-19 eso termino en el envio
# de $45 sin escribir y, al re-pegarlo, en una venta duplicada. Ahora el modelo
# devuelve `hechos`: cada hecho que escribe con sus campos, y el bot propone cada
# uno por su ruta, con su borrador y su boton VA (D79). **Sigue sin haber un solo
# renglon que se escriba sin que Norman lo vea**: la frontera del sello no cambia.


def _normaliza_confianza(valor):
    """D44: el default es el RESTRICTIVO. Un modelo que no se compromete no
    autoriza una escritura."""
    confianza = str(valor or "baja").strip().lower()
    return confianza if confianza in NIVELES_DE_CONFIANZA else "baja"


def _normaliza_faltantes_y_pregunta(faltantes, pregunta):
    """Una pregunta sin faltantes no tiene a quien contestarle, y unos faltantes
    sin pregunta dejan a Norman esperando. Se arregla aqui y no en el prompt,
    porque un prompt se puede desobedecer y esto no."""
    if not isinstance(faltantes, list):
        faltantes = []
    faltantes = [str(f) for f in faltantes if f]
    pregunta = str(pregunta).strip() if pregunta else None
    if faltantes and not pregunta:
        pregunta = "Me falta " + faltantes[0] + ". Me lo dices?"
    if pregunta and not faltantes:
        faltantes = ["dato"]
    return faltantes, pregunta


def _normaliza_campos(campos):
    """Los campos de un hecho. D55: el descuento se criba aqui para que lo que
    viaje al endpoint tenga forma conocida; si no pasa la criba **se borra el
    campo**, no se deja a medias."""
    campos = dict(campos) if isinstance(campos, dict) else {}
    descuento = _normaliza_descuento(campos.get("descuento"))
    if descuento:
        campos["descuento"] = descuento
    else:
        campos.pop("descuento", None)
    return campos


def _normaliza_hecho(crudo):
    """Un hecho de la lista, o `None` si no es un hecho que escribe."""
    if not isinstance(crudo, dict):
        return None
    intencion = str(crudo.get("intencion") or "").strip().lower()
    if intencion not in TIPOS_DE_HECHO:
        return None
    faltantes, pregunta = _normaliza_faltantes_y_pregunta(
        crudo.get("faltantes"), crudo.get("pregunta"))
    return {
        "intencion": intencion,
        "campos": _normaliza_campos(crudo.get("campos")),
        "faltantes": faltantes,
        "pregunta": pregunta,
        "confianza": _normaliza_confianza(crudo.get("confianza")),
    }


def _vacio(valor):
    return valor is None or valor == "" or valor == [] or valor == {}


def _canonico(valor):
    """Una forma comparable: sin mayusculas, numeros como float, llaves en orden."""
    if isinstance(valor, bool):
        return valor
    if isinstance(valor, (int, float)):
        return float(valor)
    if isinstance(valor, str):
        limpio = " ".join(valor.lower().split())
        try:
            return float(limpio.replace("$", "").replace(",", ""))
        except ValueError:
            return limpio
    if isinstance(valor, dict):
        return tuple(sorted((k, _canonico(v)) for k, v in valor.items() if not _vacio(v)))
    if isinstance(valor, (list, tuple)):
        return tuple(_canonico(v) for v in valor)
    return str(valor)


def es_eco(a, b):
    """True si `b` es el MISMO hecho que `a` dicho otra vez. **Pura.**

    Mismo tipo y ningun campo que los dos traigan con valores distintos. Un
    campo que solo trae uno no los separa: "vendi una de 750... la de 599" trae
    el monto en una mitad y no en la otra, y sigue siendo UNA venta.

    **El costo es asimetrico, y por eso empata de mas:** dos ventas identicas de
    verdad ("vendi una de 750 y otra de 750" sin nada que las distinga) salen
    como una, y Norman la ve con cantidad 1 antes del VA y la corrige. Una venta
    de mas es exactamente el duplicado del 2026-09-19, y ese se escribe con un VA.
    """
    if a.get("intencion") != b.get("intencion"):
        return False
    ca, cb = a.get("campos") or {}, b.get("campos") or {}
    for llave in set(ca) | set(cb):
        va, vb = ca.get(llave), cb.get(llave)
        if _vacio(va) or _vacio(vb):
            continue
        if _canonico(va) != _canonico(vb):
            return False
    return True


def _funde(a, b):
    """Los dos ecos en uno: lo que trae `a`, completado con lo que solo trae `b`."""
    campos = dict(a.get("campos") or {})
    for llave, valor in (b.get("campos") or {}).items():
        if _vacio(campos.get(llave)) and not _vacio(valor):
            campos[llave] = valor
    fundido = dict(a)
    fundido["campos"] = campos
    # Lo que falta es lo que ninguno de los dos trae.
    fundido["faltantes"] = [f for f in (a.get("faltantes") or []) if _vacio(campos.get(f))]
    if not fundido["faltantes"]:
        fundido["pregunta"] = None
    return fundido


def normaliza_hechos(crudos):
    """La lista de hechos, criba y sin ecos. Devuelve `(hechos, de_mas)`.

    `de_mas` es cuantos hechos validos quedaron fuera por `MAX_HECHOS`: el bot
    lo DICE, no los tira callado (la leccion de D49).
    """
    if not isinstance(crudos, list):
        return [], 0
    hechos = []
    for crudo in crudos:
        hecho = _normaliza_hecho(crudo)
        if hecho is None:
            continue
        for i, previo in enumerate(hechos):
            if es_eco(previo, hecho):
                hechos[i] = _funde(previo, hecho)
                break
        else:
            hechos.append(hecho)
    return hechos[:MAX_HECHOS], max(0, len(hechos) - MAX_HECHOS)


# Las intenciones que hablan de lo que esta EN PANTALLA o eligen de una lista:
# si el modelo pone una de estas arriba, la lista de hechos no aplica.
INTENCIONES_DE_UNA_SOLA_RESPUESTA = ("confirmar", "cancelar", "ajustar", "anular",
                                      "corregir", "alta", "convertir")

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

    # El filtro significa algo en `stock` (producto O punto de venta, lo prueba
    # el servidor) y, desde D76 (Fase 8), en `cartera` (el deudor). Hasta hoy
    # aqui se tiraba el de cartera, y "cuanto me debe aeropuerto" contestaba la
    # cartera entera (log 2026-09-21 07:58). En `ventas` sigue sin significar
    # nada, y un dato que viaja para ser ignorado acaba usandose algun dia.
    filtro = obj.get("filtro")
    filtro = str(filtro).strip()[:60] if filtro else None
    # D83 (Fase 8): en `produccion` el filtro es el periodo o el lote.
    # D99 (Fase 9): en `precios` el filtro es la entidad.
    if consulta not in ("stock", "cartera", "produccion", "precios", "gastos"):
        filtro = None

    campos = _normaliza_campos(obj.get("campos"))
    faltantes, pregunta = _normaliza_faltantes_y_pregunta(
        obj.get("faltantes"), obj.get("pregunta"))
    confianza = _normaliza_confianza(obj.get("confianza"))

    # D78: la lista de hechos. Si arriba viene un hecho que escribe --o una
    # consulta o charla con hechos debajo (regla 8: gana la que escribe)--, el
    # PRIMERO de la lista manda sobre los campos de arriba. Si el modelo no
    # mando la lista, el hecho de arriba es una lista de uno.
    hechos, de_mas = normaliza_hechos(obj.get("hechos"))
    if intencion in INTENCIONES_DE_UNA_SOLA_RESPUESTA:
        hechos, de_mas = [], 0
    elif hechos:
        primero = hechos[0]
        intencion = primero["intencion"]
        campos, faltantes = primero["campos"], primero["faltantes"]
        pregunta, confianza = primero["pregunta"], primero["confianza"]
    elif intencion in TIPOS_DE_HECHO:
        hechos = [{"intencion": intencion, "campos": campos, "faltantes": faltantes,
                   "pregunta": pregunta, "confianza": confianza}]

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
        # D78: los hechos que escriben, en orden, sin ecos. [] si la intencion
        # es de una sola respuesta (consulta, charla, confirmar...).
        "hechos": hechos,
        "hechos_de_mas": de_mas,
        "confianza": confianza,
    }


def enrutar(texto, borrador=None, catalogo=None, deudores=None,
            productos=None, en_pantalla=None, historial=None, hablante=None):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo.

    `borrador` es lo que ya se sabia de una captura a medias. Si viene, el
    mensaje nuevo lo COMPLETA en vez de empezar de cero: eso es lo que hace que
    una conversacion de tres mensajes termine en un solo movimiento y no en tres
    intentos fallidos.

    `historial` (D73, Fase 8) son los turnos anteriores del chat, ya recortados
    por el bot. Viajan marcados como pasado (regla 21).
    """
    if not str(texto or "").strip():
        return False, "mensaje vacio"

    entrada = (PROMPT
               + _pedazo_contexto(borrador, catalogo, deudores, productos, en_pantalla,
                                  historial, hablante)
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
            cwd=claude_cli.cwd_neutro(),
        )
    except subprocess.TimeoutExpired:
        return False, "el modelo no contesto a tiempo"
    except Exception as e:
        return False, "no pude llamar al modelo: " + str(e)

    crudo = (salida.stdout or "").strip()
    ini, fin = crudo.find("{"), crudo.rfind("}")
    # Cazador F0 (item 6): el tope de la suscripcion no es "se cayo el modelo".
    # Solo se busca cuando NO hubo objeto: un JSON bueno que diga "limit" no es tope.
    if salida.returncode != 0 or ini == -1 or fin == -1:
        t = tope.detectar(salida.stdout, salida.stderr)
        if t is not None:
            return False, t
    if salida.returncode != 0:
        return False, "el modelo devolvio error: " + (salida.stderr or "")[-200:]
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
