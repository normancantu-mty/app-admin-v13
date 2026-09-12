import { test, expect } from '@playwright/test'
import {
  CATEGORIAS_GASTO_BOT,
  CATEGORIA_SIN_CATEGORIZAR_BOT,
  DISPARADORES_FISCALES,
  buscarDuplicado,
  desactivarTextoFiscal,
  disparadoresFiscalesEn,
  normalizarCategoriaBot,
  normalizarPropuesta,
  payloadCanonico,
  sellarPayload,
  selloCoincide,
  type PayloadGasto
} from '../lib/bot-gastos'

/**
 * AG-01 Fase 1 — las pruebas del bot de gastos.
 *
 * Puras: sin navegador, sin red, sin base. Vigilan las tres cosas que, si se
 * rompen, se rompen en silencio y con dinero de por medio: la lista cerrada, el
 * texto que mueve el pasivo fiscal, y el sello del payload.
 */

const IDENTIDAD = { idCuentaDestino: 'cta-matriz-efectivo', etiqueta: 'kevin' }
const AHORA = new Date('2026-09-12T18:00:00.000Z')

test.describe('la categoria sale de una lista cerrada y nunca del LLM', () => {
  test('empata exacto, y solo exacto', () => {
    expect(normalizarCategoriaBot('Logistica_Envios')).toBe('Logistica_Envios')
    expect(normalizarCategoriaBot(' Logistica_Envios ')).toBe('Logistica_Envios')
  })

  test('lo que no esta en la lista NO se aproxima: cae al centinela', () => {
    // El vecino mas cercano es exactamente lo que produjo las 20 variantes de
    // texto libre que ya tiene `categoria_gasto` en produccion.
    const inventadas = ['logistica', 'Logistica Envios', 'Gasolina', 'Combustible', 'LOGISTICA_ENVIOS', '']
    for (const inventada of inventadas) {
      expect(normalizarCategoriaBot(inventada)).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
    }
    expect(normalizarCategoriaBot(null)).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
    expect(normalizarCategoriaBot({ categoria: 'Insumos' })).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
  })

  test('Insumos NO es alcanzable por este camino, y es a proposito', () => {
    // Medido contra produccion el 2026-09-12: `Insumos` es categoria de
    // `COMPRA_INSUMOS` (18 filas, escriben `id_cuenta_origen`), no de
    // `GASTO_OPERATIVO` (que escribe `id_cuenta_destino`). Son dos formas de
    // fila distintas. Si alguien mete `Insumos` a esta lista sin cambiar que
    // columna se llena, esta prueba truena y le dice por que.
    expect(CATEGORIAS_GASTO_BOT).not.toContain('Insumos')
    expect(CATEGORIAS_GASTO_BOT).not.toContain('Compra_Insumos')
    expect(normalizarCategoriaBot('Insumos')).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
  })
})

