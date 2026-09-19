"""
⛔ RETIRADO EL 2026-09-19. **Nadie llama este modulo.** Lo sustituye
`bot/enrutador.py`, que decide la intencion Y extrae los campos en UNA sola
llamada al modelo. Se queda en el repo sin llamador porque aqui nada se borra
(regla 6 de CLAUDE.md), y porque su prompt es el historial de lo que se fue
aprendiendo sobre como dicta Norman.

**No lo vuelvas a cablear en paralelo con el enrutador.** Eso fue exactamente lo
que estuvo mal hasta hoy: dos prompts leyendo el mismo mensaje, y cual mandaba
dependia del orden de unos `if`. El mismo gasto se podia escribir de dos maneras
segun por donde entrara, y desde afuera las dos se veian igual.

extraer.py — el unico punto donde el LLM toca este sistema.

Entra lenguaje natural. Sale UN objeto con cuatro campos y nada mas.
No sale prosa, no sale SQL, no sale la fila final: la fila la arma el servidor
(`lib/bot-gastos.ts`) contra listas cerradas, y este modulo solo propone.

POR QUE `claude -p` Y NO UNA API NUEVA
--------------------------------------
Ya corre en esta maquina y esta probado desde agosto (Socio/asistente/
telegram_socio.py lo usa en produccion). No agrega llave, ni cuenta, ni costo
por token que nadie este midiendo. Se le pasa --model haiku porque esto es
extraccion mecanica, no juicio: la tabla de eleccion de modelo de CLAUDE.md
manda lo mecanico al modelo barato.

Si algun dia la latencia molesta, la alternativa es OpenRouter (la llave ya
esta en .env, sin usar). No se hizo hoy: seria una dependencia nueva para un
problema que todavia no se midio. [Filtro: DOC02 - YAGNI]
"""

import json
import shutil
import subprocess
import sys

NL = chr(10)
TIMEOUT = 120

# El vocabulario. Es el MISMO que la lista cerrada de lib/bot-gastos.ts, y esta
# duplicado a proposito: Python no puede leer una constante de TypeScript.
# Si divergen, el servidor gana — lo que no empate cae a SIN_CATEGORIZAR, que
# es un fallo ruidoso y no silencioso. Aun asi: si tocas una, toca la otra.
CATEGORIAS = {
    "Marketing_y_Relaciones": "publicidad, redes, disenio, muestras, atenciones",
    "Servicios_Basicos": "luz, agua, internet, telefono, renta, software",
    "Logistica_Envios": "gasolina, casetas, paqueteria, fletes, viaticos de ruta",
    "Nomina_y_Honorarios": "sueldos, honorarios, pagos a terceros por trabajo",
    "Gastos_Personales_Socio": "retiros y gastos personales de un socio",
    "Insumos": "materia prima: agave, botella, corcho, etiqueta, todo lo que entra al producto",
}

_LISTA = NL.join("- " + k + ": " + v for k, v in CATEGORIAS.items())

