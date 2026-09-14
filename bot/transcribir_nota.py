"""
transcribir_nota.py — una nota de voz, un texto. Nada mas.

POR QUE NO SE REUSA `Socio/asistente/transcribir.py`, CONTRA LO QUE DECIA EL PLAN
--------------------------------------------------------------------------------
PROMPT 21 decia "se reutiliza transcribir.py tal cual", con la advertencia de su
autor de que no habia podido leer el archivo. Se leyo hoy (2026-09-12) y **no se
puede reusar tal cual**, por tres razones medidas y no opinables:

1. **No es una funcion, es un lote sobre una carpeta.** Toma todo lo que haya en
   `Socio/buzon/entrada`, lo transcribe, lo mueve a `procesados` y deja un `.md`
   con la plantilla de triaje del Socio. No recibe un archivo ni devuelve texto.
2. **Importa solo los audios de WhatsApp de la carpeta Descargas** antes de cada
   pasada (`importar_de_descargas`). Una nota de voz de Kevin dispararia eso.
3. **Escribiria en `Socio/buzon/`**, que tiene otro proceso vivo encima
   (telegram_socio.py, con su propio trabajador). Dos escritores sobre la misma
   carpeta es el error E-94, ya registrado y ya pagado una vez.

Lo que SI se reusa es lo que valia la pena: el modelo (`large-v3` local en la
RTX 4070), la caida a CPU y `faster-whisper`. Cero API externa, cero costo por
minuto, y el audio de la empresa no sale de la maquina.

OJO CON LA GPU: si el bot del Socio esta transcribiendo al mismo tiempo, los dos
procesos piden ~10 GB de VRAM en la misma tarjeta. Por eso hay caida a CPU y por
eso el modelo se carga una sola vez y se queda cargado.
"""

import logging
import os
import unicodedata
from pathlib import Path

log = logging.getLogger("transcribir_nota")

_MODELO = None
_DISPOSITIVO = None
_NOMBRE = "large-v3"


def _registrar_dlls_nvidia():
    """`pip install nvidia-cublas-cu12` deja los .dll en site-packages, y
    **Windows no busca ahi**. Hay que registrarlos con `os.add_dll_directory`.

    Esto ya estaba resuelto en `Socio/asistente/transcribir.py` desde el error
    del 2026-08-03 (*"Library cublas64_12.dll is not found"*), y **yo me traje
    de ahi la caida a CPU y deje fuera justo esta parte**, que es la que hace
    que la GPU funcione. Le costo a Norman un audio que no se transcribio.
    """
    try:
        import site
        raices = list(site.getsitepackages()) + [site.getusersitepackages()]
    except Exception:
        return 0
    encontradas = 0
    for raiz in raices:
        base = Path(raiz) / "nvidia"
        if not base.is_dir():
            continue
        for bin_dir in base.glob("*/bin"):
            if any(bin_dir.glob("*.dll")):
                try:
                    os.add_dll_directory(str(bin_dir))
                    os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
                    encontradas += 1
                except Exception:
                    pass
    return encontradas


def _construir(device, compute_type):
    from faster_whisper import WhisperModel
    modelo = WhisperModel(_NOMBRE, device=device, compute_type=compute_type)
    # ── LA SONDA, y por que existe ──────────────────────────────────────────
    # `WhisperModel(device="cuda")` **no falla al construirse**: la carga es
    # perezosa y el "cublas64_12.dll is not found" salta hasta la primera
    # inferencia. Un try/except alrededor del constructor —que es lo que este
    # archivo tenia— no atrapa nada y la caida a CPU nunca se dispara.
    # Medio segundo de silencio obliga a que CUDA se use de verdad AQUI, donde
    # el except si puede hacer algo.
    import numpy as np
    list(modelo.transcribe(np.zeros(8000, dtype=np.float32), language="es")[0])
    return modelo


def _cargar():
    global _MODELO, _DISPOSITIVO
    if _MODELO is not None:
        return _MODELO
    _registrar_dlls_nvidia()
    try:
        _MODELO = _construir("cuda", "float16")
        _DISPOSITIVO = "cuda"
        log.info("transcripcion en GPU (cuda/float16)")
    except Exception as e:
        # Un driver, la VRAM ocupada por el bot del Socio, o las DLLs ausentes.
        # Se sigue en CPU: tarda mas y funciona, que es infinitamente mejor que
        # no contestar.
        log.warning("CUDA no disponible (%s). Caigo a CPU.", e)
        _MODELO = _construir("cpu", "int8")
        _DISPOSITIVO = "cpu"
        log.info("transcripcion en CPU (int8)")
    return _MODELO


