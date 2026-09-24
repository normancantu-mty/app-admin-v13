/**
 * FASE 9 — Bloque C: grupos, identidad por persona, permisos, maker-checker.
 * Puras, sin base.
 *
 * - D94: la identidad es la PERSONA; el VA de B sobre el borrador de A es 403
 *   aunque esten en el mismo grupo. El `chat_id` viaja aparte.
 * - D96: la tabla de permisos (rol x accion, rol x consulta, privado en grupo).
 * - D97: el abono de un DST entra PENDIENTE; el de Norman, REAL (control).
 * - D98: el VA de Kevin espera; el Aprobar de Norman escribe.
 * - D99: "quien debe" con concesion + cobrado por entregar; precios.
 * - D95: la etiqueta y el nombre del registro.
 *
 * Mutaciones que ponen esto rojo (corridas, ver `_avance_fase9`):
 *   · en `decidirPuerta`, `esperar` -> `directo` (Kevin escribe sin Norman).
 *   · en `decidirPuerta`, quitar el `dueno !== quien` de PENDIENTE.
 *   · en `permisoDeAccion`, DST -> `no` para todo.
 *   · en `entidadesAlcanzables`, no agregar los hijos (la red sin locales).
 */
import { test, expect } from '@playwright/test'
import {
  chatDelBorrador,
  entidadesAlcanzables,
  esAprobador,
  esNorman,
  esGrupo,
  puedeAprobar,
  permisoDeAccion,
  permisoDeConsulta,
  type AccionBot,
  type ActorBot
} from '@/lib/bot-permisos'
import { decidirPuerta, puedeCancelar, type HechosDeLaPuerta } from '@/lib/bot-aprobacion'
import { NOTA_EFECTIVO_NO_SEPARABLE, textoPrecios, textoQuienDebe } from '@/lib/bot-consultas'
import { etiquetaDeNombre, nombreDelRegistro, sellarMiembro, selloMiembroCoincide } from '@/lib/bot-miembro'
import { filasDeAbono, type PayloadAbono } from '@/lib/bot-abonos'
import { CATEGORIA_ABONO_PENDIENTE, CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'
import type { FilaCarteraVista } from '@/lib/vistas'

const NORMAN: ActorBot = { rol: 'ADMIN', requiereAprobacion: false }
const KEVIN: ActorBot = { rol: 'ADMIN', requiereAprobacion: true }
const DST: ActorBot = { rol: 'DST', requiereAprobacion: false }
const LOC: ActorBot = { rol: 'LOC', requiereAprobacion: false }

const ID_NORMAN = 111
const ID_KEVIN = 222
const ID_GILBERTO = 333
const GRUPO = -1001234567890

test.describe('D96 — la tabla de acciones', () => {
  const ESPERADO: Record<string, Record<AccionBot, string>> = {
    Norman: {
      venta: 'si', abono: 'si', cotizacion: 'si', gasto: 'si', lote: 'si',
      entrada_insumo: 'si', convertir: 'si', entidad: 'si', registrar: 'si',
      entrega_efectivo: 'si'
    },
    Kevin: {
      venta: 'aprobacion', abono: 'aprobacion', cotizacion: 'aprobacion', gasto: 'aprobacion',
      lote: 'aprobacion', entrada_insumo: 'aprobacion', convertir: 'aprobacion',
      entidad: 'aprobacion', registrar: 'no', entrega_efectivo: 'aprobacion'
    },
    DST: {
      // FASE 10 (D106): convertir SOLO SUS cotizaciones (la propiedad, en la ruta:
      // `tests/bot-rutas-permisos.spec.ts`); alta de clientes, solo Norman.
      venta: 'si', abono: 'si', cotizacion: 'si', gasto: 'no', lote: 'no',
      entrada_insumo: 'no', convertir: 'si', entidad: 'no', registrar: 'no',
      // FASE 11 (D112): SOLO la suya y siempre espera (`decidirEntrega`,
      // `tests/entrega-efectivo.spec.ts`).
      entrega_efectivo: 'si'
    },
    LOC: {
      venta: 'no', abono: 'no', cotizacion: 'no', gasto: 'no', lote: 'no',
      entrada_insumo: 'no', convertir: 'no', entidad: 'no', registrar: 'no',
      entrega_efectivo: 'no'
    }
  }
  const ACTORES: Record<string, ActorBot> = { Norman: NORMAN, Kevin: KEVIN, DST, LOC }

  for (const [nombre, fila] of Object.entries(ESPERADO)) {
    for (const [accion, veredicto] of Object.entries(fila)) {
      test(`${nombre} x ${accion} = ${veredicto}`, () => {
        expect(permisoDeAccion(ACTORES[nombre], accion as AccionBot)).toBe(veredicto)
      })
    }
  }

  test('CONTROL: un rol desconocido no hace nada', () => {
    expect(permisoDeAccion({ rol: 'SOCIO', requiereAprobacion: false }, 'venta')).toBe('no')
  })

  // FASE 10 (D106): "Yo, Kevin". Aprueban los dos ADMIN; nadie aprueba lo suyo.
  test('Norman y Kevin son aprobadores; DST y LOC no', () => {
    expect([NORMAN, KEVIN, DST, LOC].map(esAprobador)).toEqual([true, true, false, false])
  })

  test('D106 maker-checker: nadie aprueba lo suyo; lo de Kevin, solo Norman', () => {
    const p = (a: ActorBot, id: number) => ({ ...a, telegramId: id })
    expect(puedeAprobar(p(KEVIN, ID_KEVIN), p(DST, ID_GILBERTO))).toBe(true)
    expect(puedeAprobar(p(NORMAN, ID_NORMAN), p(DST, ID_GILBERTO))).toBe(true)
    expect(puedeAprobar(p(NORMAN, ID_NORMAN), p(KEVIN, ID_KEVIN))).toBe(true)
    expect(puedeAprobar(p(KEVIN, ID_KEVIN), p(KEVIN, ID_KEVIN))).toBe(false)
    expect(puedeAprobar(p(NORMAN, ID_NORMAN), p(NORMAN, ID_NORMAN))).toBe(false)
    // Otra identidad con marca no aprueba lo de Kevin.
    expect(puedeAprobar(p(KEVIN, 999), p(KEVIN, ID_KEVIN))).toBe(false)
    // Kevin si aprueba lo que espera de un tercero con marca (un DST).
    expect(puedeAprobar(p(KEVIN, ID_KEVIN), p({ rol: 'DST', requiereAprobacion: true }, ID_GILBERTO))).toBe(true)
    expect(puedeAprobar(p(DST, ID_GILBERTO), p(KEVIN, ID_KEVIN))).toBe(false)
  })

  test('registrar sigue siendo solo de Norman (Kevin aprueba, no registra)', () => {
    expect(esNorman(NORMAN)).toBe(true)
    expect(esNorman(KEVIN)).toBe(false)
    expect(permisoDeAccion(KEVIN, 'registrar')).toBe('no')
  })
})

test.describe('D96 — la tabla de consultas, en privado y en grupo', () => {
  test('ADMIN (Norman y Kevin) ve todo; deuda, ventas y produccion por privado', () => {
    for (const a of [NORMAN, KEVIN]) {
      expect(permisoDeConsulta(a, 'inventario')).toEqual({ ok: true, alcance: 'todo', privado: false })
      expect(permisoDeConsulta(a, 'precios')).toEqual({ ok: true, alcance: 'todo', privado: false })
      expect(permisoDeConsulta(a, 'deuda')).toEqual({ ok: true, alcance: 'todo', privado: true })
      expect(permisoDeConsulta(a, 'ventas')).toEqual({ ok: true, alcance: 'todo', privado: true })
      expect(permisoDeConsulta(a, 'produccion')).toEqual({ ok: true, alcance: 'todo', privado: true })
    }
  })

  test('DST: su red; ventas y produccion no', () => {
    expect(permisoDeConsulta(DST, 'inventario')).toEqual({ ok: true, alcance: 'red', privado: false })
    expect(permisoDeConsulta(DST, 'deuda')).toEqual({ ok: true, alcance: 'red', privado: false })
    expect(permisoDeConsulta(DST, 'ventas')).toEqual({ ok: false })
    expect(permisoDeConsulta(DST, 'produccion')).toEqual({ ok: false })
  })

  test('LOC: lo propio; ventas y produccion no', () => {
    expect(permisoDeConsulta(LOC, 'precios')).toEqual({ ok: true, alcance: 'propio', privado: false })
    expect(permisoDeConsulta(LOC, 'ventas')).toEqual({ ok: false })
  })

  test('grupo vs privado: en privado el chat ES la persona', () => {
    expect(esGrupo(ID_NORMAN, ID_NORMAN)).toBe(false)
    expect(esGrupo(undefined, ID_NORMAN)).toBe(false)
    expect(esGrupo(GRUPO, ID_NORMAN)).toBe(true)
    expect(chatDelBorrador(GRUPO, ID_KEVIN)).toBe(GRUPO)
    expect(chatDelBorrador(undefined, ID_KEVIN)).toBe(ID_KEVIN)
  })
})

test.describe('D94/D98 — la puerta del VA', () => {
  const hechos = (h: Partial<HechosDeLaPuerta>): HechosDeLaPuerta => ({
    estado: 'PENDIENTE',
    dueno: ID_GILBERTO,
    quien: ID_GILBERTO,
    quienRol: 'DST',
    quienRequiereAprobacion: false,
    ...h
  })

  test('CONTROL: el dueno da VA a lo suyo y se escribe directo', () => {
    expect(decidirPuerta(hechos({}))).toEqual({ ok: true, modo: 'directo' })
  })

  test('D94: el VA de B sobre el borrador de A, en el mismo grupo, es 403', () => {
    const d = decidirPuerta(hechos({ quien: ID_KEVIN, quienRol: 'ADMIN', quienRequiereAprobacion: true }))
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  test('D94: ni Norman da VA al borrador PENDIENTE de otro', () => {
    const d = decidirPuerta(hechos({ quien: ID_NORMAN, quienRol: 'ADMIN' }))
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  test('D98: el VA de Kevin NO escribe: espera', () => {
    const d = decidirPuerta(
      hechos({ dueno: ID_KEVIN, quien: ID_KEVIN, quienRol: 'ADMIN', quienRequiereAprobacion: true })
    )
    expect(d).toEqual({ ok: true, modo: 'esperar' })
  })

  test('D98: el Aprobar de Norman sobre lo de Kevin escribe', () => {
    const d = decidirPuerta(
      hechos({ estado: 'ESPERA_APROBACION', dueno: ID_KEVIN, quien: ID_NORMAN, quienRol: 'ADMIN' })
    )
    expect(d).toEqual({ ok: true, modo: 'aprobar' })
  })

  test('D98/D106: Kevin no se aprueba a si mismo (403: nadie aprueba lo suyo)', () => {
    const d = decidirPuerta(
      hechos({
        estado: 'ESPERA_APROBACION',
        dueno: ID_KEVIN,
        quien: ID_KEVIN,
        quienRol: 'ADMIN',
        quienRequiereAprobacion: true
      })
    )
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  test('D106: Kevin aprueba lo que espera de un tercero', () => {
    const d = decidirPuerta(
      hechos({
        estado: 'ESPERA_APROBACION',
        dueno: ID_GILBERTO,
        duenoRol: 'DST',
        duenoRequiereAprobacion: true,
        quien: ID_KEVIN,
        quienRol: 'ADMIN',
        quienRequiereAprobacion: true
      })
    )
    expect(d).toEqual({ ok: true, modo: 'aprobar' })
  })

  test('D106: un autor sin dato de marca se trata como Kevin (Kevin no lo aprueba)', () => {
    const d = decidirPuerta(
      hechos({ estado: 'ESPERA_APROBACION', dueno: ID_GILBERTO, quien: ID_KEVIN, quienRol: 'ADMIN', quienRequiereAprobacion: true })
    )
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  test('D98: un DST no aprueba lo que espera a Norman', () => {
    const d = decidirPuerta(hechos({ estado: 'ESPERA_APROBACION', dueno: ID_KEVIN, quien: ID_GILBERTO }))
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  test('un borrador ya CONFIRMADO no vuelve a pasar', () => {
    expect(decidirPuerta(hechos({ estado: 'CONFIRMADO' }))).toMatchObject({ ok: false, status: 409 })
  })

  test('cancelar: el dueno si; otro no; Norman solo lo que espera su Aprobar', () => {
    expect(puedeCancelar(hechos({}))).toBe(true)
    expect(puedeCancelar(hechos({ quien: ID_NORMAN, quienRol: 'ADMIN' }))).toBe(false)
    expect(
      puedeCancelar(hechos({ estado: 'ESPERA_APROBACION', dueno: ID_KEVIN, quien: ID_NORMAN, quienRol: 'ADMIN' }))
    ).toBe(true)
    expect(
      puedeCancelar(hechos({ estado: 'ESPERA_APROBACION', dueno: ID_KEVIN, quien: ID_GILBERTO }))
    ).toBe(false)
  })
})

test.describe('D96 — la red de un DST', () => {
  const ENTIDADES = [
    { id: 'dst-a', id_padre: null, id_nodo_padre: null },
    { id: 'loc-a1', id_padre: 'dst-a', id_nodo_padre: null },
    { id: 'loc-a2', id_padre: null, id_nodo_padre: 'dst-a' },
    { id: 'dst-b', id_padre: null, id_nodo_padre: null },
    { id: 'loc-b1', id_padre: 'dst-b', id_nodo_padre: null }
  ]

  test('un DST ve lo suyo y sus locales, por cualquiera de las dos columnas', () => {
    expect([...entidadesAlcanzables('red', 'dst-a', ENTIDADES)!].sort()).toEqual(['dst-a', 'loc-a1', 'loc-a2'])
  })

  test('y no ve al otro DST ni sus locales', () => {
    const red = entidadesAlcanzables('red', 'dst-a', ENTIDADES)!
    expect(red.has('dst-b')).toBe(false)
    expect(red.has('loc-b1')).toBe(false)
  })

  test('un LOC solo lo propio; el ADMIN todo (null)', () => {
    expect([...entidadesAlcanzables('propio', 'loc-a1', ENTIDADES)!]).toEqual(['loc-a1'])
    expect(entidadesAlcanzables('todo', 'x', ENTIDADES)).toBeNull()
  })
})

test.describe('D97 — el abono de un DST entra PENDIENTE', () => {
  const abono: PayloadAbono = {
    id_entidad: 'dst-a',
    id_cuenta_origen: 'c-origen',
    id_cuenta_destino: 'c-matriz',
    monto: 1500,
    fecha_movimiento: '2026-09-23',
    metodo_pago: 'Efectivo',
    referencia: 'Abono de Deuda (Distribuidor -> Admin)',
    nota: '',
    usuario_creador: 'telegram:gilberto',
    aplicaciones: [],
    sobrante: 1500
  }

  test('CONTROL: el abono que captura Norman es REAL, como siempre', () => {
    expect(filasDeAbono(abono).map((f) => f.categoria)).toEqual([CATEGORIA_ABONO_REAL])
  })

  test('el de un DST es PENDIENTE y suma lo mismo', () => {
    const filas = filasDeAbono(abono, false)
    expect(filas.map((f) => f.categoria)).toEqual([CATEGORIA_ABONO_PENDIENTE])
    expect(filas.reduce((s, f) => s + f.monto, 0)).toBe(1500)
  })
})

test.describe('D99 — quien debe, completo', () => {
  const base = { rol: 'DST', calculado_en: null } as unknown as FilaCarteraVista
  const filas = [
    { ...base, id_entidad: 'a', nombre: 'Aeropuerto', deuda: 1000 },
    { ...base, id_entidad: 'b', nombre: 'Casa Verde', deuda: 0 },
    { ...base, id_entidad: 'c', nombre: 'Sin nada', deuda: 0 }
  ] as FilaCarteraVista[]

  // D104 (Fase 10): la linea de efectivo se oculta porque el ERP no separa la
  // entrega del pago de concesion (tabla en el _avance de la Fase 10).
  test('D104: el total es la suma de la concesion y dice por que no hay efectivo', () => {
    const t = textoQuienDebe(filas)
    expect(t).toContain('QUIEN DEBE — $1,000.00 de concesion')
    expect(t).toContain('Aeropuerto (DST) — debe $1,000.00 de concesion')
    expect(t).toContain(NOTA_EFECTIVO_NO_SEPARABLE)
    expect(t).not.toContain('cobrado por entregar')
    expect(t).not.toContain('Sin nada')
  })

  // FASE 11 (D110): hasta la Fase 10 esta prueba sumaba una lista escrita a
  // mano (que ademas omitia a Ale Ortega, $2,040) y comparaba contra la suma de
  // ESA MISMA lista: pasaba con cualquier lista. Ahora el total esperado es un
  // literal calculado aparte (centavos y miles incluidos), y la cifra real se
  // mide donde vive: `v_cartera` contra `construirCartera` en
  // `tests/vistas-equivalencia.spec.ts` (sobre la base, al centavo).
  test('D110: el total del bot es la suma de las filas, con centavos y miles', () => {
    const f = [
      { ...base, id_entidad: 'x1', nombre: 'Uno', deuda: 11852.01 },
      { ...base, id_entidad: 'x2', nombre: 'Dos', deuda: 9012.93 },
      { ...base, id_entidad: 'x3', nombre: 'Tres', deuda: 2040 },
      { ...base, id_entidad: 'x4', nombre: 'Cero', deuda: 0 }
    ] as FilaCarteraVista[]
    // 11852.01 + 9012.93 + 2040 = 22904.94, sumado a mano, no con reduce.
    const t = textoQuienDebe(f)
    expect(t).toContain('QUIEN DEBE — $22,904.94 de concesion')
    expect(t).toContain('Tres (DST) — debe $2,040.00 de concesion')
    expect(t).not.toContain('Cero')
  })

  test('CONTROL D104: un filtro sin concesion no afirma que no tenga efectivo', () => {
    const t = textoQuienDebe([filas[1]], 'casa verde')
    expect(t).toContain('no te debe nada de concesion hoy')
    expect(t).toContain(NOTA_EFECTIVO_NO_SEPARABLE)
    expect(t).not.toContain('ni tiene cobrado por entregar')
  })
})

test.describe('D99 — precios', () => {
  const r = [{ producto: 'Plata 750', publico: 580, entidad: 406 }]
  test('con entidad: los dos precios', () => {
    expect(textoPrecios(r, 'Aeropuerto', 'DST')).toContain('Plata 750: publico $580.00 · a Aeropuerto $406.00')
  })
  test('CONTROL: sin entidad, solo el publico', () => {
    const t = textoPrecios([{ ...r[0], entidad: null }], null)
    expect(t).toContain('PRECIOS AL PUBLICO')
    expect(t).not.toContain('$406.00')
  })
})

test.describe('D95 — el registro de un miembro', () => {
  test('el nombre que dijo Norman', () => {
    expect(nombreDelRegistro('este es Gilberto')).toBe('Gilberto')
    expect(nombreDelRegistro('/registrar José Luis')).toBe('José Luis')
    expect(nombreDelRegistro('es Kevin.')).toBe('Kevin')
    expect(nombreDelRegistro('Ale')).toBe('Ale')
  })

  test('la etiqueta: sin acentos, unica', () => {
    expect(etiquetaDeNombre('José Luis', new Set())).toBe('jose_luis')
    expect(etiquetaDeNombre('Kevin', new Set(['kevin']))).toBe('kevin2')
    expect(etiquetaDeNombre('?', new Set())).toBeNull()
  })

  test('el sello del alta cubre requiere_aprobacion', () => {
    const alta = {
      telegram_id: ID_KEVIN,
      etiqueta: 'kevin',
      id_entidad: 'matriz',
      id_cuenta_destino: 'c',
      requiere_aprobacion: true,
      creado_por: 'telegram:norman'
    }
    const sello = sellarMiembro(alta)
    expect(selloMiembroCoincide(alta, sello)).toBe(true)
    expect(selloMiembroCoincide({ ...alta, requiere_aprobacion: false }, sello)).toBe(false)
  })
})
