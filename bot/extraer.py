"""
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
}

_LISTA = NL.join("- " + k + ": " + v for k, v in CATEGORIAS.items())

PROMPT = """Eres un extractor. Recibes lo que dijo una persona de la planta de
una destileria sobre UN gasto, y devuelves UN objeto JSON. Nada mas.

DEVUELVE EXACTAMENTE ESTE OBJETO, sin texto antes ni despues, sin markdown:
{"monto": <numero>, "categoria": "<una de la lista o null>", "descripcion": "<lo que fue el gasto, en las palabras de la persona>", "fecha": "<AAAA-MM-DD o null>", "falta": "<que dato falta, o null>"}

LAS CATEGORIAS. Son las UNICAS validas. Si lo que te dicen no cae claramente en
una, pon null. NO INVENTES UNA CATEGORIA NUEVA y NO ELIJAS LA MAS PARECIDA:
null es una respuesta correcta y barata; una categoria inventada ensucia el ERP.
""" + _LISTA + """

REGLAS:
- El monto es el numero de pesos. Si no lo dicen, monto null y "falta" lo dice.
- La descripcion va en las PALABRAS DE LA PERSONA, no en las tuyas. No la
  adornes, no la traduzcas, no le agregas nada que no dijeron.
- Si no dicen fecha, fecha null (el servidor pone hoy).
- "falta" es para lo que no puedes saber y hace falta preguntar. Si no falta
  nada, null.
- Si el mensaje NO es un gasto (una pregunta, un saludo, una venta), devuelve
  {"monto": null, "categoria": null, "descripcion": null, "fecha": null, "falta": "esto no parece un gasto"}

EL MENSAJE:
"""


def _claude():
    ruta = shutil.which("claude")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    return [ruta, "-p", "--model", "haiku"]


def extraer(texto):
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
