# -*- coding: utf-8 -*-
"""SUBE AL ERP LAS FOTOS DE TICKETS QUE QUEDARON SOLO EN ESTA PC.

Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).

El bot sube cada foto al ligarla a su movimiento, y cuando una subida le sale bien
reintenta lo que quedo atras. Esto es para vaciar la cola sin esperar a otra foto:
por ejemplo, fotos ligadas antes de que existiera la ruta.

    python bot/subir_comprobantes.py          # dice cuantas hay y no sube nada
    python bot/subir_comprobantes.py --subir  # las sube

Necesita BOT_API_TOKEN en el entorno. Solo sube fotos ya ligadas: una foto sin
movimiento no tiene a donde ir. Sale con 1 si alguna no subio.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bot_gastos as B  # noqa: E402
import comprobantes as C  # noqa: E402


def main(argv):
    pendientes = C.pendientes_de_subir()
    print("pendientes: %d" % len(pendientes))
    if "--subir" not in argv:
        return 0
    fallidas = [c for c in pendientes if not B._subir_comprobante(c)]
    print("subidas: %d, fallidas: %d" % (len(pendientes) - len(fallidas), len(fallidas)))
    return 1 if fallidas else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