PROMPT = """Eres un extractor. Recibes lo que dijo una persona de la planta de
una destileria sobre UN gasto, y devuelves UN objeto JSON. Nada mas.

DEVUELVE EXACTAMENTE ESTE OBJETO, sin texto antes ni despues, sin markdown:
{"monto": <numero>, "categoria": "<una de la lista o null>", "categoria_nueva": "<nombre para una categoria que no existe, o null>", "descripcion": "<lo que fue el gasto, en las palabras de la persona>", "fecha": "<AAAA-MM-DD o null>", "falta": "<que dato falta, o null>"}

LAS CATEGORIAS. Son las UNICAS validas. Si lo que te dicen no cae claramente en
una, pon null. NO INVENTES UNA CATEGORIA NUEVA y NO ELIJAS LA MAS PARECIDA:
null es una respuesta correcta y barata; una categoria inventada ensucia el ERP.

COMO ELEGIR, Y EL ERROR QUE YA COMETISTE:
Clasifica por el SENTIDO DEL GASTO, nunca porque una palabra de la lista
aparezca en el mensaje. Las palabras de la lista son ejemplos, NO son llaves.

  Caso real, 2026-09-12: "acabamos de comer Kevin y yo, 600 pesos, ponlo de
  viaticos" -> devolviste Logistica_Envios porque la ayuda de esa categoria
  dice "viaticos de ruta". Una comida entre los dos socios NO es un viatico de
  ruta: el viatico de ruta es el gasto de alguien que ANDA DE VIAJE POR TRABAJO.
  La respuesta correcta era null.

Antes de elegir una categoria, preguntate: "si quito la palabra que coincide,
sigue siendo esta categoria?". Si la respuesta es no, la categoria es null.
Que la persona use una palabra ("ponlo de viaticos") NO te obliga: ella esta
describiendo, no clasificando. El que clasifica eres tu, y si dudas, null.

CUANDO NINGUNA CATEGORIA SIRVE: "categoria_nueva"
La lista de arriba **no esta terminada**: crece con el uso. Si el gasto es real
y claro pero NINGUNA categoria le queda, deja "categoria" en null y propon un
nombre en "categoria_nueva". Una persona lo va a aprobar o rechazar; no se crea
sola.

  - Formato: empieza con letra, solo letras, numeros y guion bajo, 3 a 40
    caracteres. Ejemplo: Comidas_Y_Atenciones, Mantenimiento, Impuestos_Y_Tramites.
  - Que sea la CLASE de gasto, no este gasto: "Comidas_De_Trabajo", no
    "Comida_Con_Kevin_El_Viernes". Una categoria que sirve una sola vez no es
    una categoria.
  - NO propongas una que ya existe con otro nombre. Si dudas entre proponer una
    nueva y usar una existente, **usa la existente**.
  - NUNCA uses las palabras IVA ni IEPS en el nombre: el ERP lee esa columna
    para decidir si se pago un impuesto, y un nombre asi inventa un pago.
  - Si el gasto es confuso o no sabes que es, deja las DOS en null. Proponer una
    categoria nueva a ciegas es peor que no proponer nada.
""" + _LISTA + """

REGLAS:
- El monto es el numero de pesos. Si no lo dicen, monto null y "falta" lo dice.
- La descripcion va en las PALABRAS DE LA PERSONA, no en las tuyas. No la
  adornes, no la traduzcas, no le agregas nada que no dijeron.
- Si no dicen fecha, fecha null (el servidor pone hoy).
- "falta" es para lo que no puedes saber y hace falta preguntar. Si no falta
  nada, null.
- Si el mensaje NO es un gasto (una pregunta, un saludo, una venta), devuelve
  {"monto": null, "categoria": null, "categoria_nueva": null, "descripcion": null, "fecha": null, "falta": "esto no parece un gasto"}

EL MENSAJE:
"""


def _claude():
    ruta = shutil.which("claude")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    # Sonnet y no Haiku. **Clasificar no es mecanico**: es la unica parte de este
    # bot que exige criterio, y es la que Norman llamo primordial el 2026-09-12.
    # Haiku empato "viaticos" con "viaticos de ruta" sin mirar el sentido, que es
    # exactamente el modo de fallo contra el que esta escrito el prompt.
    # A 30-40 capturas por semana la diferencia de costo es irrelevante; la de
    # criterio no.
    return [ruta, "-p", "--model", "sonnet"]


def extraer(texto, extras=None):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo.

    `extras` son las categorias que existen en la base y **no** en el
    diccionario de este archivo: las que se fueron creando con el uso. Sin
    ellas el modelo volveria a proponer como "nueva" una que ya existe, y la
    puerta del servidor la rechazaria — correcto pero inutil, porque el gasto
    se quedaria sin clasificar por un problema de vocabulario y no de criterio.
    """
    if not str(texto or "").strip():
        return False, "mensaje vacio"
    prompt = PROMPT
    faltantes = [c for c in (extras or []) if c not in CATEGORIAS]
    if faltantes:
        prompt = prompt.replace(
            _LISTA, _LISTA + NL + NL.join("- " + c for c in sorted(faltantes)))
    try:
        salida = subprocess.run(
            _claude(),
            input=prompt + str(texto).strip(),
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
    # El modelo a veces envuelve en cerca de codigo. Se recorta al primer { y al
    # ultimo }: es mas robusto que pedirle por favor que no lo haga.
    ini, fin = crudo.find("{"), crudo.rfind("}")
    if ini == -1 or fin == -1:
        return False, "el modelo no devolvio un objeto"
    try:
        obj = json.loads(crudo[ini:fin + 1])
    except json.JSONDecodeError as e:
        return False, "el objeto del modelo no es JSON: " + str(e)

    if not isinstance(obj, dict):
        return False, "el modelo no devolvio un objeto"
    return True, obj


if __name__ == "__main__":
    ok, r = extraer(" ".join(sys.argv[1:]))
    print(json.dumps(r, ensure_ascii=False, indent=2) if ok else "ERROR: " + str(r))
