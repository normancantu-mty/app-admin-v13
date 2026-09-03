import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { VENTANA_EDICION_HORAS } from '../lib/constants'

/**
 * LOS CANDADOS QUE YA NO DEPENDEN DE QUE ALGUIEN USE LA APP.
 *
 * El RLS del 2026-09-02 dejo tres huecos de escritura con una sola causa: las
 * reglas de negocio vivian en TypeScript, y un distribuidor no esta obligado a
 * usar la aplicacion — tiene un token valido y PostgREST es una API HTTPS
 * publica. Las reglas se bajaron a triggers de Postgres
 * (`20260902235000_bitacora_auditoria_y_triggers.sql`).
 *
 * Estas pruebas NO comprueban que los triggers funcionen: eso solo se puede
 * probar contra la base, con la sesion de un DST, y su salida literal quedo
 * escrita en el resumen del PROMPT 14. Lo que vigilan es lo unico que un
 * archivo puede vigilar y que si se rompe en silencio: **que el repo y la base
 * sigan diciendo lo mismo**. El dia que alguien cambie la ventana en
 * `lib/constants.ts` y no en el trigger, o revuelva un indice, esto truena.
 *
 * Puras: leen archivos del repo. Sin navegador, sin red, sin base, sin sesion.
 */

const RAIZ = path.resolve(__dirname, '..')
const MIGRACIONES = path.join(RAIZ, 'supabase', 'migrations')

const MIG_TRIGGERS = '20260902235000_bitacora_auditoria_y_triggers.sql'
const MIG_INDICES = '20260902235900_indices_llaves_foraneas.sql'

/** Las tres tablas cuyas escrituras vigila Postgres. */
const TABLAS_VIGILADAS = ['transacciones_tickets', 'finanzas_ledger', 'inventario_ledger'] as const

/** Las 17 llaves foraneas que el advisor de Supabase reportaba sin indice. */
const LLAVES_FORANEAS_SIN_INDICE: ReadonlyArray<readonly [string, string]> = [
  ['cuentas_financieras', 'id_entidad'],
  ['entidades', 'id_padre'],
  ['entidades', 'id_nodo_padre'],
  ['finanzas_ledger', 'id_cuenta_origen'],
  ['finanzas_ledger', 'id_cuenta_destino'],
  ['finanzas_ledger', 'id_ticket'],
  ['inventario_ledger', 'id_producto'],
  ['inventario_ledger', 'id_entidad_origen'],
  ['inventario_ledger', 'id_entidad_destino'],
  ['listas_precios', 'id_producto'],
  ['recetas_produccion', 'id_producto_terminado'],
  ['recetas_produccion', 'id_insumo'],
  ['ticket_detalles', 'id_ticket'],
  ['ticket_detalles', 'id_producto'],
  ['transacciones_tickets', 'id_vendedor'],
  ['transacciones_tickets', 'id_comprador'],
  ['transacciones_tickets', 'id_cuenta_destino']
]

/**
 * Quita los comentarios `--`. Sin esto, un `lower(email)` citado dentro de un
 * bloque de ROLLBACK haria fallar la prueba que exige que ya no se use.
 * Ninguna cadena de estas migraciones contiene `--`, asi que basta con cortar
 * por linea.
 */
function sinComentarios(sql: string): string {
  return sql
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n')
}

function leerMigracion(nombre: string): string {
  return readFileSync(path.join(MIGRACIONES, nombre), 'utf8')
}

/** Todas las migraciones, ordenadas por nombre (que es su orden de aplicacion). */
function migraciones(): string[] {
  return readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** Archivos de codigo propio, recursivo. */
function archivosDeCodigo(carpetas: string[]): string[] {
  const encontrados: string[] = []
  const ignorados = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
  const extensiones = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (ignorados.has(entrada)) continue
      const completo = path.join(dir, entrada)
      if (statSync(completo).isDirectory()) recorrer(completo)
      else if (extensiones.has(path.extname(entrada))) encontrados.push(completo)
    }
  }

  for (const carpeta of carpetas) recorrer(path.join(RAIZ, carpeta))
  return encontrados
}

