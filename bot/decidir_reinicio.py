# -*- coding: utf-8 -*-
"""El JUICIO del vigilante, separado de sus MANOS.

─── POR QUE ESTO ES UN ARCHIVO Y NO CUATRO LINEAS DE POWERSHELL (D21/D23/D24) ──

`vigilar_bot.ps1` decidia dentro de si mismo, y por eso **nadie podia probar esa
decision**. Un vigilante es codigo que corre desatendido cada 5 minutos y que
mata procesos: es exactamente la clase de codigo donde un error no se ve hasta
que cuesta algo. El 2026-09-18 el bot arranco a las 10:44, el 2026-09-19 a las
09:49 se escribio la Fase 5 entera, y **el vigilante lo dejo servir codigo de 24
horas de antiguedad** porque el proceso existia y el log tenia lineas frescas.
Las dos condiciones que miraba eran verdaderas. Le faltaba una.

Aqui vive solo el juicio, como funcion PURA: entran hechos (numeros y banderas),
sale una decision. No lee el disco, no mata nada, no mira el reloj -- `ahora`
entra como argumento. Por eso `probar_vigilante.py` puede exigirle el **control
negativo** que es la mitad que importa: un `.py` MAS VIEJO que el proceso tiene
que dar `nada`. Un vigilante que reinicia siempre es igual de inutil que uno que
no reinicia nunca.

El `.ps1` se queda con lo que solo el puede hacer: mirar la lista de procesos,
levantar Next, y matar y arrancar Python.

─── LAS TRES DECISIONES DE DISENO, CON SU PORQUE ───────────────────────────────

**1. El cuelgue NO espera a los borradores.** D23 pide que un reinicio no tire
una conversacion a medias, y eso vale para el reinicio ELECTIVO (el de codigo
viejo). Para el cuelgue no, por dos razones medibles: (a) un bot colgado ya no
va a terminar esa conversacion -- el borrador esta muerto aunque siga en un
diccionario; y (b) el conteo de borradores sale del ultimo latido, y en un
cuelgue ese latido tiene por definicion mas de 20 minutos. Esperar ahi seria
esperar para siempre, apoyandose en un numero viejo: el cuelgue de E-25 nunca se
volveria a reparar.

**2. La espera esta ACOTADA, y el numero no es de mi cosecha.** Sale de
`bot_gastos.VIDA_DEL_BORRADOR` = 1800 s: un borrador a medias caduca solo a la
media hora. Esperar mas que eso no protege ninguna conversacion viva, solo
perpetua el codigo viejo. `GRACIA_BORRADORES_MIN` = 35 es esa media hora mas un
ciclo de vigilante.

**3. Un latido viejo NO cuenta como borradores.** El latido escribe cada 15 min.
Si el ultimo tiene mas de 30, ese numero no describe el presente y se ignora.
Lo contrario -- creerle a un latido de hace una hora -- es como se construye un
vigilante que nunca reinicia.

**El limite honesto, dicho aqui y no escondido:** el conteo de borradores tiene
la granularidad del latido, hasta 15 minutos. Un borrador nacido hace un minuto
no aparece todavia, y ese reinicio si tiraria la conversacion. Cerrarlo pide que
el bot publique el conteo al cambiar, no cada 15 min; queda fuera de esta tanda
y esta escrito aqui para que se sepa.
"""
import datetime as dt
import re

# El latido del bot, en minutos (`bot_gastos.INTERVALO_LATIDO` = 900 s).
INTERVALO_LATIDO_MIN = 15

# Tope de silencio del log antes de declarar cuelgue. 20 > 15 a proposito: un
# latido perdido por carga no es un cuelgue.
TOPE_LOG_MIN = 20

# Cuanto se espera, como mucho, a que se vacien los borradores. Ver punto 2.
GRACIA_BORRADORES_MIN = 35

_RENGLON_LATIDO = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[,.]?\d*\s+\w+\s+latido: vivo, (\d+) borrador"
)


def fecha(marca):
    """Una marca de tiempo en texto legible, o '(desconocida)'."""
    if not marca:
        return "(desconocida)"
    return dt.datetime.fromtimestamp(marca).strftime("%Y-%m-%d %H:%M:%S")


def ultimo_latido(texto):
    """(borradores, epoch) del ultimo latido del log, o (0, None).

    Se lee el ARCHIVO entero al reves porque el ultimo renglon del log casi
    nunca es un latido: entre latido y latido hay trafico.
    """
    for renglon in reversed(texto.splitlines()):
        casa = _RENGLON_LATIDO.match(renglon.strip())
        if casa:
            cuando = dt.datetime.strptime(casa.group(1), "%Y-%m-%d %H:%M:%S")
            return int(casa.group(2)), cuando.timestamp()
    return 0, None