# Lo que Whisper NO puede adivinar solo. `initial_prompt` sesga el decodificador
# hacia este vocabulario sin obligarlo a usarlo.
#
# LO QUE MIDIO, contra las 6 notas de voz reales que Norman ya habia mandado
# (2026-09-14), y las dos mitades no dieron lo mismo:
#
#   - **Solo con este vocabulario base**: cambio 4 de 6 y SOLO en puntuacion y
#     mayusculas. Cero palabras corregidas.
#   - **Con el vocabulario VIVO** que el bot pasa desde `_memoria` (categorias,
#     deudores, cuentas): corrigio un nombre propio de verdad --
#     *"las deudas del IR-85"* paso a *"las deudas de Delirio 85"*. Delirio es
#     un distribuidor real y Whisper no tenia forma de saberlo.
#
# Es decir: la ganancia no esta en la lista fija de aqui, esta en que la lista
# la mande el SERVIDOR. La de aqui es el piso para cuando no hay sesion viva.
_VOCABULARIO_BASE = (
    "Contabilidad de The Fresnillo Distillery, destileria de chile. "
    "Nombres: Norman, Kevin, Fany, Gilberto, Charly, Fresnillo, Zacatecas. "
    "Terminos: distribuidor, abono, cartera, marbete, agave, mosto, destilado, "
    "botella, caja, insumo, flete, caseta, viaticos, IVA, IEPS, traspaso."
)

# Umbral de la puerta de confianza. Calibrado contra esas mismas 6 notas: la
# peor dio avg_logprob = -0.363, asi que -1.0 deja pasar TODAS las reales y solo
# muerde cuando Whisper esta adivinando. Un umbral que nunca se dispara no mide
# nada; uno que muerde una nota buena es peor que no tenerlo.
_LOGPROB_MINIMO = -1.0


def _es_alucinacion(texto):
    """Las frases fantasma que Whisper escupe sobre silencio o ruido.

    No es paranoia: son de su corpus de entrenamiento (subtitulos de YouTube) y
    salen con confianza alta, que es justo lo que la puerta de logprob NO caza.
    """
    t = texto.lower().strip(" .,!")
    fantasmas = (
        "subtitulos realizados por la comunidad de amara.org",
        "subtitulos realizados por",
        "gracias por ver el video",
        "gracias por ver el v",
        "mas informacion en www",
        "subtitulado por",
        "amara.org",
    )
    plano = "".join(c for c in unicodedata.normalize("NFD", t)
                    if unicodedata.category(c) != "Mn")
    return any(f in plano for f in fantasmas)


def transcribir(ruta, vocabulario=None):
    """Devuelve (ok, texto_o_error). Nunca lanza.

    `vocabulario` son las palabras vivas que el servidor ya declaro en esta
    sesion -- categorias reales, nombres de deudores, nombres de cuentas. Van
    al `initial_prompt` junto con el vocabulario base. **Se actualizan solas**:
    la autoridad es la base, igual que en `_refrescar_catalogo`.
    """
    global _MODELO, _DISPOSITIVO
    audio = Path(ruta)
    if not audio.exists():
        return False, "no encuentro el audio"

    prompt = _VOCABULARIO_BASE
    extra = [str(v).replace("_", " ") for v in (vocabulario or []) if str(v).strip()]
    if extra:
        # Se recorta: `initial_prompt` compite por la ventana del decodificador
        # y una lista larga empeora, no mejora.
        prompt = prompt + " Tambien: " + ", ".join(sorted(set(extra))[:40]) + "."

    opciones = dict(
        language="es",
        vad_filter=True,
        initial_prompt=prompt,
        # Sin esto, el texto de un segmento condiciona al siguiente y Whisper
        # entra en bucle repitiendo la misma frase hasta el final del audio.
        # Es el modo de fallo clasico en notas con pausas largas.
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        hallucination_silence_threshold=2.0,
    )

    try:
        modelo = _cargar()
        segmentos, _info = modelo.transcribe(str(audio), **opciones)
        segmentos = list(segmentos)
        texto = " ".join(s.text.strip() for s in segmentos).strip()
    except Exception as e:
        # Segunda red: si la GPU se cae A MITAD de una nota (la otra transcripcion
        # le gano la VRAM), se reconstruye en CPU y se reintenta UNA vez. Sin
        # esto, un pico de memoria ajeno pierde el audio de quien esta hablando.
        if _DISPOSITIVO == "cuda":
            log.warning("la GPU fallo a mitad (%s). Reintento en CPU.", e)
            try:
                _MODELO = _construir("cpu", "int8")
                _DISPOSITIVO = "cpu"
                segmentos, _info = _MODELO.transcribe(str(audio), **opciones)
                segmentos = list(segmentos)
                texto = " ".join(s.text.strip() for s in segmentos).strip()
            except Exception as e2:
                return False, "no pude transcribir: " + str(e2)
        else:
            return False, "no pude transcribir: " + str(e)

    if not texto:
        return False, "no le entendi nada al audio"

    # --- Las dos puertas. Un gasto mal transcrito entra como dato bueno.
    if _es_alucinacion(texto):
        log.warning("descarto alucinacion de Whisper: %r", texto)
        return False, "no le entendi nada al audio (solo ruido). Repitelo, porfa."

    peor = min([s.avg_logprob for s in segmentos], default=0.0)
    if peor < _LOGPROB_MINIMO:
        log.warning("transcripcion de baja confianza (%.3f): %r", peor, texto)
        return False, ('No estoy seguro de haber entendido. Crei oir: "' + texto +
                       '". Repitelo o escribelo, mejor que adivinar el monto.')

    return True, texto
