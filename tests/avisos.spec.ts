import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOGO_AVISOS,
  CATEGORIA_SIN_CATEGORIZAR,
  ENTIDAD_PENDIENTE_DE_ASIGNAR,
  cuentaVetadaComoDefault,
  esCompradorSeleccionable,
  exigeAsignacion,
  normalizarCategoriaGasto,
  ordenarColaAvisos,
  resolverCompradorDeVenta,
  resolverCuentaOrigenPorDefecto,
  resumenDiarioAvisos,
  severidadDeAviso,
  type AvisoEnCola,
  type CuentaCandidata,
  type TipoAviso
} from '../lib/avisos'

/**
 * ERP-59 — pruebas puras de la cola de avisos. Sin base, sin red, sin navegador.
 *
 * La cola no es una pantalla bonita: es la lista de lo que el sistema no sabe.
 * Lo que se vigila aqui es lo unico que se puede vigilar sin base — la tabla de
 * severidades, el orden, el resumen del bot y, sobre todo, **el default de la
 * cuenta de origen**, que es el punto donde una equivocacion filtra dinero
 * entre entidades o inventa impuestos.
 */

// ────────────────────────────────────────────────────────────────────────────
// 1. EL CATALOGO
// ────────────────────────────────────────────────────────────────────────────

const TIPOS = Object.keys(CATALOGO_AVISOS) as TipoAviso[]

test.describe('Catalogo de avisos', () => {
  test('los trece tipos tienen severidad, titulo y consecuencia', () => {
    // El numero SI se congela a proposito, al reves que las cifras de negocio
    // de ERP-78: el catalogo es cerrado y lo reviso Norman. Que crezca tiene que
    // costar editar esta linea; que la operacion diaria lo mueva, no.
    // 10 -> 11 el 2026-09-12: entra W15 (conteo fisico que no cuadra), ERP-54.
    // 11 -> 13 el 2026-09-12: entran W16 y W17, los dos avisos del abono por
    // Telegram. **Nacieron mandados por W14 y eso fue E-248**: el codigo elige
    // el titulo que lee quien abre la cola, asi que reusar el mas parecido le
    // pone a un abono el encabezado "Gasto sin categoria". Esta linea es justo
    // la friccion que hace que agregar un aviso sea una decision y no un
    // descuido.
    expect(TIPOS).toHaveLength(13)

    for (const tipo of TIPOS) {
      const definicion = CATALOGO_AVISOS[tipo]
      expect(['INFO', 'REVISAR']).toContain(definicion.severidad)
      expect(definicion.titulo.trim().length).toBeGreaterThan(0)
      // La consecuencia es lo que hace legible la cola sin abrir el codigo:
      // "que quedo sin hacer". Un titulo suelto no basta.
      expect(definicion.consecuencia.trim().length).toBeGreaterThan(20)
    }
  })

  test('solo W1b, W10, W12 y W16 son INFO: los demas mueven dinero o inventario', () => {
    const informativos = TIPOS.filter((tipo) => severidadDeAviso(tipo) === 'INFO')
    // W16 (abono con dinero a cuenta) es INFO y no REVISAR a proposito: **nada
    // quedo sin hacer**. El abono entro completo y la deuda bajo por el total;
    // lo unico que dice el aviso es que una parte no cuelga de ningun pedido.
    // Su hermano W17 SI es REVISAR, porque ahi si se cambio un texto.
    expect(informativos.sort()).toEqual(['W10', 'W12', 'W16', 'W1b'])
  })

  test('solo W4 exige asignacion antes de cerrarse', () => {
    const conCandado = TIPOS.filter((tipo) => exigeAsignacion(tipo))
    expect(conCandado).toEqual(['W4'])
  })
})

