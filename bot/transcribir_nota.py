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

from pathlib import Path

_MODELO = None
_NOMBRE = "large-v3"


def _cargar():
    global _MODELO
    if _MODELO is not None:
        return _MODELO
    from faster_whisper import WhisperModel
    try:
        _MODELO = WhisperModel(_NOMBRE, device="cuda", compute_type="float16")
    except Exception:
        # Un 403, un driver o la VRAM ocupada por el otro bot. Se sigue en CPU:
        # tarda mas y funciona, que es infinitamente mejor que no contestar.
        _MODELO = WhisperModel(_NOMBRE, device="cpu", compute_type="int8")
    return _MODELO


def transcribir(ruta):
    """Devuelve (ok, texto_o_error). Nunca lanza."""
    audio = Path(ruta)
    if not audio.exists():
        return False, "no encuentro el audio"
    try:
        modelo = _cargar()
        segmentos, _info = modelo.transcribe(str(audio), language="es", vad_filter=True)
        texto = " ".join(s.text.strip() for s in segmentos).strip()
    except Exception as e:
        return False, "no pude transcribir: " + str(e)
    if not texto:
        return False, "no le entendi nada al audio"
    return True, texto
