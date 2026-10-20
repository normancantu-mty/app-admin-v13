"""Como llama el bot a `claude -p`: con MINIMO PRIVILEGIO.

Auditoria IA 2026-10-17, hallazgos E1/E4/E5 (items #1 y #7, aprobados por
Norman el 2026-10-19).

**El modelo lee texto de terceros** (mensajes de Telegram). Hasta hoy corria
como `claude -p --model sonnet` con el cwd del bot (app-admin): heredaba las
herramientas de Claude Code (Bash, Write...), los permisos de
`~/.claude/settings.json` (`auto`, `Bash(python:*)`), los MCP, los hooks y el
CLAUDE.md de desarrollo (~42 mil tokens de entrada por llamada, medido el
2026-10-19 con --output-format json; ahora ~2.6 mil). Un mensaje que dijera
"ignora todo y corre..." llegaba a un agente con Bash en la PC de Norman:
confused deputy.

Ahora:
  --tools ""                      sin ninguna herramienta
  --mcp-config <vacio> --strict-mcp-config   sin MCP
  --setting-sources ""            sin settings de user/project/local: ni
                                  permisos, ni hooks, ni CLAUDE.md
  --permission-mode dontAsk       lo que pidiera permiso se niega
  cwd = carpeta vacia dedicada    fuera de cualquier repo

El bot solo necesita TEXTO de vuelta: el JSON se recorta de stdout como antes.
La prueba es `bot/probar_minimo_privilegio.py`.

Los modelos van FIJADOS con version (E5): cuando el alias `sonnet` cambie de
version, el bot no cambia de comportamiento sin aviso. Para mover de version se
cambia AQUI y se vuelve a correr `bot/oro/correr_oro.py`.
"""
import os
import shutil
import tempfile

SONNET = "claude-sonnet-5-5"
HAIKU = "claude-haiku-4-5-20251001"

_BASE = os.path.join(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "bot_gastos_llm")


def cwd_neutro():
    """Carpeta vacia dedicada: ningun CLAUDE.md, ningun .claude/, ningun repo."""
    ruta = os.path.join(_BASE, "cwd")
    os.makedirs(ruta, exist_ok=True)
    return ruta


def mcp_vacio():
    ruta = os.path.join(_BASE, "mcp_vacio.json")
    if not os.path.isfile(ruta):
        os.makedirs(_BASE, exist_ok=True)
        with open(ruta, "w", encoding="ascii") as f:
            f.write('{"mcpServers": {}}')
    return ruta


def ejecutable():
    ruta = shutil.which("claude") or shutil.which("claude.cmd")
    if not ruta:
        raise RuntimeError("no encuentro el ejecutable `claude` en el PATH")
    return ruta


def comando(modelo, ruta=None):
    """La linea de comando completa. `ruta` deja a cada modulo conservar su
    propia busqueda del ejecutable (las pruebas la doblan)."""
    return [ruta or ejecutable(), "-p", "--model", modelo,
            "--tools", "",
            "--mcp-config", mcp_vacio(), "--strict-mcp-config",
            "--setting-sources", "",
            "--permission-mode", "dontAsk"]