test.describe('El backdoor `registrar_logistica_inversa` quedo enterrado', () => {
  test('ningun archivo de codigo la menciona, ni siquiera como tipo', () => {
    // Era SECURITY DEFINER, escribia en los dos ledgers, ignoraba el RLS y
    // `authenticated` podia llamarla por /rest/v1/rpc/ con `p_distribuidor_id`
    // y `p_monto_abono` arbitrarios. Se borro. Si vuelve a aparecer en el
    // codigo es que alguien la revivio: hay que enterarse en el diff, no en
    // produccion.
    const culpables = archivosDeCodigo(['app', 'lib', 'components', 'types']).filter((archivo) =>
      readFileSync(archivo, 'utf8').includes('registrar_logistica_inversa')
    )

    expect(culpables.map((a) => path.relative(RAIZ, a))).toEqual([])
  })

  test('la migracion que la borra existe y es un DROP, no un REVOKE', () => {
    // Revocarle EXECUTE ya se habia intentado dos veces (20260902000944 y
    // 20260902001110) y el GRANT nominal a `authenticated` sobrevivio las dos.
    // Lo que no existe no se puede llamar.
    const sql = sinComentarios(leerMigracion('20260902234000_borrar_backdoor_logistica_inversa.sql'))

    expect(sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.registrar_logistica_inversa/i)
  })
})

test.describe('La ventana de 12 horas dice lo mismo en TypeScript y en Postgres', () => {
  test('el trigger compara contra el mismo numero que VENTANA_EDICION_HORAS', () => {
    // El numero esta duplicado a proposito (ver `lib/constants.ts`): Postgres no
    // lee constantes de TypeScript. Esta prueba es el unico pegamento posible.
    const sql = sinComentarios(leerMigracion(MIG_TRIGGERS))
    const comparacion = sql.match(/v_horas\s*>\s*(\d+)/)

    expect(comparacion, 'el trigger ya no compara `v_horas` contra un numero').not.toBeNull()
    expect(Number(comparacion![1])).toBe(VENTANA_EDICION_HORAS)
  })

  test('el mensaje de error tambien dice las mismas horas', () => {
    // Un mensaje que miente sobre el limite manda al usuario a buscar el error
    // donde no esta.
    const sql = leerMigracion(MIG_TRIGGERS)

    expect(sql).toContain(`Ventana de anulacion expirada (maximo ${VENTANA_EDICION_HORAS} horas)`)
  })

  test('el ADMIN sale antes de que se evalue cualquier regla', () => {
    // CUIDADO 1 del encargo: el ADMIN escribe por la app con su propia sesion y
    // no debe notar nada. CUIDADO 2: sin rol resuelto (migracion o service_role)
    // el trigger tiene que dejar pasar, no reventar.
    const sql = sinComentarios(leerMigracion(MIG_TRIGGERS))

    expect(sql).toMatch(/IF\s+v_rol\s+IS\s+NULL\s+OR\s+v_rol\s*=\s*'ADMIN'\s+THEN\s+RETURN\s+NEW;/i)
  })
})