def decidir(
    proceso_existe,
    arranque_proceso,
    codigo_mas_nuevo,
    edad_log_min,
    borradores,
    latido_en,
    espera_desde,
    ahora,
    tope_log_min=TOPE_LOG_MIN,
):
    """Que hacer, dados los hechos. **Funcion pura: no toca nada.**

    Devuelve ("nada" | "esperar" | "reiniciar", razon, espera_desde_nueva).

    - `arranque_proceso`, `codigo_mas_nuevo`, `latido_en`, `espera_desde`,
      `ahora`: epoch en segundos. `None` donde el dato no exista.
    - `edad_log_min`: minutos desde la ultima linea del log, o None si no hay log.
    """
    if not proceso_existe:
        return "reiniciar", "el proceso no existe", None

    if edad_log_min is not None and edad_log_min > tope_log_min:
        return (
            "reiniciar",
            "el log lleva %.0f min sin una linea (tope %d); esta colgado"
            % (edad_log_min, tope_log_min),
            None,
        )

    # --- D21: el proceso vive y contesta, pero ¿contesta con que codigo? ------
    codigo_viejo = (
        arranque_proceso is not None
        and codigo_mas_nuevo is not None
        and codigo_mas_nuevo > arranque_proceso
    )
    if not codigo_viejo:
        # Se limpia la espera: si alguien ya reinicio a mano, el reloj de la
        # gracia no puede quedarse corriendo para el proximo cambio de codigo.
        return "nada", "", None

    desfase = (
        "el codigo del %s es mas nuevo que el proceso, arrancado el %s"
        % (fecha(codigo_mas_nuevo), fecha(arranque_proceso))
    )

    latido_fresco = (
        latido_en is not None
        and (ahora - latido_en) / 60.0 <= 2 * INTERVALO_LATIDO_MIN
    )
    hay_conversacion = latido_fresco and borradores > 0

    if not hay_conversacion:
        return "reiniciar", desfase + "; sin borradores en memoria", None

    espera = espera_desde or ahora
    esperado_min = (ahora - espera) / 60.0
    if esperado_min > GRACIA_BORRADORES_MIN:
        return (
            "reiniciar",
            desfase
            + ("; espere %.0f min por %d borrador(es) y ya caducaron (tope %d min)"
               % (esperado_min, borradores, GRACIA_BORRADORES_MIN)),
            None,
        )

    return (
        "esperar",
        desfase
        + ("; ESPERO: hay %d borrador(es) en memoria. Llevo %.0f min de %d."
           % (borradores, esperado_min, GRACIA_BORRADORES_MIN)),
        espera,
    )


def hechos_de(carpeta, log, ahora):
    """Lee del disco los hechos que NO necesitan a Windows.

    Devuelve (codigo_mas_nuevo, edad_log_min, borradores, latido_en).

    Vive aqui y no en el `.ps1` por lo mismo que la decision: leer el `.py` mas
    nuevo de una carpeta es una linea que se puede equivocar de carpeta, de
    extension o de campo, y en PowerShell nadie la iba a probar. Aqui
    `probar_vigilante.py` la corre contra un directorio de verdad.

    Lo unico que se queda del lado de PowerShell es lo que solo Windows sabe:
    si el proceso existe y a que hora arranco.
    """
    import os

    mas_nuevo = None
    for nombre in sorted(os.listdir(carpeta)):
        if not nombre.endswith(".py"):
            continue
        try:
            marca = os.stat(os.path.join(carpeta, nombre)).st_mtime
        except OSError:
            continue
        if mas_nuevo is None or marca > mas_nuevo:
            mas_nuevo = marca

    edad_log_min, borradores, latido_en = None, 0, None
    if log and os.path.exists(log):
        edad_log_min = (ahora - os.stat(log).st_mtime) / 60.0
        # El log crece sin tope; el latido que importa esta al final. 200 KB
        # cubren de sobra dos latidos aunque haya trafico en medio.
        with open(log, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 200000))
            crudo = f.read().decode("utf-8", "replace")
        borradores, latido_en = ultimo_latido(crudo)

    return mas_nuevo, edad_log_min, borradores, latido_en


def _cli(argv):
    """Interfaz para `vigilar_bot.ps1`. Tres renglones: accion, razon, espera.

    Uso:  python bot/decidir_reinicio.py <existe 0|1> <arranque|-> <espera|->
    Los epoch van en segundos; un guion significa "no hay dato".
    """
    import os
    import time

    def numero(t):
        return None if t in ("", "-", None) else float(t)

    existe = argv[0] == "1"
    arranque = numero(argv[1])
    espera_desde = numero(argv[2]) if len(argv) > 2 else None

    aqui = os.path.dirname(os.path.abspath(__file__))
    ahora = time.time()
    codigo, edad_log, borradores, latido_en = hechos_de(
        aqui, os.path.join(aqui, "bot_gastos.log"), ahora
    )
    accion, razon, espera = decidir(
        existe, arranque, codigo, edad_log, borradores, latido_en, espera_desde, ahora
    )
    print(accion)
    print(razon)
    print("" if espera is None else repr(espera))
    return 0


if __name__ == "__main__":
    import sys as _sys

    raise SystemExit(_cli(_sys.argv[1:]))
