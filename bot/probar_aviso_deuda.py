"""El aviso de una venta a concesion da la deuda total, no solo la de esta venta."""
import os
import sys

os.environ.setdefault("BOT_GASTOS_TELEGRAM_TOKEN", "x")
os.environ.setdefault("BOT_API_TOKEN", "x")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_gastos as B  # noqa: E402

casos = [
    ("deuda total a la vista", B._aviso_de_concesion({"total": 8256, "deuda_total": 15256, "nombre_comprador": "Aeropuerto"}),
     "Listo. Esta venta: 8,256.00. Deuda total de Aeropuerto: 15,256.00."),
    ("deuda en cero tambien se dice", B._aviso_de_concesion({"total": 100, "deuda_total": 0, "nombre_comprador": "X"}),
     "Listo. Esta venta: 100.00. Deuda total de X: 0.00."),
    ("sin lectura no inventa", B._aviso_de_concesion({"total": 8256, "deuda_total": None, "nombre_comprador": "X"}),
     "Listo. Esta venta: 8,256.00. No pude leer su deuda total."),
]
fallas = [c for c in casos if c[1] != c[2]]
for n, o, e in casos:
    print(("FALLA  " if o != e else "ok     ") + n + ("  -> obtuve %r" % o if o != e else ""))
print("RESULTADO: " + ("%d de %d casos FALLAN" % (len(fallas), len(casos)) if fallas else "los %d casos pasan" % len(casos)))
sys.exit(1 if fallas else 0)