test.describe('Los nueve triggers estan puestos sobre las tres tablas', () => {
  const sql = () => sinComentarios(leerMigracion(MIG_TRIGGERS))

  for (const tabla of TABLAS_VIGILADAS) {
    test(`${tabla}: autor forzado, update vigilado y bitacora`, () => {
      const texto = sql()

      expect(
        texto,
        `falta el BEFORE INSERT que fuerza usuario_creador en ${tabla}`
      ).toMatch(
        new RegExp(`BEFORE\\s+INSERT\\s+ON\\s+public\\.${tabla}[\\s\\S]{0,120}?tg_forzar_autor`, 'i')
      )

      expect(texto, `falta el BEFORE UPDATE que vigila a los no-ADMIN en ${tabla}`).toMatch(
        new RegExp(
          `BEFORE\\s+UPDATE\\s+ON\\s+public\\.${tabla}[\\s\\S]{0,160}?tg_vigilar_update_no_admin\\(`,
          'i'
        )
      )

      expect(texto, `falta el AFTER que escribe la bitacora de ${tabla}`).toMatch(
        new RegExp(
          `AFTER\\s+INSERT\\s+OR\\s+UPDATE\\s+ON\\s+public\\.${tabla}[\\s\\S]{0,120}?tg_bitacora`,
          'i'
        )
      )
    })
  }

  test('la bitacora no se vigila a si misma: cero triggers sobre auditoria_logs', () => {
    // CUIDADO 3 del encargo. Un trigger de bitacora sobre `auditoria_logs` es
    // recursion infinita en la primera escritura.
    const texto = sinComentarios(leerMigracion(MIG_TRIGGERS))
    const triggers = [...texto.matchAll(/CREATE\s+TRIGGER\s+\w+[\s\S]*?ON\s+public\.(\w+)/gi)].map(
      (m) => m[1]
    )

    expect(triggers).toHaveLength(9)
    expect(triggers).not.toContain('auditoria_logs')
  })

  test('nadie mas que el trigger puede escribir la bitacora', () => {
    // La unica politica de `auditoria_logs` es de SELECT. Con RLS activo y sin
    // politica de escritura, INSERT/UPDATE/DELETE quedan negados para todo
    // `authenticated` — el ADMIN incluido. Una bitacora que su dueno puede
    // editar no es una bitacora.
    const texto = sinComentarios(leerMigracion(MIG_TRIGGERS))
    const politicas = [
      ...texto.matchAll(/CREATE\s+POLICY\s+\w+\s+ON\s+public\.auditoria_logs\s+FOR\s+(\w+)/gi)
    ].map((m) => m[1].toUpperCase())

    expect(politicas).toEqual(['SELECT'])
    expect(texto).toMatch(/ALTER\s+TABLE\s+public\.auditoria_logs\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i)
    expect(texto).toMatch(/REVOKE\s+ALL\s+ON\s+public\.auditoria_logs\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i)
  })
})