test.describe('el texto del LLM no puede mover v_pasivo_fiscal', () => {
  test('las seis cadenas que SI disparan, disparan', () => {
    for (const cadena of DISPARADORES_FISCALES) {
      expect(disparadoresFiscalesEn('gasto de ' + cadena.toLowerCase() + ' de agosto')).toContain(cadena)
    }
  })

  test('pago del IVA de agosto NO dispara: la correccion medida a PROMPT 21', () => {
    // La subcadena literal de la vista es `PAGO IVA`. `PAGO DEL IVA DE AGOSTO`
    // no la contiene. Escribir la prueba con esta frase la dejaria en verde sin
    // probar nada, que es peor que no tenerla.
    expect(disparadoresFiscalesEn('pago del IVA de agosto')).toEqual([])
    // La que si dispara, y es igual de natural de dictar:
    expect(disparadoresFiscalesEn('pago IVA de agosto')).toEqual(['PAGO IVA'])
  })

  test('desactivar deja el texto legible y sin poder disparar', () => {
    const original = 'pago IVA de agosto y el IEPS del trimestre'
    expect(disparadoresFiscalesEn(original).length).toBeGreaterThan(0)

    const desactivado = desactivarTextoFiscal(original)
    expect(disparadoresFiscalesEn(desactivado)).toEqual([])
    expect(desactivado).toContain('I.V.A.')
    expect(desactivado).toContain('I.E.P.S.')
    // Sigue siendo legible: no se borro la frase, se desactivo.
    expect(desactivado).toContain('pago')
    expect(desactivado).toContain('agosto')
  })

  test('un gasto dictado con pago IVA entra desactivado y avisado', () => {
    const r = normalizarPropuesta(
      { monto: 340, categoria: 'Servicios_Basicos', descripcion: 'pago IVA de agosto' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(disparadoresFiscalesEn(r.payload.descripcion)).toEqual([])
    expect(r.descripcionOriginal).toBe('pago IVA de agosto')
    expect(r.avisos.join(' ')).toContain('PAGO IVA')
  })

  test('la descripcion JAMAS se copia a categoria_gasto', () => {
    // `app/api/finanzas/nuevo/route.ts:155` si lo hace
    // (`categoria_gasto: descripcion ?? subcategoria`) y es la mitad del
    // agujero fiscal: la vista concatena los tres campos. El bot no lo hereda.
    const r = normalizarPropuesta(
      { monto: 500, categoria: 'Logistica_Envios', descripcion: 'pago IVA gasolina' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.categoria_gasto).toBeNull()
  })
})

function payloadDePrueba(): PayloadGasto {
  return {
    tipo_movimiento: 'GASTO_OPERATIVO',
    categoria: 'Logistica_Envios',
    categoria_gasto: null,
    descripcion: 'gasolina yendo a Zacatecas',
    monto: 340,
    fecha_movimiento: '2026-09-12T18:00:00.000Z',
    id_cuenta_destino: 'cta-matriz-efectivo',
    usuario_creador: 'telegram:kevin',
    status: 'ACTIVO'
  }
}

test.describe('el sello vigila el contenido, no el formato', () => {
  test('el orden de las llaves no cambia el sello', () => {
    const a = payloadDePrueba()
    const b: PayloadGasto = {
      status: 'ACTIVO',
      monto: 340,
      usuario_creador: 'telegram:kevin',
      descripcion: 'gasolina yendo a Zacatecas',
      id_cuenta_destino: 'cta-matriz-efectivo',
      categoria_gasto: null,
      fecha_movimiento: '2026-09-12T18:00:00.000Z',
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Logistica_Envios'
    }
    expect(payloadCanonico(a)).toBe(payloadCanonico(b))
    expect(sellarPayload(a)).toBe(sellarPayload(b))
  })

  test('ENSENADO FALLANDO: alterar el payload despues de sellar lo rechaza', () => {
    const propuesto = payloadDePrueba()
    const sello = sellarPayload(propuesto)
    expect(selloCoincide(propuesto, sello)).toBe(true)

    // Cada uno es un ataque distinto, y los seis se rechazan:
    const alterados: Array<[string, PayloadGasto]> = [
      ['le suben el monto', { ...propuesto, monto: 3400 }],
      ['le cambian la categoria', { ...propuesto, categoria: 'Nomina_y_Honorarios' }],
      ['le meten texto fiscal', { ...propuesto, descripcion: 'pago IVA de agosto' }],
      ['le cambian la cuenta', { ...propuesto, id_cuenta_destino: 'cta-fresnillo' }],
      ['le cambian el autor', { ...propuesto, usuario_creador: 'telegram:otro' }],
      ['reviven categoria_gasto', { ...propuesto, categoria_gasto: 'pago IVA' as unknown as null }]
    ]
    for (const [ataque, payload] of alterados) {
      expect(selloCoincide(payload, sello), ataque).toBe(false)
    }
  })

  test('un sello con otro formato no cuela', () => {
    const p = payloadDePrueba()
    expect(selloCoincide(p, '')).toBe(false)
    expect(selloCoincide(p, sellarPayload(p).slice(0, 40))).toBe(false)
    expect(selloCoincide(p, sellarPayload(p).toUpperCase())).toBe(true)
  })
})

test.describe('lo que el LLM manda NO decide los campos del sistema', () => {
  test('cuenta, autor y status entran por identidad, no por la propuesta', () => {
    // El ataque: el modelo (o quien le dicte al modelo) intenta colar los tres
    // campos que deciden DE QUIEN es el dinero y si la fila cuenta.
    const r = normalizarPropuesta(
      {
        monto: 340,
        categoria: 'Logistica_Envios',
        descripcion: 'gasolina',
        id_cuenta_destino: 'cta-fresnillo',
        usuario_creador: 'telegram:ceo',
        status: 'ANULADO',
        tipo_movimiento: 'INGRESO_VENTA'
      } as Record<string, unknown>,
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.id_cuenta_destino).toBe(IDENTIDAD.idCuentaDestino)
    expect(r.payload.usuario_creador).toBe('telegram:kevin')
    expect(r.payload.status).toBe('ACTIVO')
    expect(r.payload.tipo_movimiento).toBe('GASTO_OPERATIVO')
  })

  test('el autor dice QUIEN de planta, no solo la entidad', () => {
    const r = normalizarPropuesta(
      { monto: 10, categoria: 'Servicios_Basicos', descripcion: 'internet' },
      { idCuentaDestino: 'cta-matriz-efectivo', etiqueta: 'martin' },
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.usuario_creador).toBe('telegram:martin')
  })

  test('sin monto o sin concepto no hay propuesta', () => {
    expect(normalizarPropuesta({ categoria: 'Servicios_Basicos', descripcion: 'luz' }, IDENTIDAD, AHORA).ok).toBe(false)
    expect(normalizarPropuesta({ monto: 0, descripcion: 'luz' }, IDENTIDAD, AHORA).ok).toBe(false)
    expect(normalizarPropuesta({ monto: -5, descripcion: 'luz' }, IDENTIDAD, AHORA).ok).toBe(false)
    expect(normalizarPropuesta({ monto: 100 }, IDENTIDAD, AHORA).ok).toBe(false)
  })

  test('un gasto sin categoria mapeable ENTRA, no se rechaza', () => {
    // Es la leccion de ERP-59: el sistema no se limpia quedandose vacio.
    const r = normalizarPropuesta(
      { monto: 340, categoria: 'Gasolina', descripcion: 'gasolina a Zacatecas' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.categoria).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
    expect(r.faltaCategoria).toBe(true)
    expect(r.avisos.join(' ')).toContain('SIN_CATEGORIZAR')
  })

  test('la fecha futura se ancla a hoy', () => {
    const r = normalizarPropuesta(
      { monto: 100, categoria: 'Servicios_Basicos', descripcion: 'luz', fecha: '2027-01-01' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.fecha_movimiento).toBe(AHORA.toISOString())
    expect(r.avisos.join(' ')).toContain('futura')
  })

  test('el monto se redondea a dos decimales o el sello no empata consigo mismo', () => {
    const r = normalizarPropuesta(
      { monto: 340.456789, categoria: 'Servicios_Basicos', descripcion: 'luz' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.monto).toBe(340.46)
  })
})

test.describe('duplicados: avisa, no bloquea', () => {
  const reciente = (min: number, monto: number, categoria: string) => ({
    id: 'x' + min + monto,
    monto,
    categoria,
    descripcion: 'gasolina',
    fecha_movimiento: new Date(AHORA.getTime() - min * 60000).toISOString(),
    usuario_creador: 'telegram:kevin'
  })

  test('mismo monto y categoria dentro de la ventana: avisa', () => {
    const d = buscarDuplicado(
      { monto: 340, categoria: 'Logistica_Envios' },
      [reciente(20, 340, 'Logistica_Envios')],
      AHORA
    )
    expect(d).not.toBeNull()
  })

  test('dentro del 5 por ciento tambien cuenta', () => {
    expect(buscarDuplicado({ monto: 340, categoria: 'Logistica_Envios' }, [reciente(20, 350, 'Logistica_Envios')], AHORA)).not.toBeNull()
    expect(buscarDuplicado({ monto: 340, categoria: 'Logistica_Envios' }, [reciente(20, 400, 'Logistica_Envios')], AHORA)).toBeNull()
  })

  test('otra categoria o fuera de las 6 h no es duplicado', () => {
    expect(buscarDuplicado({ monto: 340, categoria: 'Logistica_Envios' }, [reciente(20, 340, 'Servicios_Basicos')], AHORA)).toBeNull()
    expect(buscarDuplicado({ monto: 340, categoria: 'Logistica_Envios' }, [reciente(7 * 60, 340, 'Logistica_Envios')], AHORA)).toBeNull()
  })

  test('con varios parecidos gana el mas reciente: es el que la persona reconoce', () => {
    const d = buscarDuplicado(
      { monto: 340, categoria: 'Logistica_Envios' },
      [reciente(200, 340, 'Logistica_Envios'), reciente(15, 341, 'Logistica_Envios')],
      AHORA
    )
    expect(d?.monto).toBe(341)
  })
})
