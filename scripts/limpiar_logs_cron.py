# Escrito el 2026-11-04 por el Socio (ejecutor de limpieza). D-278.
#
# Copia lo nuevo de cron.job_run_details a un .csv.gz local, lo verifica contra la base
# en una conexion aparte y SOLO ENTONCES borra lo que tenga mas de 7 dias.
# Si algo falla: no borra, no escribe manifiesto y la siguiente corrida repite la ventana.
#
# Corre como limpiador_logs: su unico privilegio propio son dos funciones de limpieza_logs.
# Ademas tiene lo que PUBLIC da a todos los roles, incluido net.*, asi que su clave se cuida.
# El piso de 7 dias lo impone la base, no este script.
# Antes de borrar comprueba que cada fila candidata este en alguna copia. Las ventanas por si
# solas no bastan: una fila que confirma tarde caeria fuera de todas.
# No imprime contenido de filas: pueden traer datos sensibles.
#
# Uso: python limpiar_logs_cron.py [--solo-copiar] [--simular-fallo] [--sin-aviso] [--primera-copia]
# --primera-copia: permite arrancar sin copias anteriores. Sin ella, no hallar ninguna es un fallo.
import argparse, csv, datetime, glob, gzip, hashlib, io, json, os, subprocess, sys, time
import psycopg

BASE = os.environ.get("LIMPIEZA_BASE", "C:/Users/norma/Documents/Cursor/app-admin/_respaldos_bd_logs")
RUTA_ENV = os.environ.get("LIMPIEZA_ENV", "C:/Users/norma/Documents/Claude/Socio/_privado_credenciales/erp_limpieza_logs.env")
TELEGRAM = "C:/Users/norma/Documents/Claude/Socio/asistente/telegram_outbox.py"
TABLA = "cron.job_run_details"
ARCHIVO = "cron__job_run_details"
MARGEN_MIN = 10   # una fila con end_time reciente puede no estar confirmada todavia
PAGINA = 5000
LOTE_BORRADO = 1000
PAUSA_BORRADO_S = 0.2
COLUMNAS = ["jobid", "runid", "job_pid", "database", "username", "command", "status",
            "return_message", "start_time", "end_time"]
SEP = chr(31)
csv.field_size_limit(2**31 - 1)


class Huella(object):
    """Filas, suma de runid y huella de contenido. La misma cuenta se puede hacer en SQL."""

    def __init__(self):
        self.filas = 0
        self.suma = 0
        self.tmin = None
        self.tmax = None
        self.digest = hashlib.md5()

    def agrega(self, r):
        self.filas += 1
        self.suma += int(r[1])
        self.tmin = r[9] if self.tmin is None or r[9] < self.tmin else self.tmin
        self.tmax = r[9] if self.tmax is None or r[9] > self.tmax else self.tmax
        self.digest.update(hashlib.md5(SEP.join(r).encode("utf-8")).hexdigest().encode("ascii"))

    def resumen(self):
        return dict(filas=self.filas, suma_runid=self.suma, huella=self.digest.hexdigest())


def registrar(msg):
    linea = "%s %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(linea, flush=True)
    with io.open(os.path.join(BASE, "limpieza.log"), "a", encoding="utf-8") as f:
        f.write(linea + "\n")


def leer_env(ruta):
    e = {}
    for l in io.open(ruta, encoding="utf-8"):
        l = l.strip()
        if l and not l.startswith("#") and "=" in l:
            k, v = l.split("=", 1)
            e[k.strip()] = v.strip().strip('"').strip("'")
    return e


def conectar(e):
    return psycopg.connect(host=e["PGHOST"], port=int(e.get("PGPORT", "5432")), user=e["PGUSER"],
                           password=e["PGPASSWORD"], dbname=e.get("PGDATABASE", "postgres"),
                           sslmode="require", connect_timeout=15, autocommit=True)


