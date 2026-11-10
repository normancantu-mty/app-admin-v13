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
  formaDeFila,
  validarCategoriaNueva,
  CATALOGO_SEMILLA,
  payloadCanonico,
  sellarPayload,
  selloCoincide,
  type PayloadGasto
} from '../lib/bot-gastos'
import { hoyEnMX } from '../lib/date-format'
import { fechaParaPersona } from '../lib/fechas'

/**
 * AG-01 Fase 1 — las pruebas del bot de gastos.
 *
 * Puras: sin navegador, sin red, sin base. Vigilan las tres cosas que, si se
 * rompen, se rompen en silencio y con dinero de por medio: la lista cerrada, el
 * texto que mueve el pasivo fiscal, y el sello del payload.
 */

const IDENTIDAD = { idCuenta: 'cta-matriz-efectivo', etiqueta: 'kevin' }
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

  test('Insumos SI es alcanzable, pero con SU forma de fila', () => {
    // Norman cerro D-E32 el 2026-09-12: un solo nombre, `Insumos`. Lo que esta
    // prueba impide es que vuelva a colarse como si fuera un `GASTO_OPERATIVO`
    // — que fue exactamente E-237. La forma vive en `formaDeFila`, y hay un
    // describe entero abajo que la vigila.
    expect(CATEGORIAS_GASTO_BOT).toContain('Insumos')
    expect(CATEGORIAS_GASTO_BOT).not.toContain('Compra_Insumos')
    expect(normalizarCategoriaBot('Insumos')).toBe('Insumos')
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
    id_cuenta_origen: null,
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
      id_cuenta_origen: null,
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
        id_cuenta_origen: null,
        usuario_creador: 'telegram:ceo',
        status: 'ANULADO',
        tipo_movimiento: 'INGRESO_VENTA'
      } as Record<string, unknown>,
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.id_cuenta_destino).toBe(IDENTIDAD.idCuenta)
    expect(r.payload.usuario_creador).toBe('telegram:kevin')
    expect(r.payload.status).toBe('ACTIVO')
    expect(r.payload.tipo_movimiento).toBe('GASTO_OPERATIVO')
  })

  test('el autor dice QUIEN de planta, no solo la entidad', () => {
    const r = normalizarPropuesta(
      { monto: 10, categoria: 'Servicios_Basicos', descripcion: 'internet' },
      { idCuenta: 'cta-matriz-efectivo', etiqueta: 'martin' },
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

  // Auditoria 2026-11-04: `new Date('2026-09-11')` es medianoche UTC, o sea el dia 10
  // en Mexico. Se prueba sobre lo que queda escrito, y leido como lo lee cada quien.
  const escrita = (fecha: string, ahora = AHORA) => {
    const r = normalizarPropuesta(
      { monto: 100, categoria: 'Servicios_Basicos', descripcion: 'luz', fecha },
      IDENTIDAD,
      ahora
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    return r
  }

  test('ayer se escribe ayer: en Mexico, en la consulta y en pantalla', () => {
    const f = escrita('2026-09-11').payload.fecha_movimiento
    expect(f).toBe('2026-09-11T18:00:00.000Z')
    expect(hoyEnMX(new Date(f))).toBe('2026-09-11')
    expect(f.slice(0, 10)).toBe('2026-09-11') // lib/bot-consultas.ts
    expect(fechaParaPersona(f)).toBe('11/09/2026')
  })

  test('el primero del mes no se va al mes anterior', () => {
    const f = escrita('2026-11-01', new Date('2026-11-04T18:00:00.000Z')).payload.fecha_movimiento
    expect(hoyEnMX(new Date(f))).toBe('2026-11-01')
  })

  test('hoy es el instante real, sin aviso', () => {
    const r = escrita('2026-09-12')
    expect(r.payload.fecha_movimiento).toBe(AHORA.toISOString())
    expect(r.avisos.join(' ')).not.toContain('futura')
  })

  test('de noche, manana en Mexico es futura aunque en UTC ya sea hoy', () => {
    const noche = new Date('2026-09-13T03:00:00.000Z') // 21:00 del 12 en Mexico
    expect(escrita('2026-09-12', noche).payload.fecha_movimiento).toBe(noche.toISOString())
    const r = escrita('2026-09-13', noche)
    expect(r.payload.fecha_movimiento).toBe(noche.toISOString())
    expect(r.avisos.join(' ')).toContain('futura')
  })

  test('un instante completo se conserva: corregir un gasto de noche no lo mueve de dia', () => {
    // bot/bot_gastos.py `_recaptura_con` manda el `fecha_movimiento` de la fila.
    const noche = '2026-09-11T03:00:00.000Z' // 21:00 del dia 10 en Mexico
    const f = escrita('2026-09-11T03:00:00+00:00').payload.fecha_movimiento
    expect(f).toBe(noche)
    expect(hoyEnMX(new Date(f))).toBe('2026-09-10')
  })

  test('un dia que no existe no se convierte en otro dia', () => {
    const r = escrita('2026-02-31')
    expect(r.payload.fecha_movimiento).toBe(AHORA.toISOString())
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

/**
 * D-E32 cerrada por Norman el 2026-09-12: *"Solamente dejalo como insumos, no
 * hay por que duplicarlo."* Lo que estas pruebas vigilan NO es el nombre — es
 * que el nombre y la FORMA DE FILA no se vuelvan a separar, que es lo que
 * produjo E-237.
 */
test.describe('Insumos escribe la columna opuesta, y eso esta sellado', () => {
  test('Insumos es COMPRA_INSUMOS y el dinero SALE de la cuenta', () => {
    const r = normalizarPropuesta(
      { monto: 1200, categoria: 'Insumos', descripcion: 'agave para el lote 12' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.tipo_movimiento).toBe('COMPRA_INSUMOS')
    expect(r.payload.id_cuenta_origen).toBe(IDENTIDAD.idCuenta)
    expect(r.payload.id_cuenta_destino).toBeNull()
  })

  test('un gasto normal sigue escribiendo destino y deja origen en null', () => {
    const r = normalizarPropuesta(
      { monto: 300, categoria: 'Logistica_Envios', descripcion: 'casetas a Zacatecas' },
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.tipo_movimiento).toBe('GASTO_OPERATIVO')
    expect(r.payload.id_cuenta_destino).toBe(IDENTIDAD.idCuenta)
    expect(r.payload.id_cuenta_origen).toBeNull()
  })

  test('SIEMPRE exactamente una columna con cuenta, en toda la lista cerrada', () => {
    for (const categoria of CATEGORIAS_GASTO_BOT) {
      const r = normalizarPropuesta(
        { monto: 100, categoria, descripcion: 'x' },
        IDENTIDAD,
        AHORA
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const llenas = [r.payload.id_cuenta_origen, r.payload.id_cuenta_destino].filter(
        (v) => v !== null
      )
      expect(llenas, `categoria ${categoria}`).toHaveLength(1)
    }
  })

  test('`Compra_Insumos` NO se acepta: era el duplicado que Norman mando quitar', () => {
    expect(normalizarCategoriaBot('Compra_Insumos')).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
    expect(CATEGORIAS_GASTO_BOT).not.toContain('Compra_Insumos')
  })

  test('mover la cuenta de columna CAMBIA el sello', () => {
    const base: PayloadGasto = {
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Logistica_Envios',
      categoria_gasto: null,
      descripcion: 'casetas',
      monto: 300,
      fecha_movimiento: AHORA.toISOString(),
      id_cuenta_destino: 'cta-a',
      id_cuenta_origen: null,
      usuario_creador: 'telegram:kevin',
      status: 'ACTIVO'
    }
    const movida: PayloadGasto = { ...base, id_cuenta_destino: null, id_cuenta_origen: 'cta-a' }
    expect(sellarPayload(movida)).not.toBe(sellarPayload(base))
    expect(selloCoincide(movida, sellarPayload(base))).toBe(false)
  })

  test('cambiar de cuenta CAMBIA el sello: el boton no puede colarse tras el va', () => {
    const a = normalizarPropuesta(
      { monto: 300, categoria: 'Logistica_Envios', descripcion: 'casetas' },
      { idCuenta: 'cta-a', etiqueta: 'kevin' },
      AHORA
    )
    const b = normalizarPropuesta(
      { monto: 300, categoria: 'Logistica_Envios', descripcion: 'casetas' },
      { idCuenta: 'cta-b', etiqueta: 'kevin' },
      AHORA
    )
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(sellarPayload(a.payload)).not.toBe(sellarPayload(b.payload))
  })

  test('la forma NO se deduce del nombre: es una tabla, y SIN_CATEGORIZAR cae en gasto', () => {
    expect(formaDeFila('Insumos')).toEqual({ tipo: 'COMPRA_INSUMOS', columna: 'origen' })
    expect(formaDeFila(CATEGORIA_SIN_CATEGORIZAR_BOT)).toEqual({
      tipo: 'GASTO_OPERATIVO',
      columna: 'destino'
    })
    expect(formaDeFila('Compra_Insumos')).toEqual({ tipo: 'GASTO_OPERATIVO', columna: 'destino' })
  })
})

/**
 * La lista cerrada crece con el uso (Norman, 2026-09-12: *"los gastos de ahora
 * no son representativos, va a tener que salir con la marcha"*), y ESTA es la
 * puerta por la que crece.
 *
 * Lo que estas pruebas vigilan no es el formato del nombre: es que el nombre
 * no pueda inventar un pago de impuesto. `v_pasivo_fiscal` arma su texto como
 * `categoria || ' ' || categoria_gasto || ' ' || descripcion` — **la columna
 * `categoria` alimenta al clasificador fiscal.**
 */
test.describe('una categoria nueva no puede inventar un pago de impuesto', () => {
  test('un nombre normal pasa', () => {
    const r = validarCategoriaNueva('Comidas_De_Trabajo', CATALOGO_SEMILLA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.nombre).toBe('Comidas_De_Trabajo')
  })

  test('ningun nombre aceptado dispara la vista fiscal, ni con la descripcion pegada', () => {
    // El control que importa: se arma el MISMO texto que concatena la vista y
    // se comprueba sobre el, no sobre el nombre suelto.
    for (const nombre of ['Comidas_De_Trabajo', 'Mantenimiento', 'Impuestos_Y_Tramites']) {
      const r = validarCategoriaNueva(nombre, CATALOGO_SEMILLA)
      expect(r.ok, nombre).toBe(true)
      const textoDeLaVista = `${nombre} ${''} ${'pago de la renta de septiembre'}`.toUpperCase()
      expect(disparadoresFiscalesEn(textoDeLaVista), nombre).toHaveLength(0)
    }
  })

  test('y el control positivo: un nombre fiscal SI se rechaza', () => {
    for (const malo of ['Pago_IVA', 'pago_iva_proveedores', 'FUGA_FISCAL_IVA', 'Pago_IEPS']) {
      const r = validarCategoriaNueva(malo, CATALOGO_SEMILLA)
      expect(r.ok, malo).toBe(false)
    }
  })

  test('no se cuela un duplicado con otra grafia', () => {
    for (const dupe of ['insumos', 'INSUMOS', 'Insumos', 'In_sumos']) {
      const r = validarCategoriaNueva(dupe, CATALOGO_SEMILLA)
      expect(r.ok, dupe).toBe(false)
      if (!r.ok) expect(r.motivo).toContain('ya existe')
    }
  })

  test('formato: nada de espacios, acentos, ni nombres de una letra', () => {
    for (const malo of ['Comidas de trabajo', 'Comidas-Trabajo', 'Ñ', 'ab', '', '1Categoria']) {
      expect(validarCategoriaNueva(malo, CATALOGO_SEMILLA).ok, JSON.stringify(malo)).toBe(false)
    }
  })

  test('SIN_CATEGORIZAR esta reservado', () => {
    expect(validarCategoriaNueva('SIN_CATEGORIZAR', CATALOGO_SEMILLA).ok).toBe(false)
    expect(validarCategoriaNueva('sincategorizar', CATALOGO_SEMILLA).ok).toBe(false)
  })

  test('la categoria nueva NO pisa a una existente: primero se empata', () => {
    // Aunque el modelo mande las dos cosas, gana la que ya existe.
    const r = normalizarPropuesta(
      {
        monto: 300,
        categoria: 'Logistica_Envios',
        categoria_nueva: 'Gasolinas',
        descripcion: 'casetas'
      } as Record<string, unknown>,
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.categoria).toBe('Logistica_Envios')
    expect(r.categoriaNueva).toBeNull()
  })

  test('una nueva valida entra, se marca, y nace con forma de GASTO', () => {
    const r = normalizarPropuesta(
      {
        monto: 600,
        categoria: null,
        categoria_nueva: 'Comidas_De_Trabajo',
        descripcion: 'comimos Kevin y yo'
      } as Record<string, unknown>,
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.categoria).toBe('Comidas_De_Trabajo')
    expect(r.categoriaNueva).toBe('Comidas_De_Trabajo')
    expect(r.payload.tipo_movimiento).toBe('GASTO_OPERATIVO')
    expect(r.payload.id_cuenta_destino).toBe(IDENTIDAD.idCuenta)
    expect(r.avisos.join(' ')).toContain('NUEVA')
  })

  test('una nueva fiscal NO entra: cae a SIN_CATEGORIZAR y lo dice', () => {
    const r = normalizarPropuesta(
      {
        monto: 600,
        categoria: null,
        categoria_nueva: 'Pago_IVA_Proveedores',
        descripcion: 'lo de siempre'
      } as Record<string, unknown>,
      IDENTIDAD,
      AHORA
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.categoria).toBe(CATEGORIA_SIN_CATEGORIZAR_BOT)
    expect(r.categoriaNueva).toBeNull()
    expect(r.avisos.join(' ')).toContain('impuesto')
  })
})