test.describe('La identidad ya no se resuelve por correo', () => {
  test('la ultima definicion de mi_entidad_id() no menciona email', () => {
    // `entidades.email` es una columna de datos editable desde la app. Mientras
    // empatara identidad, un correo en la fila equivocada convertia a un DST en
    // ADMIN. Se busca la ULTIMA migracion que define la funcion, no una fija:
    // si alguien la redefine mas adelante reintroduciendo el correo, esto truena.
    const definidoras = migraciones().filter((f) =>
      sinComentarios(readFileSync(path.join(MIGRACIONES, f), 'utf8')).includes(
        'FUNCTION public.mi_entidad_id()'
      )
    )

    expect(definidoras.length).toBeGreaterThan(0)

    const ultima = definidoras[definidoras.length - 1]
    const sql = sinComentarios(leerMigracion(ultima))

    // Solo el CUERPO de la funcion, entre los dos `$$`. El `COMMENT ON FUNCTION`
    // que va despues si nombra `entidades.email` — para explicar por que se
    // quito — y no puede contar como uso.
    const desdeLaFuncion = sql.slice(sql.indexOf('FUNCTION public.mi_entidad_id()'))
    const abre = desdeLaFuncion.indexOf('$$')
    const cierra = desdeLaFuncion.indexOf('$$', abre + 2)
    const cuerpo = desdeLaFuncion.slice(abre + 2, cierra)

    expect(ultima, 'la ultima redefinicion no es la que quita el correo').toBe(
      '20260902235500_identidad_solo_por_auth_id.sql'
    )
    expect(abre, 'no se encontro el cuerpo de la funcion').toBeGreaterThan(-1)
    expect(cuerpo).toContain('auth_id = auth.uid()')
    expect(cuerpo.toLowerCase()).not.toContain('email')
  })

  test('getCurrentUser() busca por auth_id primero y avisa si cae al respaldo', () => {
    const fuente = readFileSync(path.join(RAIZ, 'lib', 'auth-utils.ts'), 'utf8')

    const porAuthId = fuente.indexOf(".eq('auth_id', user.id)")
    const porCorreo = fuente.indexOf(".eq('email', user.email)")

    expect(porAuthId, 'getCurrentUser() ya no busca por auth_id').toBeGreaterThan(-1)
    expect(porCorreo, 'se quito el respaldo por correo sin dejar aviso').toBeGreaterThan(-1)
    expect(porAuthId, 'el correo dejo de ser respaldo y volvio a ser el camino principal').toBeLessThan(
      porCorreo
    )

    // El respaldo tiene que gritar. Un respaldo silencioso es un hueco que nadie
    // descubre hasta que alguien pregunta por que no ve sus datos.
    expect(fuente).toMatch(/console\.warn\([\s\S]*RESPALDO POR CORREO/)
  })
})

test.describe('Los indices de llave foranea', () => {
  /** `tabla(col, col)` -> nombre del indice, sacado de TODAS las migraciones. */
  function indicesDeclarados(): Map<string, string> {
    const mapa = new Map<string, string>()

    for (const archivo of migraciones()) {
      const sql = sinComentarios(readFileSync(path.join(MIGRACIONES, archivo), 'utf8'))
      const patron = /CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:public\.)?(\w+)\s*\(([^)]*)\)/gi

      for (const [, nombre, tabla, columnas] of sql.matchAll(patron)) {
        const cols = columnas
          .split(',')
          .map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, ''))
          .join(',')
        mapa.set(`${tabla}(${cols})`, nombre)
      }
    }

    return mapa
  }

  test('las 17 llaves foraneas que reportaba el advisor tienen indice', () => {
    const declarados = indicesDeclarados()
    const faltantes = LLAVES_FORANEAS_SIN_INDICE.filter(
      ([tabla, columna]) => !declarados.has(`${tabla}(${columna})`)
    ).map(([tabla, columna]) => `${tabla}.${columna}`)

    expect(faltantes).toEqual([])
    expect(LLAVES_FORANEAS_SIN_INDICE).toHaveLength(17)
  })

  test('los nombres siguen el patron idx_<tabla>_<columna>', () => {
    const declarados = indicesDeclarados()
    const mal: string[] = []

    for (const [tabla, columna] of LLAVES_FORANEAS_SIN_INDICE) {
      const nombre = declarados.get(`${tabla}(${columna})`)
      if (nombre !== `idx_${tabla}_${columna}`) mal.push(`${tabla}.${columna} -> ${nombre}`)
    }

    expect(mal).toEqual([])
  })

  test('no se duplico el indice compuesto que ya existia del prompt 4', () => {
    // `finanzas_ledger(id_entidad_relacionada, fecha_movimiento DESC)` lo creo
    // 20260902030000. Un segundo indice sobre lo mismo cuesta escrituras y no
    // acelera ninguna lectura.
    const sql = sinComentarios(leerMigracion(MIG_INDICES))

    expect(sql).not.toContain('id_entidad_relacionada')
  })

  test('las dos tablas sin indice de fecha ya lo tienen', () => {
    // Todas las pantallas filtran por rango de fecha (el filtro global vive en
    // una cookie que lee cada Server Component) y no habia un solo indice.
    const declarados = indicesDeclarados()

    expect(declarados.get('inventario_ledger(fecha_movimiento)')).toBe(
      'idx_inventario_ledger_fecha_movimiento'
    )
    expect(declarados.get('transacciones_tickets(fecha_transaccion)')).toBe(
      'idx_transacciones_tickets_fecha_transaccion'
    )
  })
})