def sha256_de(ruta):
    h = hashlib.sha256()
    with open(ruta, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def revisar_cadena():
    """Toda copia anterior debe seguir intacta y las ventanas deben empalmar sin huecos.
    Devuelve el ultimo corte copiado."""
    ultimo = None
    manifiestos = glob.glob(os.path.join(BASE, "*", ARCHIVO + "_corte_*.csv.gz.manifest.json"))
    registros = []
    for ruta in manifiestos:
        registros.append((json.load(io.open(ruta, encoding="utf-8")), ruta))
    registros.sort(key=lambda x: datetime.datetime.fromisoformat(x[0]["corte_utc"]))
    for m, ruta in registros:
        gz = ruta[: -len(".manifest.json")]
        if not os.path.exists(gz):
            raise RuntimeError("falta una copia anterior: " + os.path.basename(gz))
        if sha256_de(gz) != m["sha256"]:
            raise RuntimeError("sha256 distinto en copia anterior: " + os.path.basename(gz))
        desde = datetime.datetime.fromisoformat(m["desde_utc"]) if m["desde_utc"] else None
        if desde != ultimo:
            raise RuntimeError("hueco entre copias antes de: " + os.path.basename(gz))
        ultimo = datetime.datetime.fromisoformat(m["corte_utc"])
    return ultimo, len(registros)


def paginas(con, corte, desde):
    """Recorre la ventana (desde, corte] por paginas. Da (bytes_csv, filas_parseadas)."""
    despues = 0
    desde_txt = desde.isoformat() if desde else "-infinity"
    with con.cursor() as cur:
        while True:
            buf = io.BytesIO()
            with cur.copy(
                "copy (select * from limpieza_logs.leer_cron_pagina(%s::timestamptz, %s::timestamptz, %s::bigint, %s::integer)) "
                "to stdout with (format csv)",
                (corte.isoformat(), desde_txt, despues, PAGINA),
            ) as cp:
                for bloque in cp:
                    buf.write(bytes(bloque))
            crudo = buf.getvalue()
            filas = list(csv.reader(io.StringIO(crudo.decode("utf-8"), newline="")))
            if not filas:
                return
            yield crudo, filas
            despues = int(filas[-1][1])
            if len(filas) < PAGINA:
                return


def copiar(e, corte, desde, parcial):
    h = Huella()
    crudos = 0
    con = conectar(e)
    try:
        con.execute("set time zone 'UTC'")
        with gzip.open(parcial, "wb", compresslevel=6) as gz:
            gz.write((",".join(COLUMNAS) + "\n").encode("utf-8"))
            for crudo, filas in paginas(con, corte, desde):
                gz.write(crudo)
                crudos += len(crudo)
                for r in filas:
                    h.agrega(r)
    finally:
        con.close()
    return h, crudos


def huella_de_archivo(ruta):
    h = Huella()
    with gzip.open(ruta, "rt", encoding="utf-8", newline="") as f:
        lector = csv.reader(f)
        encabezado = next(lector)
        if encabezado != COLUMNAS:
            raise RuntimeError("encabezado inesperado en la copia")
        for r in lector:
            h.agrega(r)
    return h


def huella_de_base(e, corte, desde):
    """Conexion aparte: vuelve a leer la ventana entera, sin usar lo que escribio la copia."""
    h = Huella()
    con = conectar(e)
    try:
        con.execute("set time zone 'UTC'")
        for _, filas in paginas(con, corte, desde):
            for r in filas:
                h.agrega(r)
    finally:
        con.close()
    return h


def simular_fallo(ruta):
    """Prueba del candado: quita la ultima linea de la copia, como un disco que entrega de menos."""
    with gzip.open(ruta, "rb") as f:
        lineas = f.read().splitlines(True)
    with gzip.open(ruta, "wb") as f:
        f.writelines(lineas[:-1])


def runids_copiados():
    copiados = set()
    for ruta in glob.glob(os.path.join(BASE, "*", ARCHIVO + "_corte_*.csv.gz.manifest.json")):
        with gzip.open(ruta[: -len(".manifest.json")], "rt", encoding="utf-8", newline="") as f:
            lector = csv.reader(f)
            next(lector)
            for r in lector:
                copiados.add(int(r[1]))
    return copiados


def revisar_contra_copias(e, corte):
    """Ultimo candado: toda fila visible que se va a borrar debe estar en una copia verificada.
    Revalida la cadena, que ya incluye la copia de esta corrida, y devuelve el limite de borrado.
    El limite evita que entren filas por envejecer. NO cubre una fila que aparezca entre esta
    revision y el borrado con mas de 7 dias de antiguedad: borrar_cron_lote no recibe los runid."""
    revisar_cadena()
    copiados = runids_copiados()
    candidatas, faltan = 0, 0
    con = conectar(e)
    try:
        con.execute("set time zone 'UTC'")
        ahora = con.execute("select now()").fetchone()[0]
        limite = min(corte, ahora - datetime.timedelta(days=7))
        for _, filas in paginas(con, limite, None):
            candidatas += len(filas)
            faltan += sum(1 for r in filas if int(r[1]) not in copiados)
    finally:
        con.close()
    if faltan:
        raise RuntimeError("%d de %d filas por borrar no estan en ninguna copia" % (faltan, candidatas))
    return limite, candidatas


def borrar(e, corte):
    con = conectar(e)
    total, lotes = 0, 0
    try:
        while True:
            n = con.execute("select limpieza_logs.borrar_cron_lote(%s::timestamptz, %s::integer)",
                            (corte.isoformat(), LOTE_BORRADO)).fetchone()[0]
            if n == 0:
                return total, lotes
            total += n
            lotes += 1
            time.sleep(PAUSA_BORRADO_S)
    finally:
        con.close()


def correr(args):
    e = leer_env(RUTA_ENV)
    ultimo, previas = revisar_cadena()
    if previas == 0 and not args.primera_copia:
        raise RuntimeError("no hay copias anteriores en " + BASE)
    con = conectar(e)
    try:
        con.execute("set time zone 'UTC'")
        rol, ahora = con.execute("select current_user, now()").fetchone()
    finally:
        con.close()
    if rol != "limpiador_logs":
        raise RuntimeError("rol inesperado: %s" % rol)
    corte = (ahora - datetime.timedelta(minutes=MARGEN_MIN)).astimezone(datetime.timezone.utc)
    if ultimo is not None and corte <= ultimo:
        registrar("nada que copiar: corte %s no pasa del ultimo copiado %s" % (corte.isoformat(), ultimo.isoformat()))
        return 0

    carpeta = os.path.join(BASE, corte.strftime("%Y-%m-%d"))
    os.makedirs(carpeta, exist_ok=True)
    sello = corte.strftime("%Y%m%dT%H%M%SZ")
    final = os.path.join(carpeta, "%s_corte_%s.csv.gz" % (ARCHIVO, sello))
    parcial = final + ".parcial"
    registrar("copia: rol=%s previas=%d desde=%s corte=%s" % (rol, previas, ultimo.isoformat() if ultimo else "inicio", corte.isoformat()))

    escrita, crudos = copiar(e, corte, ultimo, parcial)
    if args.simular_fallo:
        simular_fallo(parcial)
        registrar("SIMULACION: se quito la ultima linea de la copia")

    en_archivo = huella_de_archivo(parcial)
    en_base = huella_de_base(e, corte, ultimo)
    if en_archivo.resumen() != en_base.resumen() or escrita.resumen() != en_base.resumen():
        os.remove(parcial)
        raise RuntimeError("la copia no cuadra con la base: archivo=%s base=%s" % (en_archivo.resumen(), en_base.resumen()))

    os.replace(parcial, final)
    sha = sha256_de(final)
    m = dict(tabla=TABLA, rol=rol, corte_utc=corte.isoformat(), desde_utc=ultimo.isoformat() if ultimo else None,
             ventana="end_time en (desde, corte]", filas=en_base.filas, suma_runid=en_base.suma, huella=en_base.digest.hexdigest(),
             end_time_min=en_base.tmin, end_time_max=en_base.tmax, bytes_crudos=crudos, bytes_gz=os.path.getsize(final),
             sha256=sha, archivo=final.replace("\\", "/"))
    with io.open(final + ".sha256", "w", encoding="utf-8") as f:
        f.write("%s  %s\n" % (sha, os.path.basename(final)))
    # El manifiesto se escribe al final: su existencia significa "copia verificada".
    with io.open(final + ".manifest.json", "w", encoding="utf-8") as f:
        f.write(json.dumps(m, indent=1))
    registrar("copia verificada: filas=%d suma_runid=%d huella=%s sha256=%s" % (en_base.filas, en_base.suma, en_base.digest.hexdigest(), sha))

    if args.solo_copiar:
        registrar("solo copiar: no se borro nada")
        return 0
    limite, candidatas = revisar_contra_copias(e, corte)
    registrar("candidatas a borrar: %d, todas en copias; limite=%s" % (candidatas, limite.isoformat()))
    args.etapa = "borrado"
    total, lotes = borrar(e, limite)
    registrar("borrado: filas=%d lotes=%d limite=%s" % (total, lotes, limite.isoformat()))
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--solo-copiar", action="store_true")
    p.add_argument("--simular-fallo", action="store_true")
    p.add_argument("--sin-aviso", action="store_true")
    p.add_argument("--primera-copia", action="store_true")
    args = p.parse_args()
    args.etapa = "copia"
    os.makedirs(BASE, exist_ok=True)
    try:
        return correr(args)
    except Exception as ex:
        # Solo el tipo y mensajes propios: no llevan contenido de filas.
        efecto = "no se borro nada" if args.etapa == "copia" else "copia verificada, borrado incompleto"
        registrar("FALLO (%s): %s: %s" % (efecto, type(ex).__name__, ex))
        if not args.sin_aviso:
            prefijo = "PRUEBA, no hay nada que hacer. " if args.simular_fallo else ""
            texto = "%sLimpieza semanal de logs del ERP fallo (%s). Ver _respaldos_bd_logs/limpieza.log" % (prefijo, efecto)
            registrar("aviso telegram exit=%s" % subprocess.call([sys.executable, TELEGRAM, "--texto", texto]))
        return 2


if __name__ == "__main__":
    sys.exit(main())