test.describe('La categoria del gasto nunca queda vacia (W14)', () => {
  test('vacio, espacios, null y undefined caen en SIN_CATEGORIZAR', () => {
    for (const entrada of ['', '   ', null, undefined]) {
      expect(normalizarCategoriaGasto(entrada)).toBe(CATEGORIA_SIN_CATEGORIZAR)
    }
  })

  test('una categoria de verdad se respeta tal cual', () => {
    expect(normalizarCategoriaGasto('  Servicios_Basicos  ')).toBe('Servicios_Basicos')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. EL ORDEN Y EL RESUMEN
// ────────────────────────────────────────────────────────────────────────────

function aviso(parcial: Partial<AvisoEnCola> & { id: string; creado_en: string }): AvisoEnCola {
  return {
    tipo: 'W13',
    severidad: 'REVISAR',
    mensaje: 'da igual',
    estado: 'ABIERTO',
    id_entidad: 'e1',
    tabla: null,
    id_registro: null,
    ...parcial
  }
}

test.describe('Orden de la cola', () => {
  test('REVISAR va antes que INFO, y dentro de cada uno lo viejo primero', () => {
    const cola = [
      aviso({ id: 'info-nuevo', severidad: 'INFO', creado_en: '2026-09-04T10:00:00Z' }),
      aviso({ id: 'revisar-nuevo', severidad: 'REVISAR', creado_en: '2026-09-04T10:00:00Z' }),
      aviso({ id: 'info-viejo', severidad: 'INFO', creado_en: '2026-08-01T10:00:00Z' }),
      aviso({ id: 'revisar-viejo', severidad: 'REVISAR', creado_en: '2026-08-01T10:00:00Z' })
    ]

    expect(ordenarColaAvisos(cola).map((a) => a.id)).toEqual([
      'revisar-viejo',
      'revisar-nuevo',
      'info-viejo',
      'info-nuevo'
    ])
  })

  test('no muta el arreglo que recibe', () => {
    const cola = [
      aviso({ id: 'b', severidad: 'INFO', creado_en: '2026-08-01T00:00:00Z' }),
      aviso({ id: 'a', severidad: 'REVISAR', creado_en: '2026-09-01T00:00:00Z' })
    ]
    const antes = cola.map((a) => a.id)
    ordenarColaAvisos(cola)
    expect(cola.map((a) => a.id)).toEqual(antes)
  })
})

test.describe('Resumen diario para el bot', () => {
  const AHORA = new Date('2026-09-05T12:00:00Z')

  test('cuenta por severidad, saca los 5 mas viejos e ignora lo cerrado', () => {
    const cola: AvisoEnCola[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        aviso({ id: `r${i}`, severidad: 'REVISAR', creado_en: `2026-08-0${i + 1}T00:00:00Z` })
      ),
      aviso({ id: 'i1', severidad: 'INFO', creado_en: '2026-09-01T00:00:00Z' }),
      aviso({ id: 'cerrado', severidad: 'REVISAR', creado_en: '2026-01-01T00:00:00Z', estado: 'RESUELTO' }),
      aviso({ id: 'ignorado', severidad: 'INFO', creado_en: '2026-01-01T00:00:00Z', estado: 'IGNORADO' })
    ]

    const resumen = resumenDiarioAvisos(cola, AHORA)

    expect(resumen.total).toBe(8)
    expect(resumen.revisar).toBe(7)
    expect(resumen.info).toBe(1)
    expect(resumen.masViejos).toHaveLength(5)
    expect(resumen.masViejos[0].id).toBe('r0')
    // 2026-08-01 -> 2026-09-05 son 35 dias.
    expect(resumen.diasDelMasViejo).toBe(35)
  })

  test('con la cola vacia SIGUE dando texto: es el latido', () => {
    const resumen = resumenDiarioAvisos([], AHORA)

    expect(resumen.total).toBe(0)
    expect(resumen.diasDelMasViejo).toBe(0)
    // "no llego nada" y "llevo tres dias muerto" no se pueden ver igual.
    expect(resumen.texto.trim().length).toBeGreaterThan(0)
    expect(resumen.texto).toContain('0 avisos abiertos')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. W13 — EL DEFAULT DE LA CUENTA DE ORIGEN
//
// Esta es LA prueba de este archivo. Las otras vigilan que la cola se lea bien;
// esta vigila que un default automatico no pueda romper el Account_Firewall
// (regla 1) ni el motor de impuesto inverso (regla 2).
// ────────────────────────────────────────────────────────────────────────────

const ADMIN = 'e0000000-0000-0000-0000-000000000001'
const DST = 'f0443423-60a0-4156-9bcd-52394ae274fe'

/** Las cuentas reales de produccion, comprobadas el 2026-09-05. */
const CUENTAS_REALES: CuentaCandidata[] = [
  { id: 'c-fresnillo', nombre: 'Cuenta Fresnillo', id_entidad: ADMIN, rol_entidad: 'ADMIN', tipo_fiscalidad: 'FULL_TAX' },
  { id: 'c-personal', nombre: 'Cuenta personal', id_entidad: ADMIN, rol_entidad: 'ADMIN', tipo_fiscalidad: 'IVA_ONLY' },
  { id: 'c-efectivo-admin', nombre: 'Efectivo', id_entidad: ADMIN, rol_entidad: 'ADMIN', tipo_fiscalidad: 'LIBRE' },
  { id: 'c-david', nombre: 'Efectivo (David Flores)', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' }
]

test.describe('W13 · el default de la cuenta de origen', () => {
  test('un DST cae en su propia cuenta', () => {
    const r = resolverCuentaOrigenPorDefecto(DST, CUENTAS_REALES)
    expect(r).toEqual({ ok: true, idCuenta: 'c-david' })
  })

  test('EL ADMIN NO TIENE DEFAULT: sus tres cuentas estan vetadas, asi que se rechaza', () => {
    // No es un hueco: es la decision. Adivinar la cuenta de origen del ADMIN es
    // exactamente el error caro. Mejor un rechazo que un asiento en la cuenta
    // equivocada.
    const r = resolverCuentaOrigenPorDefecto(ADMIN, CUENTAS_REALES)
    expect(r.ok).toBe(false)
  })

  test('nunca devuelve una cuenta de otra entidad', () => {
    const r = resolverCuentaOrigenPorDefecto('entidad-sin-cuentas', CUENTAS_REALES)
    expect(r.ok).toBe(false)
  })

  test('EL CANDADO: ninguna cuenta ADMIN, FULL_TAX o "fresnillo" puede salir jamas', () => {
    // Se fuerza el peor caso posible: cada cuenta vetada se le atribuye a la
    // entidad que pide el default, que es la unica manera de que el filtro de
    // pertenencia no la descarte antes. Si el default la devuelve, la prueba
    // falla, y con razon.
    const venenosas: CuentaCandidata[] = [
      { id: 'v-admin', nombre: 'Efectivo', id_entidad: DST, rol_entidad: 'ADMIN', tipo_fiscalidad: 'LIBRE' },
      { id: 'v-fulltax', nombre: 'Caja chica', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'FULL_TAX' },
      { id: 'v-nombre', nombre: 'Cuenta Fresnillo 2', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' },
      { id: 'v-mayus', nombre: 'CUENTA FRESNILLO', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' },
      { id: 'v-mixta', nombre: 'reserva fresnillo mx', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' }
    ]

    for (const cuenta of venenosas) {
      expect(cuentaVetadaComoDefault(cuenta), `${cuenta.id} deberia estar vetada`).toBe(true)

      // Sola: no hay default posible.
      expect(resolverCuentaOrigenPorDefecto(DST, [cuenta]).ok, `${cuenta.id} sola`).toBe(false)
    }

    // Todas juntas: sigue sin haber default.
    expect(resolverCuentaOrigenPorDefecto(DST, venenosas).ok).toBe(false)

    // Y mezcladas con una cuenta buena, sale la buena — nunca una venenosa.
    const buena: CuentaCandidata = {
      id: 'c-buena',
      nombre: 'AAA Efectivo',
      id_entidad: DST,
      rol_entidad: 'DST',
      tipo_fiscalidad: 'LIBRE'
    }
    const mezcla = resolverCuentaOrigenPorDefecto(DST, [...venenosas, buena])
    expect(mezcla).toEqual({ ok: true, idCuenta: 'c-buena' })
  })

  test('con dos cuentas admisibles el default es estable (no cambia entre llamadas)', () => {
    const dos: CuentaCandidata[] = [
      { id: 'c-2', nombre: 'Zeta', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-1', nombre: 'Alfa', id_entidad: DST, rol_entidad: 'DST', tipo_fiscalidad: 'LIBRE' }
    ]
    const primera = resolverCuentaOrigenPorDefecto(DST, dos)
    const segunda = resolverCuentaOrigenPorDefecto(DST, [...dos].reverse())
    expect(primera).toEqual(segunda)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. ERP-80 — el centinela elegido A MANO
//
// El hueco: el centinela nace con rol LOC (para portarse como cualquier
// comprador ante el candado de la cuenta fiscal), y el desplegable del POS le
// ofrece a un ADMIN *todos* los DST y LOC. Elegirlo del desplegable dejaba el
// ticket apuntando al centinela **sin aviso W4**: la consignacion sin dueno
// entraba igual, pero ya sin nada que la delatara.
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-80 · el centinela no se puede elegir a mano', () => {
  test('no es seleccionable como comprador; cualquier otra entidad si', () => {
    expect(esCompradorSeleccionable({ id: ENTIDAD_PENDIENTE_DE_ASIGNAR })).toBe(false)
    expect(esCompradorSeleccionable({ id: DST })).toBe(true)
    expect(esCompradorSeleccionable({ id: ADMIN })).toBe(true)
  })

  test('CONCESION sin comprador: al centinela, con aviso W4', () => {
    expect(resolverCompradorDeVenta('CONCESION', null)).toEqual({
      ok: true,
      idComprador: ENTIDAD_PENDIENTE_DE_ASIGNAR,
      avisoW4: true
    })
    // Cadena vacia y espacios cuentan como ausente.
    expect(resolverCompradorDeVenta('CONCESION', '   ')).toEqual({
      ok: true,
      idComprador: ENTIDAD_PENDIENTE_DE_ASIGNAR,
      avisoW4: true
    })
  })

  test('EL HUECO: CONCESION con el centinela ELEGIDO A MANO tambien genera W4', () => {
    // Antes de ERP-80 esto devolvia avisoW4 = false y el ticket quedaba
    // apuntando al centinela en silencio. La fila termina EXACTAMENTE igual que
    // en el caso de arriba, asi que el aviso tiene que ser el mismo.
    const aMano = resolverCompradorDeVenta('CONCESION', ENTIDAD_PENDIENTE_DE_ASIGNAR)
    expect(aMano).toEqual({
      ok: true,
      idComprador: ENTIDAD_PENDIENTE_DE_ASIGNAR,
      avisoW4: true
    })
    expect(aMano).toEqual(resolverCompradorDeVenta('CONCESION', null))
  })

  test('CONCESION con un comprador de verdad: sin aviso', () => {
    expect(resolverCompradorDeVenta('CONCESION', DST)).toEqual({
      ok: true,
      idComprador: DST,
      avisoW4: false
    })
  })

  test('CONTADO con el centinela: se RECHAZA, no se avisa', () => {
    // No es captura incompleta, es un valor que vino y esta mal: una venta de
    // contado sin comprador ya tiene su forma legitima (comprador vacio =
    // Publico en General), asi que el centinela ahi no significa nada.
    const r = resolverCompradorDeVenta('CONTADO', ENTIDAD_PENDIENTE_DE_ASIGNAR)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Publico en General')
  })

  test('CONTADO normal: comprador tal cual, o null si no vino', () => {
    expect(resolverCompradorDeVenta('CONTADO', DST)).toEqual({
      ok: true,
      idComprador: DST,
      avisoW4: false
    })
    expect(resolverCompradorDeVenta('CONTADO', null)).toEqual({
      ok: true,
      idComprador: null,
      avisoW4: false
    })
  })

  test('el POS filtra por la funcion compartida, no por una lista suelta', () => {
    // Misma idea que `tests/arquitectura.spec.ts`: leer el fuente. Si alguien
    // reescribe el filtro del desplegable a mano, el centinela vuelve a
    // aparecer y esta prueba lo caza antes que un ticket huerfano.
    //
    // El filtro se mudo a `lib/pos-ui.ts` con ERP-81, para poder probarlo sin
    // navegador; el comportamiento se verifica en `tests/cliente-no-bloquea.spec.ts`.
    const pos = readFileSync(join(process.cwd(), 'app/pos/page.tsx'), 'utf-8')
    expect(pos).toContain('filtrarCompradoresPermitidos')

    const posUi = readFileSync(join(process.cwd(), 'lib/pos-ui.ts'), 'utf-8')
    expect(posUi).toContain('esCompradorSeleccionable')
  })

  test('el servidor no le cree a la pantalla: pos.ts resuelve por su cuenta', () => {
    const accion = readFileSync(join(process.cwd(), 'app/actions/pos.ts'), 'utf-8')
    expect(accion).toContain('resolverCompradorDeVenta')

    // Y ya no decide con la pregunta vieja, que era el hueco. Se miran solo las
    // lineas de CODIGO: el bloque de arriba cita la version rota a proposito,
    // para que se entienda que se arreglo, y un `toContain` a secas la caza.
    const codigoVivo = accion
      .split('\n')
      .filter((linea) => !linea.trim().startsWith('//'))
      .join('\n')
    expect(codigoVivo).not.toContain("=== 'CONCESION' && !payload.idComprador")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5. LO QUE ESTA DUPLICADO A PROPOSITO
// ────────────────────────────────────────────────────────────────────────────

test.describe('El UUID del centinela no puede divergir entre TypeScript y Postgres', () => {
  test('lib/avisos.ts y la migracion dicen el mismo UUID', () => {
    // Mismo patron que `tests/candados-base.spec.ts` con la ventana de 12 h:
    // Postgres no lee una constante de TypeScript ni al reves, asi que el numero
    // vive en dos sitios y una prueba vigila que sigan diciendo lo mismo.
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260905120000_cola_de_avisos_de_captura.sql'),
      'utf-8'
    )

    const enLaFuncion = sql.match(
      /entidad_pendiente_de_asignar\(\)[\s\S]*?SELECT '([0-9a-f-]{36})'::uuid/
    )
    expect(enLaFuncion, 'no se encontro el UUID en entidad_pendiente_de_asignar()').not.toBeNull()
    expect(enLaFuncion![1]).toBe(ENTIDAD_PENDIENTE_DE_ASIGNAR)

    // Y la fila que se inserta tiene que ser esa misma.
    expect(sql).toContain(`VALUES ('${ENTIDAD_PENDIENTE_DE_ASIGNAR}', 'PENDIENTE DE ASIGNAR'`)
  })
})
