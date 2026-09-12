"""
extraer_abono.py — AG-02 Fase 2. El LLM propone UN abono. Nada mas.

Entra lenguaje natural. Sale un objeto con seis campos: a quien, cuanto, como,
la nota, la fecha y que falta. **No sale la fila**, no sale el uuid de nadie, no
sale el reparto entre pedidos. Todo eso lo arma el servidor
(`lib/bot-abonos.ts`) contra listas cerradas.

LO QUE ESTE MODULO NO PUEDE HACER, Y ES A PROPOSITO
---------------------------------------------------
El campo `deudor` es un NOMBRE tal cual lo dijo la persona. El servidor lo
empata contra la cartera viva y, si hay mas de un candidato, **pregunta con
botones**. Que el modelo devolviera un uuid seria un dato que nadie puede
verificar leyendo la confirmacion: quien revisa ve "Gilberto Franco", no
"8f3a...". El nombre se puede revisar de un vistazo; un uuid no.

POR QUE SONNET Y NO HAIKU
-------------------------
Decidir A QUIEN corresponde un abono y CUANTO exige criterio, no coincidencia de
palabras: "me deposito Gilberto cinco mil de lo de las botellas" tiene el monto
en letra, el nombre incompleto y una nota que no es ninguno de los dos. Es la
misma leccion que se pago el 2026-09-12 poniendo `extraer.py` en Haiku: empato
"viaticos" con "viaticos de ruta" sin mirar el sentido. Aqui el error no
ensuciaria una etiqueta, moveria dinero a la entidad equivocada.
"""

import json
import shutil
import subprocess
import sys

NL = chr(10)
TIMEOUT = 120

PROMPT = """Eres un extractor de COBRANZA. Recibes lo que dijo el dueno de una
destileria sobre UN pago que le hizo un distribuidor o un punto de venta, y
devuelves UN objeto JSON. Nada mas.

DEVUELVE EXACTAMENTE ESTE OBJETO, sin texto antes ni despues, sin markdown:
{"deudor": "<el nombre tal cual lo dijo, o null>", "monto": <numero>, "metodo_pago": "<como pago, o null>", "nota": "<lo que dijo, en sus palabras>", "fecha": "<AAAA-MM-DD o null>", "falta": "<que dato falta, o null>"}

QUE ES UN ABONO, Y QUE NO
Un abono es DINERO QUE ENTRA, de alguien que debe. Las tres senales: hay una
persona o negocio que paga, hay una cantidad, y el dinero viene HACIA la
empresa.

  SI son abonos:
    "me deposito Gilberto cinco mil"
    "Delirio me pago 3 mil de lo de la semana pasada"
    "Martin Reyes abono 1,500 en efectivo"
    "cobre 800 en Dulceria ruiz"

  NO son abonos (devuelve "falta": "esto no parece un abono"):
    "cuanto me debe Delirio"            -> es una PREGUNTA
    "a quien le hablo primero"          -> es una PREGUNTA
    "gaste 340 de gasolina"             -> es un GASTO: el dinero SALE
    "le pague 2 mil a Kevin"            -> es un GASTO: el dinero SALE
    "vendi 6 botellas en Delirio"       -> es una VENTA, no un pago
    "quien es Kevin"                    -> ni una cosa ni la otra

REGLAS

1. `deudor` es el nombre COMO LO DIJO, sin completarlo y sin corregirlo. Si dijo
   "Gilberto", pon "Gilberto", NO "Gilberto Franco". El servidor tiene la lista
   real y lo resuelve; si hay duda le pregunta a la persona. **Inventarle el
   apellido es quitarle esa pregunta a quien si sabe la respuesta.**
   Si no se menciona a nadie, `deudor` es null y "falta" lo dice.

2. `monto` es el numero de pesos, como NUMERO. "cinco mil" -> 5000,
   "3 mil quinientos" -> 3500, "1,200" -> 1200. Si no lo dicen, monto null y
   "falta" lo dice. **Nunca lo estimes ni lo redondees.**

3. `metodo_pago` es COMO pago, si lo dijeron: efectivo, transferencia, deposito,
   cheque. Si no lo dijeron, null. No lo adivines: null es correcto y barato.

4. `nota` va en las PALABRAS DE LA PERSONA. No la adornes, no la traduzcas, no
   le agregues nada que no dijeron. Si no dijeron nada mas que el monto y el
   nombre, deja la nota corta o null.

5. `fecha` solo si la dijeron. "ayer" o "el lunes" NO son fechas que tu puedas
   resolver sin saber que dia es hoy: en ese caso pon null y menciona lo que
   dijo en la nota. El servidor pone hoy.

6. NUNCA uses las palabras IVA ni IEPS en la nota. El ERP lee ese texto para
   decidir si se pago un impuesto, y escribirlas ahi inventa un pago que nadie
   hizo. Si la persona las dijo, escribe la nota sin ellas.

7. Si falta el monto O falta el deudor, llena "falta" con lo que falta, en una
   frase corta y en espanol ("de quien fue el pago", "de cuanto fue").

LOS QUE HOY DEBEN (para que empates el nombre, NO para que elijas tu):
"""


def _claude():
    ruta = shutil.which("claude") or shutil.which("claude.cmd")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    return [ruta, "-p", "--model", "sonnet"]


def extraer_abono(texto, deudores=None):
    """Devuelve (ok, objeto_o_error). Nunca lanza por culpa del modelo.

    `deudores` son los nombres de la cartera viva. Se le pasan al modelo para
    que EMPATE mejor el nombre que oyo, no para que elija: el servidor vuelve a
    empatar contra su propia lista y es el unico que resuelve el uuid. Se pasan
    **solo nombres, ningun monto**: el modelo no tiene por que ver una cifra del
    negocio para hacer su trabajo.
    """
    if not str(texto or "").strip():
        return False, "mensaje vacio"

    prompt = PROMPT
    nombres = [str(n).strip() for n in (deudores or []) if str(n).strip()]
    prompt += NL.join("- " + n for n in nombres) if nombres else "(no pude leer la lista)"
    prompt += NL + NL + "EL MENSAJE:" + NL

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

    # Defensa barata que se paga dos veces, igual que los vetos de cuenta de la
    # Fase 1: un monto que no es numero no sale de este proceso.
    monto = obj.get("monto")
    if monto is not None:
        try:
            obj["monto"] = float(str(monto).replace(",", "").replace("$", "").strip())
        except (TypeError, ValueError):
            obj["monto"] = None
            obj["falta"] = obj.get("falta") or "de cuanto fue"
    return True, obj


if __name__ == "__main__":
    ok, r = extraer_abono(" ".join(sys.argv[1:]))
    print(json.dumps(r, ensure_ascii=False, indent=2) if ok else "ERROR: " + str(r))
