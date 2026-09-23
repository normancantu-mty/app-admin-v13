/**
 * AG-05 Fase 3 — Pruebas puras del LOTE por Telegram.
 *
 * ─── DE DONDE SALEN LOS FIXTURES ────────────────────────────────────────────
 * **Copiados de produccion el 2026-09-18.** Insumos reales: Chile Guajillo
 * (KILOGRAMOS, sku `chile-guajillo`), Agua de proceso (LITROS, `agua`),
 * Ingrediente Az y Aditivo Mosto 1 (los dos KILOGRAMOS). Formatos reales: los
 * tres `TERMINADO` con `ml_por_unidad` — 750, 250 y 50.
 *
 * ─── LO QUE ESTAS PRUEBAS **NO** COMPRUEBAN, Y ES A PROPOSITO ───────────────
 * El rendimiento. Ni alcohol absoluto, ni litros al grado objetivo, ni botellas
 * teoricas. **Esa aritmetica no existe en TypeScript** (D-198): vive en
 * `v_lote_rendimiento`, en SQL. Lo que si se comprueba aqui es justamente eso —
 * que `lib/bot-lotes.ts` no la reimplementa (ver el ultimo bloque).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import {
  buscarFormato,
  buscarInsumo,
  codigoSugerido,
  fechaLocal,
  LLAVES_LOTE,
  mensajeDeConfirmacionLote,
  mensajeDeRendimiento,
  normalizarLote,
  sellarLote,
  selloLoteCoincide,
  sumarDias,
  TOPE_LITROS_TANDA,
  type ContextoLote,
  type FormatoDeBotella,
  type InsumoDelCatalogo
} from '@/lib/bot-lotes'

const CHILE: InsumoDelCatalogo = {
  id: 'd71fbfb1-0c1e-4704-b355-2afb568ec87f',
  sku: 'chile-guajillo',
  nombre: 'Chile Guajillo',
  unidad_medida: 'KILOGRAMOS'
}
const AGUA: InsumoDelCatalogo = {
  id: 'a5bc0b05-9a99-409e-852b-db8e8f8e58b9',
  sku: 'agua',
  nombre: 'Agua de proceso',
  unidad_medida: 'LITROS'
}
const AZ: InsumoDelCatalogo = {
  id: '2f4b60ad-6d70-430f-854f-afe1efa8ab6f',
  sku: 'ing-az',
  nombre: 'Ingrediente Az',
  unidad_medida: 'KILOGRAMOS'
}
const MOSTO: InsumoDelCatalogo = {
  id: '8e1bc102-48eb-4d4f-b547-6e2afd6663e1',
  sku: 'mosto-1',
  nombre: 'Aditivo Mosto 1',
  unidad_medida: 'KILOGRAMOS'
}
const INSUMOS = [MOSTO, AGUA, CHILE, AZ, MOSTO].slice(0, 4)

const F750: FormatoDeBotella = {
  id: 'c1000000-0000-0000-0000-000000000001',
  sku: 'plata-750ml',
  nombre: 'Destilado Plata 750ml',
  ml_por_unidad: 750
}
const F250: FormatoDeBotella = {
  id: 'c1000000-0000-0000-0000-000000000003',
  sku: 'plata-250ml',
  nombre: 'Destilado Plata 250ml',
  ml_por_unidad: 250
}
const F50: FormatoDeBotella = {
  id: 'c1000000-0000-0000-0000-000000000004',
  sku: 'plata-50ml',
  nombre: 'Destilado Plata 50ml',
  ml_por_unidad: 50
}
const FORMATOS = [F750, F250, F50]

const AHORA = new Date(2026, 8, 18, 10, 30) // 2026-09-18, hora local

function contexto(parcial: Partial<ContextoLote> = {}): ContextoLote {
  return {
    etiqueta: 'norman',
    ahora: AHORA,
    codigosTomados: [],
    insumos: [{ insumo: CHILE, cantidad: 8 }],
    envasado: [],
    ...parcial
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. EMPATAR CONTRA LAS LISTAS CERRADAS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el insumo', () => {
  test('"chile" es el guajillo y nada mas', () => {
    const r = buscarInsumo('chile', INSUMOS)
    expect(r.ok && r.elegido.id).toBe(CHILE.id)
  })

  test('"agua" empata con Agua de proceso', () => {
    const r = buscarInsumo('agua', INSUMOS)
    expect(r.ok && r.elegido.id).toBe(AGUA.id)
  })

  test('por SKU tambien', () => {
    const r = buscarInsumo('ing-az', INSUMOS)
    expect(r.ok && r.elegido.id).toBe(AZ.id)
  })

  test('lo que no existe no se acerca al mas parecido', () => {
    const r = buscarInsumo('levadura', INSUMOS)
    expect(r.ok).toBe(false)
  })
})

test.describe('el formato de botella', () => {
  test('"750" es el formato de 750, dicho como se dice', () => {
    const r = buscarFormato('750', FORMATOS)
    expect(r.ok && r.elegido.id).toBe(F750.id)
  })

  test('"50ml" no se confunde con el de 250', () => {
    const r = buscarFormato('50ml', FORMATOS)
    expect(r.ok && r.elegido.id).toBe(F50.id)
  })

  test('el nombre completo tambien', () => {
    const r = buscarFormato('Destilado Plata 250ml', FORMATOS)
    expect(r.ok && r.elegido.id).toBe(F250.id)
  })

  test('sin decir formato NO se escoge el mas comun: se pregunta', () => {
    // "200 botellas" a secas. El formato decide cuantos mililitros salieron del
    // lote, o sea el rendimiento entero.
    const r = buscarFormato('', FORMATOS)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('sin-nombre')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. LA FECHA Y EL CODIGO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('fechas y codigo', () => {
  test('la fecha es la local, no la UTC', () => {
    // A las 22:00 hora de Mexico ya es el dia siguiente en UTC. Un lote que
    // arranco "hoy" tiene que quedar con la fecha que la persona tiene en la
    // cabeza, no con la del meridiano.
    expect(fechaLocal(new Date(2026, 8, 18, 22, 30))).toBe('2026-09-18')
    expect(fechaLocal(AHORA)).toBe('2026-09-18')
  })

  test('sumar dias cruza fin de mes', () => {
    expect(sumarDias('2026-09-28', 5)).toBe('2026-10-03')
    expect(sumarDias('2026-09-18', 0)).toBe('2026-09-18')
  })

  test('el codigo sugerido sale de la fecha', () => {
    expect(codigoSugerido('2026-09-18', [])).toBe('L-20260918')
  })

  test('dos lotes el mismo dia son dos, no un error', () => {
    expect(codigoSugerido('2026-09-18', ['L-20260918'])).toBe('L-20260918-B')
    expect(codigoSugerido('2026-09-18', ['L-20260918', 'L-20260918-B'])).toBe('L-20260918-C')
  })

  test('el codigo tomado se compara sin importar mayusculas', () => {
    expect(codigoSugerido('2026-09-18', ['l-20260918'])).toBe('L-20260918-B')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LA NORMALIZACION
// ═══════════════════════════════════════════════════════════════════════════

test.describe('normalizar el lote', () => {
  test('el caso de todos los dias: chile, agua, dos tandas y envasado', () => {
    const r = normalizarLote(
      {
        dias_fermentacion: 3,
        tandas: [
          { litros: 200, grado: 30 },
          { litros: 100, grado: 15 }
        ]
      },
      contexto({
        insumos: [
          { insumo: CHILE, cantidad: 8 },
          { insumo: AGUA, cantidad: 120 }
        ],
        envasado: [{ formato: F750, botellas: 150 }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.payload.codigo_lote).toBe('L-20260918')
    expect(r.codigoSugerido).toBe(true)
    expect(r.payload.fecha_inicio).toBe('2026-09-18')
    expect(r.payload.fecha_fin_fermentacion).toBe('2026-09-21')
    expect(r.payload.usuario_creador).toBe('telegram:norman')
    expect(r.payload.entradas).toEqual([
      { id_insumo: CHILE.id, cantidad: 8 },
      { id_insumo: AGUA.id, cantidad: 120 }
    ])
    // Las tandas se numeran POR ORDEN. El modelo no numera nada.
    expect(r.payload.tandas).toEqual([
      { numero_tanda: 1, litros: 200, grado_alcohol: 30 },
      { numero_tanda: 2, litros: 100, grado_alcohol: 15 }
    ])
    expect(r.payload.envasado).toEqual([{ id_producto: F750.id, botellas: 150 }])
  })

  test('D-200: los litros y el grado se guardan POR TANDA, sin premezclar', () => {
    // De "300 litros al 25%" no se puede recuperar que eran 200 al 30% y 100 al
    // 15%, y esa diferencia decide si el lote llega a 38 grados diluyendo.
    const r = normalizarLote(
      { tandas: [{ litros: 200, grado: 30 }, { litros: 100, grado: 15 }] },
      contexto()
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.tandas.length).toBe(2)
    expect(r.payload.tandas.map((t) => t.grado_alcohol)).toEqual([30, 15])
  })

  test('un codigo dictado manda sobre el sugerido', () => {
    const r = normalizarLote({ codigo_lote: 'LOTE-CHILE-7' }, contexto())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.codigo_lote).toBe('LOTE-CHILE-7')
    expect(r.codigoSugerido).toBe(false)
  })

  test('un codigo que ya existe se rechaza por nombre, antes de escribir', () => {
    const r = normalizarLote(
      { codigo_lote: 'L-20260901' },
      contexto({ codigosTomados: ['L-20260901'] })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ya existe')
  })

  test('decir dias NO rellena las horas, y al reves tampoco', () => {
    // 3 dias son 72 horas solo si nadie paro la fermentacion a media tarde. La
    // columna de horas existe justamente para ese dato.
    const conDias = normalizarLote({ dias_fermentacion: 3 }, contexto())
    expect(conDias.ok && conDias.payload.horas_fermentacion).toBeNull()

    const conHoras = normalizarLote({ horas_fermentacion: 70 }, contexto())
    expect(conHoras.ok && conHoras.payload.fecha_fin_fermentacion).toBeNull()
    expect(conHoras.ok && conHoras.payload.horas_fermentacion).toBe(70)
  })

  test('una tanda sin grado se acepta, pero se avisa por que', () => {
    const r = normalizarLote({ tandas: [{ litros: 200 }] }, contexto())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.tandas[0].grado_alcohol).toBeNull()
    expect(r.avisos.join(' ')).toContain('costo por mililitro')
  })

  test('un grado imposible se detiene', () => {
    const r = normalizarLote({ tandas: [{ litros: 10, grado: 140 }] }, contexto())
    expect(r.ok).toBe(false)
  })

  test('grado cero es agua, y es un dato valido', () => {
    const r = normalizarLote({ tandas: [{ litros: 10, grado: 0 }] }, contexto())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.tandas[0].grado_alcohol).toBe(0)
  })

  test('un punto decimal perdido se detiene en el tope por tanda', () => {
    const r = normalizarLote(
      { tandas: [{ litros: TOPE_LITROS_TANDA + 1, grado: 30 }] },
      contexto()
    )
    expect(r.ok).toBe(false)
  })

  test('el mismo insumo dos veces se SUMA, porque la base no lo dejaria repetir', () => {
    // `lote_entradas` tiene `unique (id_lote, id_insumo)`: si llegara dos veces
    // el INSERT entero se caeria y el lote quedaria a medias.
    const r = normalizarLote(
      {},
      contexto({
        insumos: [
          { insumo: CHILE, cantidad: 8 },
          { insumo: CHILE, cantidad: 2 }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.entradas).toEqual([{ id_insumo: CHILE.id, cantidad: 10 }])
    expect(r.avisos.join(' ')).toContain('Chile Guajillo')
  })

  test('un lote vacio no es un lote', () => {
    const r = normalizarLote({}, contexto({ insumos: [], envasado: [] }))
    expect(r.ok).toBe(false)
  })

  test('Fase 8 D81: un lote se abre solo con su cabecera, y dice que va vacio', () => {
    for (const cabecera of [{ dias_fermentacion: 8 }, { codigo_lote: 'L-0930' }, { horas_fermentacion: 36 }]) {
      const r = normalizarLote(cabecera, contexto({ insumos: [], envasado: [] }))
      expect(r.ok, JSON.stringify(cabecera)).toBe(true)
      if (!r.ok) continue
      expect(r.payload.entradas).toEqual([])
      expect(r.avisos.join(' ')).toContain('Lo abro sin insumos, tandas ni envasado')
    }
    // CONTROL: con hijos no se dice que va vacio.
    const conChile = normalizarLote({ dias_fermentacion: 8 }, contexto({ insumos: [{ insumo: CHILE, cantidad: 8 }] }))
    expect(conChile.ok && conChile.avisos.join(' ')).not.toContain('Lo abro sin insumos')
  })

  test('un lote que arranco y todavia no destila SI se registra', () => {
    // Es para lo que sirve `fecha_inicio`: el dia que se pone a fermentar.
    const r = normalizarLote({}, contexto({ insumos: [{ insumo: CHILE, cantidad: 8 }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.tandas).toEqual([])
  })

  test('una fecha de inicio en el futuro no se escribe', () => {
    const r = normalizarLote({ fecha_inicio: '2027-01-01' }, contexto())
    expect(r.ok).toBe(false)
  })

  test('una cantidad de insumo en cero o negativa no se escribe', () => {
    for (const cantidad of [0, -1]) {
      const r = normalizarLote({}, contexto({ insumos: [{ insumo: CHILE, cantidad }] }))
      expect(r.ok).toBe(false)
    }
  })

  test('botellas fraccionarias no existen', () => {
    const r = normalizarLote(
      {},
      contexto({ envasado: [{ formato: F750, botellas: 10.5 }] })
    )
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. EL SELLO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el sello del lote', () => {
  const base = () => {
    const r = normalizarLote(
      {
        dias_fermentacion: 3,
        tandas: [{ litros: 200, grado: 30 }, { litros: 100, grado: 15 }]
      },
      contexto({
        insumos: [{ insumo: CHILE, cantidad: 8 }, { insumo: AGUA, cantidad: 120 }],
        envasado: [{ formato: F750, botellas: 150 }]
      })
    )
    if (!r.ok) throw new Error(r.error)
    return r.payload
  }

  test('las llaves estan ordenadas y son todas las del payload', () => {
    expect([...LLAVES_LOTE]).toEqual([...LLAVES_LOTE].sort())
    expect([...LLAVES_LOTE].sort()).toEqual(Object.keys(base()).sort())
  })

  test('cambiar UN grado dentro de una tanda rompe el sello', () => {
    const p = base()
    const tocado = {
      ...p,
      tandas: p.tandas.map((t, i) => (i === 0 ? { ...t, grado_alcohol: 31 } : t))
    }
    expect(selloLoteCoincide(tocado, sellarLote(p))).toBe(false)
  })

  test('cambiar una cantidad de insumo rompe el sello', () => {
    const p = base()
    const tocado = { ...p, entradas: p.entradas.map((e) => ({ ...e, cantidad: e.cantidad + 1 })) }
    expect(selloLoteCoincide(tocado, sellarLote(p))).toBe(false)
  })

  test('cambiar el codigo rompe el sello', () => {
    const p = base()
    expect(selloLoteCoincide({ ...p, codigo_lote: 'OTRO' }, sellarLote(p))).toBe(false)
  })

  test('un sello vacio o nulo no empata', () => {
    const p = base()
    expect(selloLoteCoincide(p, '')).toBe(false)
    expect(selloLoteCoincide(p, null)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. LOS MENSAJES
// ═══════════════════════════════════════════════════════════════════════════

test.describe('los mensajes', () => {
  test('la confirmacion ensena lo capturado y NADA derivado', () => {
    const r = normalizarLote(
      {
        dias_fermentacion: 3,
        tandas: [{ litros: 200, grado: 30 }, { litros: 100, grado: 15 }]
      },
      contexto({
        insumos: [{ insumo: CHILE, cantidad: 8 }, { insumo: AGUA, cantidad: 120 }],
        envasado: [{ formato: F750, botellas: 150 }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = mensajeDeConfirmacionLote(r.payload, r.desglose, r.avisos, r.codigoSugerido)

    expect(m).toContain('LOTE L-20260918')
    expect(m).toContain('codigo que te propongo')
    expect(m).toContain('8 kilogramos de Chile Guajillo')
    expect(m).toContain('120 litros de Agua de proceso')
    expect(m).toContain('Tanda 1: 200 L a 30 grados')
    expect(m).toContain('Tanda 2: 100 L a 15 grados')
    expect(m).toContain('150 de Destilado Plata 750ml')
    expect(m).toContain('VA')
    // D-198: ni una cifra calculada en la confirmacion.
    expect(m).not.toContain('alcohol absoluto')
    expect(m).not.toContain('grado objetivo')
    expect(m).not.toContain('teorica')
  })

  test('un codigo dictado NO se marca como propuesta', () => {
    const r = normalizarLote({ codigo_lote: 'LOTE-7' }, contexto())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = mensajeDeConfirmacionLote(r.payload, r.desglose, r.avisos, r.codigoSugerido)
    expect(m).not.toContain('codigo que te propongo')
  })

  test('el rendimiento se dice con lo que mando la vista, tal cual', () => {
    const m = mensajeDeRendimiento({
      alcohol_absoluto_l: 75,
      litros_al_grado_objetivo: 197.3684,
      botellas_750_teoricas: 263.16,
      grado_ponderado: 25,
      alcanza_el_grado_diluyendo: false,
      costo_por_ml: null,
      tandas_sin_grado: 0,
      insumos_sin_costo: 0,
      faltan_costo: null
    })
    expect(m).toContain('75 L')
    expect(m).toContain('197.368')
    expect(m).toContain('263.16')
    // La unica cifra que cambia lo que hay que hacer manana, dicha en palabras.
    expect(m).toContain('25 grados')
    expect(m).toContain('volver a destilarlo')
  })

  test('si alcanza el grado, no se dice nada alarmante', () => {
    const m = mensajeDeRendimiento({
      alcohol_absoluto_l: 120,
      litros_al_grado_objetivo: 315.79,
      botellas_750_teoricas: 421.05,
      grado_ponderado: 40,
      alcanza_el_grado_diluyendo: true,
      costo_por_ml: 0.0123,
      tandas_sin_grado: 0,
      insumos_sin_costo: 0,
      faltan_costo: null
    })
    expect(m).not.toContain('volver a destilarlo')
    expect(m).toContain('0.0123')
  })

  test('sin grados medidos se dice por que no hay costo, en vez de callarse', () => {
    const m = mensajeDeRendimiento({
      alcohol_absoluto_l: 0,
      litros_al_grado_objetivo: 0,
      botellas_750_teoricas: 0,
      grado_ponderado: 0,
      alcanza_el_grado_diluyendo: false,
      costo_por_ml: null,
      tandas_sin_grado: 2,
      insumos_sin_costo: 0,
      faltan_costo: null
    })
    expect(m).toContain('faltan grados por medir')
  })

  test('sin costo de un insumo se dice CUAL, no se calla', () => {
    // Medido en vivo el 2026-09-18: el primer lote real salio sin costo por ml
    // porque `agua` tiene `costo_unitario` en cero. Un lote sin costo y sin
    // motivo no se puede distinguir de un sistema que no calcula costos.
    const m = mensajeDeRendimiento({
      alcohol_absoluto_l: 75,
      litros_al_grado_objetivo: 197.3684,
      botellas_750_teoricas: 263.16,
      grado_ponderado: 25,
      alcanza_el_grado_diluyendo: false,
      costo_por_ml: null,
      tandas_sin_grado: 0,
      insumos_sin_costo: 1,
      faltan_costo: 'agua'
    })
    expect(m).toContain('no tengo costo de agua')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. D-198, COMPROBADO Y NO SOLO PROMETIDO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el bot captura, el ERP calcula', () => {
  const sinComentarios = (texto: string) =>
    texto
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')

  test('lib/bot-lotes.ts no reimplementa la aritmetica del rendimiento', () => {
    // El numero 38 (el grado objetivo), una division entre el grado, o una
    // multiplicacion de litros por grado serian la vista copiada a TypeScript.
    // Si esta prueba se pone roja hay DOS versiones de D-200 y algun dia
    // discrepan.
    const codigo = sinComentarios(
      readFileSync(join(__dirname, '..', 'lib', 'bot-lotes.ts'), 'utf8')
    )
    expect(codigo).not.toContain('38')
    expect(codigo).not.toMatch(/litros\s*\*\s*grado/)
    expect(codigo).not.toContain('alcohol_absoluto =')
    // `litros_al_grado_objetivo` SI aparece, y esta bien: es el NOMBRE de la
    // columna que manda la vista. Leer una columna no es calcularla. Lo que no
    // puede aparecer es aritmetica sobre el grado — ni una division ni una
    // multiplicacion — que es de lo unico que sale el rendimiento.
    expect(codigo.replace(/litros_al_grado_objetivo/g, 'COLUMNA')).not.toContain('grado_objetivo')
    expect(codigo).not.toMatch(/grado[a-zA-Z_]*\s*[*/]/)
    expect(codigo).not.toMatch(/[*/]\s*grado/)
  })

  test('confirmar LEE la vista en vez de calcular', () => {
    const codigo = sinComentarios(
      readFileSync(
        join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'confirmar', 'route.ts'),
        'utf8'
      )
    )
    expect(codigo).toContain("from('v_lote_rendimiento')")
    expect(codigo).toContain('alcohol_absoluto_l')
    // Y no la recalcula.
    expect(codigo).not.toMatch(/litros\s*\*\s*grado/)
  })

  test('proponer no escribe NADA mas que el borrador', () => {
    const codigo = sinComentarios(
      readFileSync(
        join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'proponer', 'route.ts'),
        'utf8'
      )
    )
    expect(codigo).toContain("from('bot_borradores')")
    for (const tabla of ['lote_entradas', 'lote_salidas', 'lote_envasado']) {
      expect(codigo).not.toContain(`from('${tabla}')`)
    }
  })

  test('confirmar recibe SOLO tres campos: ninguna fila viaja en el "va"', () => {
    const codigo = sinComentarios(
      readFileSync(
        join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'confirmar', 'route.ts'),
        'utf8'
      )
    )
    for (const campo of ['telegram_id', 'borrador_id', 'sello']) {
      expect(codigo).toContain(`cuerpo.${campo}`)
    }
    for (const prohibido of ['cuerpo.tandas', 'cuerpo.insumos', 'cuerpo.lote']) {
      expect(codigo).not.toContain(prohibido)
    }
  })

  test('deshacer un lote a medias es UN solo DELETE, no una cascada a mano', () => {
    // La compensacion que ERP-11 quito de la venta era una secuencia de DELETEs
    // que podia fallar a la mitad. Aqui el `on delete cascade` la hace Postgres.
    const codigo = sinComentarios(
      readFileSync(
        join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'confirmar', 'route.ts'),
        'utf8'
      )
    )
    const borrados = codigo.match(/\.delete\(\)/g) || []
    expect(borrados.length).toBe(1)
    expect(codigo).toContain("from('lotes').delete()")
  })
})
