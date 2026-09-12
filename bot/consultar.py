"""
consultar.py — AG-04 Fase 3. Clasifica una PREGUNTA, no la contesta.

LA REGLA QUE ORDENA ESTE ARCHIVO, y es la de la Fase 1 con el papel invertido:
**el modelo elige QUE se pregunta; el servidor produce el texto entero, numeros
incluidos.** Este modulo devuelve como maximo dos cosas:

    {"consulta": "stock" | "cartera" | "ventas" | null, "filtro": "<texto>" | null}

Nunca un numero, nunca una frase para mostrar. Si el modelo se equivoca, lo peor
que pasa es que el bot conteste otra consulta — se ve al instante y se vuelve a
preguntar. **Lo que este diseno hace imposible es que conteste un numero que no
existe**, y esa es la razon de que la Fase 3 vaya despues de las escrituras:
una escritura mala se ANULA y se ve en el ledger; una consulta que miente no
deja rastro.

POR QUE HAIKU AQUI Y SONNET EN `extraer.py`
--------------------------------------------
Elegir entre TRES opciones a partir de una pregunta que **ya se descarto como
gasto** es mecanico: no hay criterio de negocio en juego, y la tabla de eleccion
de modelo de CLAUDE.md manda lo mecanico al modelo barato. En `extraer.py` es al
reves —clasificar el gasto si exige criterio, y ponerlo en Haiku fue leer mal
esa misma tabla (2026-09-12)—. **Aqui la diferencia se paga en latencia, que es
lo que se nota cuando uno pregunta algo desde el celular.**
"""

import json
import shutil
import subprocess
import sys

NL = chr(10)
TIMEOUT = 60

# La MISMA lista cerrada que `CONSULTAS` en lib/bot-consultas.ts. Duplicada a
# proposito (Python no lee una constante de TypeScript). Si divergen, gana el
# servidor: lo que no empate se rechaza con 422, que es un fallo ruidoso.
CONSULTAS = {
    "stock": "cuantas piezas hay, de que producto, y en que punto de venta",
    "cartera": "quien debe dinero, cuanto, y desde hace cuanto no abona",
    "ventas": "cuanto se vendio, por mes",
}

_LISTA = NL.join("- " + k + ": " + v for k, v in CONSULTAS.items())

PROMPT = """Eres el clasificador de PREGUNTAS de un ERP. No contestas la
pregunta: solo dices CUAL de estas consultas la contesta.

LAS UNICAS CONSULTAS QUE EXISTEN:
""" + _LISTA + """

Devuelve SOLO este objeto JSON, sin prosa y sin cercas de codigo:

{"consulta": "stock"|"cartera"|"ventas"|null, "filtro": "<texto>"|null}

REGLAS:

1. `consulta` es null si la pregunta no la contesta NINGUNA de las tres. **Es la
   respuesta correcta muchas veces y no es un fracaso.** Mas vale un null que
   mandar a la persona a una consulta que no le contesta lo que pregunto.

2. `filtro` SOLO aplica a `stock`, y es **el nombre propio que se menciona: un
   producto O un punto de venta**, tal cual lo dijo la persona y sin adornos.
   NO tienes que saber cual de los dos es — el servidor lo averigua. Si no se
   menciona ninguno, va null. Para `cartera` y `ventas` va SIEMPRE null.

3. NUNCA inventes ni estimes un numero. No es tu trabajo y no tienes los datos.

4. Fijate en QUE SE PREGUNTA, no en que palabras aparecen:
   - "cuanto me debe Delirio"        -> cartera   (no stock, aunque diga "cuanto")
   - "cuantas botellas tiene Delirio" -> stock
   - "como vamos este mes"           -> ventas
   - "cuanto hay de chile 750"       -> stock, filtro "chile 750"     (producto)
   - "cuantas botellas hay en Delirio" -> stock, filtro "Delirio"      (punto de venta)
   - "a quien le hablo primero"      -> cartera   (es la pregunta de cobranza)
   - "ponle 300 de gasolina"         -> null      (eso es un gasto, no una pregunta)
   - "quien es Kevin"                -> null

PREGUNTA:
"""


def _claude():
    ruta = shutil.which("claude") or shutil.which("claude.cmd")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    return [ruta, "-p", "--model", "haiku"]


def clasificar(texto):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo."""
    if not str(texto or "").strip():
        return False, "mensaje vacio"
    try:
        salida = subprocess.run(
            _claude(),
            input=PROMPT + str(texto).strip(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, "el modelo tardo demasiado"
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

    # La lista cerrada se aplica AQUI tambien, no solo en el servidor. Un valor
    # inventado no sale de este proceso: se vuelve null, que el bot ya sabe
    # manejar. Defensa barata que se paga dos veces, igual que los vetos de
    # cuenta de la Fase 1.
    if obj.get("consulta") not in CONSULTAS:
        obj["consulta"] = None
    if obj.get("consulta") != "stock":
        obj["filtro"] = None
    filtro = obj.get("filtro")
    obj["filtro"] = str(filtro).strip()[:60] if filtro else None
    return True, obj


if __name__ == "__main__":
    ok, r = clasificar(" ".join(sys.argv[1:]))
    print(json.dumps(r, ensure_ascii=False, indent=2) if ok else "ERROR: " + str(r))
