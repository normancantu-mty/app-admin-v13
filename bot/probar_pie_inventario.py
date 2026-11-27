"""2026-11-27 (corchos): al confirmar un gasto de insumo sin cantidad, el bot dice que el inventario NO subio."""
import os
import sys

os.environ.setdefault("BOT_GASTOS_TELEGRAM_TOKEN", "x")
os.environ.setdefault("BOT_API_TOKEN", "x")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_gastos as B  # noqa: E402

TEXTO = "Quedo solo el DINERO ($2088.00); Corcho NO subio en el inventario."
casos = [
    ("con aviso del servidor se ensena", B._pie_inventario({"ok": True, "aviso_inventario": TEXTO}), "\n\nOJO: " + TEXTO),
    ("sin aviso no agrega nada (gasto normal)", B._pie_inventario({"ok": True, "id": "x"}), ""),
    ("aviso vacio no agrega nada", B._pie_inventario({"aviso_inventario": "   "}), ""),
    ("respuesta None no revienta", B._pie_inventario(None), ""),
]
fallas = [c for c in casos if c[1] != c[2]]
for n, o, e in casos:
    print(("FALLA  " if o != e else "ok     ") + n + ("  -> obtuve %r" % o if o != e else ""))
print("RESULTADO: " + ("%d de %d casos FALLAN" % (len(fallas), len(casos)) if fallas else "los %d casos pasan" % len(casos)))
sys.exit(1 if fallas else 0)
