/**
 * REGALOS: A QUIEN SE LE DIO (destino), seccion «Regalos» de la ficha y filtro de
 * lo que no es un local. Escrito el 2026-11-25 por el ejecutor de regalos v2 del
 * Socio. Los nombres son de prueba. El doble de PostgREST es el de `regalos.spec.ts`.
 *
 * Reglas (Norman, 2026-11-25): «dentro de cada una de las metricas de los
 * distribuidores y locales debe venir uno que se llame Regalos y que ahi se defina
 * cuantos regalos les hemos dado y de cuantas y de cuales». Todo regalo sale de la
 * matriz; lo consignado y la deuda del local no cambian; el ERP avisa, nunca bloquea.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import * as R from '@/lib/regalos'
import type { LineaCartera, ProductoRegalo } from '@/lib/regalos'
import * as Q from '@/lib/regalos-quien'
import { preguntaDeRegalo, sellarRegalo, type PayloadRegalo } from '@/lib/bot-regalo'
import * as S from '@/lib/regalos-servidor'
import * as regaloP from '@/app/api/bot/regalo/proponer/route'
import * as regaloC from '@/app/api/bot/regalo/confirmar/route'

const PRODUCTOS: ProductoRegalo[] = [
  { id: 'p-750', nombre: 'Destilado Plata 750ml', ml_por_unidad: 750, costo_unitario: 120 },
  { id: 'p-250', nombre: 'Destilado Plata 250ml', ml_por_unidad: 250, costo_unitario: 0 },
  { id: 'p-50', nombre: 'Destilado Plata 50ml', ml_por_unidad: 50, costo_unitario: 0 }
]
const RED = [
  { id: 'ent-casa', nombre: 'Casa Verde', rol: 'LOC' },
  { id: 'ent-son', nombre: 'Al son del Mezcal', rol: 'LOC' },
  { id: 'ent-aero', nombre: 'Aeropuerto', rol: 'LOC' },
  { id: 'ent-gf', nombre: 'Gilberto Franco', rol: 'DST' },
  { id: 'ent-cristian', nombre: 'Cristian Vela', rol: 'DST' },
  { id: 'ent-desc', nombre: 'Descuento del 30%', rol: 'LOC' },
  { id: 'ent-may', nombre: 'Venta mayoreo', rol: 'LOC' }
]
const leer = (t: string, dicta = 'norman') => R.leerRegalo(t, PRODUCTOS, dicta, Q.listaDeQuienes(RED))
const ver = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

// ─── 1. El lector ───────────────────────────────────────────────────────────

test.describe('destino: un nombre suelto nunca se le carga a quien dicta', () => {
  for (const t of [
    'regalo una grande fany', 'Regalo una grande fany en la feria', 'regale una grande la fany', 'regalo 2 grandes plata fany',
    'regalo una grande (fany) en la feria', 'regalo una grande por fany', 'REGALO UNA GRANDE FANY', 'regalo una grande mi compadre'
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: false, falta: 'quien' })
    })
  }
})

test.describe('destino: a quien se le dio', () => {
  for (const [t, quien, id] of [
    ['Norman regaló 3 grandes a Casa Verde', 'Norman', 'ent-casa'],
    ['Norman regaló 3 grandes a CASA VERDÉ', 'Norman', 'ent-casa'],
    ['A Casa Verde le regalé 3 grandes', 'Norman', 'ent-casa'],
    ['Norman le regaló a Casa Verde 3 grandes', 'Norman', 'ent-casa'],
    ['Regalo una grande de Casa Verde', 'Norman', 'ent-casa'],
    ['Regalo una grande para Casa Verde', 'Norman', 'ent-casa'],
    ['regalo una grande casa verde', 'Norman', 'ent-casa'],
    ['regalo 2 minis al son', 'Norman', 'ent-son'],
    ['Cris regaló 2 minis a Gilberto Franco', 'Cristian', 'ent-gf'],
    ['Regalo una grande de Cris para Casa Verde', 'Cristian', 'ent-casa'],
    ['Casa Verde regaló una grande a Gilberto Franco', 'Casa Verde', 'ent-gf'],
    ['Regalo una grande de Casa Verde a Gilberto Franco', 'Casa Verde', 'ent-gf'],
    ['Norman regaló 3 grandes a Casa Verde, motivo: apertura', 'Norman', 'ent-casa']
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: true, quien, destino: { ids: [id] } })
    })
  }

  for (const t of ['Regalo una grande en la feria', 'Casa Verde regaló 2 grandes en la feria', 'Regalo una grande de parte de Casa Verde en la feria',
    'regalo una grande a fany', 'Regalo una grande a un cliente de Casa Verde', 'Regalo una grande de Cris en la feria', 'Norman regaló una grande a Kevin']) {
    test('sin destino: ' + t, () => {
      const r = leer(t)
      expect(r).toMatchObject({ ok: true })
      expect((r as { destino?: unknown }).destino).toBeUndefined()
    })
  }

  test('"Cris" es Cristian del equipo, "Cristian Vela" el distribuidor, "Cristian" a secas se pregunta', () => {
    expect(leer('Norman regaló una grande a Cristian Vela')).toMatchObject({ ok: true, quien: 'Norman', destino: { ids: ['ent-cristian'] } })
    expect(leer('Cris regaló una grande en la feria')).toMatchObject({ ok: true, quien: 'Cristian' })
    expect(leer('Cristian regaló una grande en la feria')).toMatchObject({ ok: false, falta: 'quien', duda: { motivo: 'ambiguo' } })
  })

  test('destino parecido o ambiguo: se pregunta, no se escoge', () => {
    for (const t of ['Norman regaló 3 grandes a casa berde', 'Norman regaló 3 grandes a Gilberto', 'Norman regaló 3 grandes a Cristian'])
      expect(leer(t), t).toMatchObject({ ok: false, falta: 'quien', duda: { sobre: 'destino' } })
  })

  test('dos destinos: un regalo por mensaje', () => {
    for (const t of ['Norman regaló 2 grandes a Casa Verde y una chica al Aeropuerto', 'Norman regaló 2 grandes a Casa Verde y Aeropuerto'])
      expect(leer(t), t).toMatchObject({ ok: false, falta: 'uno_por_mensaje' })
  })

  test('la respuesta a "¿a quien se le dio?"', () => {
    const con = (t: string, d: string) => {
      const previa = leer(t)
      return leer(R.contestarDuda(t, !previa.ok && previa.falta === 'quien' ? previa.duda : undefined, d, Q.listaDeQuienes(RED)))
    }
    expect(con('Norman regaló 3 grandes a casa berde en la feria', 'Casa Verde')).toMatchObject({ ok: true, quien: 'Norman', destino: { ids: ['ent-casa'] } })
    expect(con('Norman regaló 3 grandes a Gilberto', 'Gilberto Franco')).toMatchObject({ ok: true, quien: 'Norman', destino: { ids: ['ent-gf'] } })
    const ninguno = con('Norman regaló 3 grandes a casa berde en la feria', 'ninguno')
    expect(ninguno).toMatchObject({ ok: true, quien: 'Norman' })
    expect((ninguno as { destino?: unknown }).destino).toBeUndefined()
    // A "¿quien fue?" con un local: el tramo era un nombre suelto, es a quien se le dio.
    expect(con('regalo una grande fany en la feria', 'Kevin')).toMatchObject({ ok: true, quien: 'Kevin' })
  })
})

test.describe('sin tamano: "Norman regalo 3 a Casa Verde"', () => {
  const faltan = (t: string) => {
    const l = leer(t)
    return !l.ok && l.falta === 'piezas' ? l.cuantas : undefined
  }
  for (const [t, n] of [
    ['Norman regaló 3 a Casa Verde', 3], ['Norman regaló tres a Casa Verde', 3], ['regalé 3 a Casa Verde en la feria', 3], ['Le regalé 2 a Gilberto Franco', 2],
    ['Regalo 3 de Casa Verde', 3], ['regalo 3 para Casa Verde, motivo: apertura', 3], ['Kevin regaló 3', 3], ['Kevin regaló 3 en la feria', 3],
    ['A Casa Verde le regaló Norman 3', 3], ['Norman regaló ayer 3 a Casa Verde', 3], ['Norman regaló 3 a casa berde', 3], ['regalo 3 a casa berde', 3], ['Norman regaló 3 Casa Verde', 3], ['Norman regaló una a Casa Verde', 1],
    ['Norman regaló 3 destilados a Casa Verde', 3], ['Norman regaló 3 de Gilberto Franco', 3], ['Regalo 24 a Casa Verde', 24], ['Norman regaló 99 a Casa Verde', 99]
  ] as const) {
    test(`pregunta el tamano: ${t}`, () => {
      expect(faltan(t)).toBe(n)
    })
  }

  for (const t of [
    'pagué 300 a Casa Verde', 'gasté 3 en Casa Verde', 'gasté 3 en la feria', 'compré un regalo de 300', 'compré un regalo de 300 para Kevin', 'compré 3 regalos para Casa Verde',
    'compré y regalé 3 a Casa Verde', 'gasté en el regalo 3 a Kevin', 'regalo para la esposa de Gilberto 500', 'regalo 300 a Kevin', 'regalo 25 a Kevin', 'Norman regaló 300 a Casa Verde',
    'Norman regaló 100 a Casa Verde', 'Norman regaló 50 pesos a Kevin', 'Norman regaló $50 a Kevin', 'Norman regaló $ 3 a Casa Verde', 'Norman regaló 3.50 a Casa Verde', 'Norman regaló 3 mil a Casa Verde',
    'me regalaron un día libre', 'Kevin dice que llevo 30 y vendio 20 y regalo 2', 'vendí 3 a Casa Verde y regalé 1', 'Regalo del 3 de diciembre para Kevin', 'Norman regaló a las 3 a Casa Verde',
    'le regalé 2 playeras a Kevin', 'Norman regaló 3 de sus camisas a Kevin', 'Regalo 3 en la feria', 'Norman regaló uno de sus libros a Kevin', 'le regalé algo a Delirio 85'
  ]) {
    test(`no cae aqui: ${t}`, () => {
      const l = leer(t)
      expect(l.ok).toBe(false)
      expect(faltan(t)).toBeUndefined()
      expect(!l.ok && (l.falta === 'piezas' || l.falta === 'no_es_regalo'), JSON.stringify(l)).toBe(true)
      expect(R.nombraBotella(t)).toBe(false)
    })
  }

  test('dos destinos o dos que regalan: un regalo por mensaje, no se pregunta un solo tamano', () => {
    for (const t of ['Norman regaló 3 a Casa Verde y 2 a Aeropuerto', 'Norman regaló 2 a Casa Verde y Kevin 1', 'Norman y Kevin regalaron 3 a Casa Verde', 'Norman regaló 3 a Casa Verde y 2 más en la feria'])
      expect(leer(t), t).toMatchObject({ ok: false, falta: 'uno_por_mensaje' })
  })

  test('el numero de un nombre no es una cantidad', () => {
    const q = Q.listaDeQuienes([{ id: 'ent-del', nombre: 'Delirio 85', rol: 'LOC' }])
    expect(R.leerRegalo('Norman regaló 3 a Delirio 85', PRODUCTOS, 'norman', q)).toEqual({ ok: false, falta: 'piezas', cuantas: 3 })
    expect(R.numerosSueltos('Norman regaló a Delirio 85', q)).toEqual([])
  })

  test('la pregunta dice el numero y pide solo el tamano', () => {
    const l = leer('Norman regaló 3 a Casa Verde')
    expect(l.ok ? '' : preguntaDeRegalo(l, PRODUCTOS)).toBe('¿Grande, chica o mini? Son 3; contesta solo el tamaño, por ejemplo "grandes".')
  })

  const tras = (t: string, d: string) => leer(R.completarRegalo(t, 'piezas', d, Q.listaDeQuienes(RED)))
  for (const [d, ml] of [
    ['grandes', 750], ['grande', 750], ['la grande', 750], ['de las grandes', 750], ['grandes por favor', 750], ['Grandes.', 750], ['750', 750], ['750 ml', 750], ['de 750', 750],
    ['chicas', 250], ['chicas, las de 250 no', 0], ['250', 250], ['mini', 50], ['minis', 50], ['las minis', 50], ['3 grandes', 750], ['tres grandes', 750], ['3 de las grandes', 750], ['3 botellas grandes', 750]
  ] as const) {
    test(`respuesta "${d}": conserva el 3, quien y destino`, () => {
      const l = tras('Norman regaló 3 a Casa Verde, motivo: apertura', d)
      if (ml === 0) expect(l).toEqual({ ok: false, falta: 'piezas', cuantas: 3 })
      else {
        expect(l).toMatchObject({ ok: true, quien: 'Norman', destino: { nombre: 'Casa Verde' }, piezas: [{ cantidad: 3, producto: { ml_por_unidad: ml } }] })
        expect((l as { piezas: unknown[] }).piezas).toHaveLength(1)
      }
    })
  }

  test('si la respuesta trae su cuenta, manda; si no dice el tamano, nada cambia', () => {
    expect(tras('Norman regaló 3 a Casa Verde', '2 grandes y 1 chica')).toMatchObject({ ok: true, piezas: [{ cantidad: 2 }, { cantidad: 1 }], destino: { nombre: 'Casa Verde' } })
    for (const d of ['no se', 'grandes y chicas', 'sí', ''])
      expect(R.completarRegalo('Norman regaló 3 a Casa Verde', 'piezas', d, Q.listaDeQuienes(RED)), d).toBe('Norman regaló 3 a Casa Verde')
    // "3 botellas" y contestan solo el tamano: antes "750 ml" se comia el 3.
    expect(R.completarRegalo('Norman regaló 3 botellas a Casa Verde', 'piezas', '750 ml')).toBe('Norman regaló 3 750 ml a Casa Verde')
    expect(R.completarRegalo('Norman regaló 3 botellas a Casa Verde', 'piezas', 'grandes')).toBe('Norman regaló 3 grandes a Casa Verde')
    expect(R.completarRegalo('Norman regaló botellas a Casa Verde', 'piezas', 'grandes')).toBe('Norman regaló botellas a Casa Verde')
    expect(R.completarRegalo('Norman regaló 3 botellas a Casa Verde', 'piezas', '2 grandes y 1 chica')).toBe('Norman regaló 2 grandes y 1 chica a Casa Verde')
  })
})

test.describe('"de <distribuidor>": se pregunta que hizo', () => {
  const LISTA = Q.listaDeQuienes(RED)
  const duda = (t: string) => {
    const l = leer(t)
    return !l.ok && l.falta === 'quien' ? l.duda : undefined
  }
  for (const t of [
    'Regalo una grande de Gilberto Franco en la feria', 'Regalo una grande de Franco en la feria', 'Regalo de Gilberto Franco: 2 grandes en la feria', 'Regalo una grande del distribuidor Gilberto Franco en la feria',
    'Regalo una grande Gilberto Franco en la feria', 'Norman regaló una grande de Gilberto Franco en la feria'
  ]) {
    test(`pregunta: ${t}`, () => {
      const l = leer(t)
      expect(duda(t)).toMatchObject({ motivo: 'rol', opciones: [{ nombre: 'Gilberto Franco' }] })
      expect(l).not.toHaveProperty('destino')
      expect(l.ok ? '' : preguntaDeRegalo(l, PRODUCTOS)).toBe('¿Lo regaló Gilberto Franco o era para él? Contesta "lo dio él" o "para él".')
    })
  }

  for (const [t, quien, destino] of [
    ['Regalo una grande para Gilberto Franco en la feria', 'Norman', 'Gilberto Franco'], ['Regalo una grande a Franco en la feria', 'Norman', 'Gilberto Franco'],
    ['Norman regaló una grande a Gilberto Franco', 'Norman', 'Gilberto Franco'], ['Gilberto Franco regaló una grande en la feria', 'Gilberto Franco', ''], ['Franco regaló una grande a Casa Verde', 'Gilberto Franco', 'Casa Verde'],
    ['Regalo una grande de parte de Gilberto Franco en la feria', 'Gilberto Franco', ''], ['Regalo una grande de Gilberto Franco a Casa Verde en la feria', 'Gilberto Franco', 'Casa Verde'],
    ['Regalo una grande de Casa Verde en la feria', 'Norman', 'Casa Verde'], ['Norman regaló una grande de Casa Verde en la feria', 'Norman', 'Casa Verde']
  ] as const) {
    test(`no pregunta: ${t}`, () => {
      const l = leer(t)
      expect(l).toMatchObject({ ok: true, quien, ...(destino ? { destino: { nombre: destino } } : {}) })
      if (!destino) expect(l).not.toHaveProperty('destino')
    })
  }

  const T = 'Regalo una grande de Gilberto Franco en la feria'
  const con = (t: string, d: string) => leer(R.contestarDuda(t, duda(t), d, LISTA))
  for (const d of ['lo dio él', 'él', 'fue él', 'el lo dio', 'lo regaló él', 'Gilberto Franco', 'Franco', 'de parte de él', 'lo dio Gilberto', 'Gilberto Franco (distribuidor)']) {
    test(`"${d}": lo dio`, () => {
      const l = con(T, d)
      expect(l).toMatchObject({ ok: true, quien: 'Gilberto Franco', motivo: 'la feria' })
      expect(l).not.toHaveProperty('destino')
    })
  }
  for (const d of ['para él', 'era para él', 'para Gilberto Franco', 'a él', 'no, para él', 'él lo recibió', 'se la dimos a él', 'Para Franco']) {
    test(`"${d}": lo recibio`, () => {
      expect(con(T, d)).toMatchObject({ ok: true, quien: 'Norman', destino: { nombre: 'Gilberto Franco' } })
    })
  }
  test('otro nombre: ese lo dio y era para el; "ninguno": ni lo uno ni lo otro; lo que no se entiende, se vuelve a preguntar', () => {
    expect(con(T, 'yo')).toMatchObject({ ok: true, quien: 'Norman', destino: { nombre: 'Gilberto Franco' } })
    expect(con(T, 'Kevin')).toMatchObject({ ok: true, quien: 'Kevin', destino: { nombre: 'Gilberto Franco' } })
    expect(con(T, 'ninguno')).toMatchObject({ ok: true, quien: 'Norman' })
    expect(con(T, 'ninguno')).not.toHaveProperty('destino')
    for (const d of ['sí', 'quien sabe']) expect(con(T, d), d).toMatchObject({ ok: false, falta: 'quien', duda: { motivo: 'rol' } })
  })
  test('con quien regala ya dicho, la respuesta lo respeta', () => {
    const t = 'Kevin regaló 2 grandes de Gilberto Franco, motivo: feria'
    expect(con(t, 'para él')).toMatchObject({ ok: true, quien: 'Kevin', destino: { nombre: 'Gilberto Franco' }, piezas: [{ cantidad: 2 }] })
    expect(con(t, 'lo dio él')).toMatchObject({ ok: true, quien: 'Gilberto Franco', piezas: [{ cantidad: 2 }] })
  })
  test('"de Gilberto" (dos posibles): una pregunta, no dos', () => {
    const t = 'Regalo una grande de Gilberto en la feria'
    expect(duda(t)).toMatchObject({ motivo: 'ambiguo' })
    expect(con(t, 'Gilberto Franco')).toMatchObject({ ok: true, quien: 'Gilberto Franco' })
    expect(con(t, 'Gilberto Franco')).not.toHaveProperty('destino')
    expect(con(t, 'para Gilberto Franco')).toMatchObject({ ok: true, quien: 'Norman', destino: { nombre: 'Gilberto Franco' } })
    expect(con(t, 'Gilberto (equipo)')).toMatchObject({ ok: true, quien: 'Gilberto' })
  })
})

test.describe('"una grande y <nombre>": se pregunta', () => {
  test('fany no es el motivo', () => {
    for (const t of ['regalo 1 grande y fany', 'regalo 1 grande, y fany', 'regalo 1 grande e Isabel', 'regalé 1 grande y 1 chica y fany en la feria', 'regalo 1 grande y fany, motivo: feria'])
      expect(leer(t), t).toMatchObject({ ok: false, falta: 'quien', duda: { motivo: 'desconocido' } })
    expect(leer('regalo 1 grande y fany')).toMatchObject({ duda: { dicho: 'fany' } })
    expect(leer('regalo 1 grande y Kevin, motivo: feria')).toMatchObject({ ok: false, falta: 'quien', duda: { motivo: 'cual' } })
    for (const t of ['regalo 1 grande y Casa Verde', 'regalo 1 grande y Gilberto Franco, motivo: feria', 'Norman regaló 1 grande y Casa Verde, motivo: feria'])
      expect(leer(t), t).toMatchObject({ ok: false, falta: 'quien', duda: { motivo: 'rol' } })
    const d = leer('regalo 1 grande y Casa Verde, motivo: feria')
    expect(R.contestarDuda('regalo 1 grande y Casa Verde, motivo: feria', !d.ok && d.falta === 'quien' ? d.duda : undefined, 'para él', Q.listaDeQuienes(RED))).toBe('regalo 1 grande para Casa Verde, motivo: feria')
    const si = leer(R.contestarDuda('regalo 1 grande y Casa Verde, motivo: feria', !d.ok && d.falta === 'quien' ? d.duda : undefined, 'para él', Q.listaDeQuienes(RED)))
    expect(si).toMatchObject({ ok: true, quien: 'Norman', destino: { nombre: 'Casa Verde' } })
  })
  test('lo que sigue igual', () => {
    expect(leer('regalo 1 grande y 2 chicas a Casa Verde, motivo: feria')).toMatchObject({ ok: true, piezas: [{ cantidad: 1 }, { cantidad: 2 }] })
    for (const t of ['regalo 1 grande y en la feria', 'regalo una grande y una playera en la feria', 'regalo 1 grande y se la di a Casa Verde, motivo: feria']) expect(leer(t), t).toMatchObject({ ok: true, quien: 'Norman' })
  })
})

// ─── 2. Lo que no es un local ───────────────────────────────────────────────

test.describe('destino: entidades que no son un local de verdad', () => {
  test('descuentos, mayoreo y centinelas fuera; los nombres normales dentro', () => {
    for (const n of ['Descuento', 'Descuento del 30%', 'descuento 10 por ciento', '20% off', 'Venta mayoreo', 'Mayoreo', 'Publico en general', 'VENTA DIRECTA', 'Pendiente de asignar', 'Prueba', 'Test local', '', null])
      expect(Q.esEntidadReal(n), String(n)).toBe(false)
    for (const n of ['Casa Verde', 'Al son del Mezcal', 'Delirio 85', 'Mi dulce catrina', 'Dulceria el Eden', 'La Promesa', 'Los Generales Cantina', 'Gilberto Franco', 'Aeropuerto', 'Nuevo Ideal', 'Pruebas y Sabores'])
      expect(Q.esEntidadReal(n), n).toBe(true)
  })

  test('los que se colaban quedan fuera', () => {
    for (const n of ['Mayoreo Zacatecas', 'MAYOREO 2026', 'Venta de mayoreo Fresnillo', 'Venta al menudeo centro', 'Ventas mayoreo', 'Precio especial', 'Precios especiales', 'Ajuste', 'Ajuste de inventario', 'Muestras', 'Muestra', 'Consumo interno', 'NO USAR', 'Casa Verde (NO USAR)', 'no usar - viejo'])
      expect(Q.esEntidadReal(n), n).toBe(false)
    for (const n of ['La Muestra', 'Los Ajustes Bar', 'Casa Mayoreo', 'Especial de la Casa', 'Don Precioso']) expect(Q.esEntidadReal(n), n).toBe(true)
  })

  // La lista REAL de produccion, medida por SELECT el 2026-11-25 (nombre y rol). Si una regla nueva saca a uno de estos, esta mal la regla.
  const REALES = {
    DST: ['Ale Ortega Expressate', 'David Flores', 'Gilberto Franco', 'Luis Rodriguez', 'Martin Reyes'],
    LOC: ['Aeropuerto', 'Al son del Mezcal', 'Birrierias Jaramillo', 'Casa Verde', 'Delirio 85', 'Dulceria el Eden', 'Dulceria ruiz', 'Mi dulce catrina', 'Nuevo Ideal', 'Rey Tiburon']
  }
  test('los 15 reales, todos dentro; PENDIENTE DE ASIGNAR, fuera', () => {
    const red = [...Object.entries(REALES).flatMap(([rol, ns]) => ns.map((nombre, i) => ({ id: `${rol}${i}`, nombre, rol }))), { id: 'pend', nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' }]
    const dentro = Q.listaDeDestinos(red).map((d) => d.nombre)
    expect([...dentro].sort()).toEqual([...REALES.DST, ...REALES.LOC].sort())
    expect(dentro).toHaveLength(15)
    expect(Q.esEntidadReal('PENDIENTE DE ASIGNAR')).toBe(false)
    const l = Q.listaDeQuienes(red)
    for (const n of [...REALES.DST, ...REALES.LOC]) expect(Q.buscarQuien(n, l), n).toMatchObject({ ok: true, quien: { nombre: n } })
  })

  test('no son opcion, ni de quien ni de destino', () => {
    expect(Q.listaDeQuienes(RED).map((q) => q.nombre)).not.toContain('Descuento del 30%')
    expect(Q.listaDeQuienes(RED).map((q) => q.nombre)).not.toContain('Venta mayoreo')
    expect(Q.listaDeDestinos(RED).map((d) => d.id)).toEqual(['ent-casa', 'ent-son', 'ent-aero', 'ent-gf', 'ent-cristian'])
  })

  test('homonimos: persona y local se distinguen; dos locales iguales guardan sus dos ids', () => {
    const l = Q.listaDeQuienes([{ id: 'a', nombre: 'Kevin', rol: 'LOC' }, { id: 'b', nombre: 'Oxxo', rol: 'LOC' }, { id: 'c', nombre: 'OXXO', rol: 'LOC' }])
    expect(l).toContainEqual({ nombre: 'Kevin', tipo: 'equipo' })
    expect(l.find((q) => q.tipo === 'local' && q.nombre.startsWith('Kevin'))).toMatchObject({ nombre: 'Kevin (local)', ids: ['a'] })
    expect(l.filter((q) => q.nombre.toLowerCase() === 'oxxo')).toMatchObject([{ ids: ['b', 'c'] }])
  })
})

// ─── 3. La cartera ──────────────────────────────────────────────────────────

const linea = (o: Partial<LineaCartera>): LineaCartera => ({
  id_regalo: 'r1', fecha: '2026-11-24', quien_regalo: 'Norman', motivo: 'apertura', usuario_creador: 'telegram:norman', id_producto: 'p-750',
  producto: 'Destilado Plata 750ml', ml_por_unidad: 750, piezas: 3, creado_en: '2026-11-25T03:05:40.12+00:00', id_entidad_destino: 'ent-casa', destino: 'Casa Verde', ...o
})
// El regalo que ya esta en la base: Norman, 1 de 750, 2026-11-23, sin destino.
const YA = linea({ id_regalo: 'r0', fecha: '2026-11-23', motivo: 'conferencia de IA', piezas: 1, id_entidad_destino: null, destino: null })

test.describe('destino: la cartera', () => {
  test('cuenta una vez en el destino y una vez en quien lo dio; el que ya estaba no sale en ningun local', () => {
    const c = R.armarCartera([YA, linea({}), linea({ id_producto: 'p-50', producto: 'Destilado Plata 50ml', ml_por_unidad: 50, piezas: 2 }), linea({ id_regalo: 'r2', piezas: 1, quien_regalo: 'Kevin' })])
    expect(c.porDestino).toMatchObject([{ id: 'ent-casa', clave: 'Casa Verde', piezas: 6, piezasPorProducto: { 'p-750': 4, 'p-50': 2 } }])
    expect(c.porPersona.map((g) => [g.clave, g.piezas])).toEqual([['Norman', 6], ['Kevin', 1]])
    expect(c.total.piezas).toBe(7)
    expect(c.registros.find((r) => r.id_regalo === 'r0')).toMatchObject({ quien_regalo: 'Norman', piezas: 1, destino: '', id_entidad_destino: null })
  })
  test('dos locales con el mismo nombre no se juntan', () => {
    const c = R.armarCartera([linea({ destino: 'Oxxo', id_entidad_destino: 'b' }), linea({ id_regalo: 'r2', destino: 'Oxxo', id_entidad_destino: 'c', piezas: 1 })])
    expect(c.porDestino.map((g) => [g.id, g.piezas])).toEqual([['b', 3], ['c', 1]])
  })
  test('desglose: 750, 250 y 50 siempre, aunque sean cero; suma el total', () => {
    expect(R.desglosePorTamano(R.armarCartera([]))).toEqual([{ etiqueta: '750 ml', piezas: 0 }, { etiqueta: '250 ml', piezas: 0 }, { etiqueta: '50 ml', piezas: 0 }])
    const c = R.armarCartera([linea({}), linea({ id_producto: 'p-x', producto: 'Estuche', ml_por_unidad: null, piezas: 2 })])
    expect(R.desglosePorTamano(c)).toEqual([{ etiqueta: '750 ml', piezas: 3 }, { etiqueta: '250 ml', piezas: 0 }, { etiqueta: '50 ml', piezas: 0 }, { etiqueta: 'Otras', piezas: 2 }])
  })
  test('el texto del bot: total, desglose e historial; cero tambien se dice', () => {
    const c = R.armarCartera([YA, linea({})])
    const t = R.textoRecibidos(c, { nombre: 'Casa Verde', ids: ['ent-casa'] })
    expect(t).toContain('Casa Verde: 3 botellas (3 de 750ml)')
    expect(t).toContain('- 2026-11-24: 3 de 750ml. apertura. Lo dio Norman [lo capturó Norman (Telegram), 2026-11-24 21:05]')
    expect(t).not.toContain('conferencia')
    expect(R.textoRecibidos(c, { nombre: 'Aeropuerto', ids: ['ent-aero'] })).toBe('REGALOS que le hemos dado a Aeropuerto: 0 botellas')
    expect(R.textoContador(c, '')).toContain('A QUIEN SE LE HAN DADO\nCasa Verde: 3 botellas')
  })
})

// ─── 4. El doble ────────────────────────────────────────────────────────────

const TOKEN = 'r'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222
const LOCAL = 333

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let contador = 0
/** Cada llamada a la RPC `registrar_regalo`, con su cuerpo tal cual. */
let rpcs: { p_regalo: Fila; p_inventario: Fila[] }[] = []
let rpcFalla: string | null = null

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'CEO Admin', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
      { id: 'ent-aero', nombre: 'Aeropuerto', rol: 'LOC', id_padre: null, id_nodo_padre: null }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false, creado_en: '2026-01-01' },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: true, creado_en: '2026-02-01' },
      { telegram_id: LOCAL, etiqueta: 'aero', id_entidad: 'ent-aero', id_cuenta_destino: 'c-aero', activo: true, requiere_aprobacion: false, creado_en: '2026-03-01' }
    ],
    cuentas_financieras: [
      { id: 'c-ef', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-aero', id_entidad: 'ent-aero', nombre: 'Efectivo (Aeropuerto)', tipo_fiscalidad: 'LIBRE' }
    ],
    catalogo_productos: PRODUCTOS.map((p) => ({ ...p, tipo: 'TERMINADO' })).concat([
      { id: 'i-chile', nombre: 'Chile seco', tipo: 'INSUMO', ml_por_unidad: null, costo_unitario: 10 }
    ]),
    inventario_ledger: [
      { id: 'inv-a', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 3, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-b', id_producto: 'p-750', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 4, cubeta: 'CONSIGNADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-c', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 99, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ANULADO' },
      { id: 'inv-d', id_producto: 'p-250', tipo_movimiento: 'PRODUCCION', cantidad: 20, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-e', id_producto: 'p-50', tipo_movimiento: 'PRODUCCION', cantidad: 20, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-f', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 50, cubeta: 'PAGADO', id_entidad_destino: 'ent-aero', id_entidad_origen: null, status: 'ACTIVO' }
    ],
    bot_borradores: [],
    avisos_captura: []
  }
  escrituras = []
  rpcs = []
  rpcFalla = null
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = decodeURIComponent(expr.slice(i + 1)).replace(/^"|"$/g, '')
  const actual = fila[col]
  if (op === 'eq') return String(actual) === val
  if (op === 'neq') return String(actual) !== val
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'gte') return String(actual) >= val
  if (op === 'lt') return actual !== null && actual !== undefined && String(actual) < val
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(actual))
  throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function filtrar(tabla: string, params: URLSearchParams): Fila[] {
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of params.entries()) {
    if (NO_FILTRAN.has(col)) continue
    if (col === 'or') {
      const partes = expr.replace(/^\(|\)$/g, '').split(',')
      filas = filas.filter((f) => partes.some((p) => cumple(f, p.slice(0, p.indexOf('.')), p.slice(p.indexOf('.') + 1))))
      continue
    }
    filas = filas.filter((f) => cumple(f, col, expr))
  }
  return filas
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
}

/** El doble de `registrar_regalo`: guarda el cuerpo y escribe las filas MERMA como lo haria la RPC. */
function rpcRegistrarRegalo(cuerpo: { p_regalo: Fila; p_inventario: Fila[] }): Response {
  rpcs.push(JSON.parse(JSON.stringify(cuerpo)))
  if (rpcFalla) return json({ code: '23514', message: rpcFalla, details: '', hint: '' }, 400)
  const id = `reg-${++contador}`
  for (const f of cuerpo.p_inventario) {
    tablas.inventario_ledger.push({
      id: `inv-${++contador}`, ...f, tipo_movimiento: 'MERMA', id_entidad_origen: cuerpo.p_regalo.id_entidad_origen,
      id_entidad_destino: null, status: 'ACTIVO', id_regalo: id
    })
  }
  return json(id)
}

function responder(url: string, init: RequestInit | undefined): Response {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const objeto = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const representacion = (headers.get('prefer') ?? '').includes('return=representation')
  let filas: Fila[] = []
  if (tabla.startsWith('rpc/')) {
    escrituras.push(`POST ${tabla}`)
    if (tabla === 'rpc/registrar_regalo') return rpcRegistrarRegalo(JSON.parse(String(init?.body)))
    return json(null)
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = filtrar(tabla, u.searchParams)
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      const defaults: Fila = tabla === 'bot_borradores' ? { estado: 'PENDIENTE', resuelto_en: null, id_registro: null, chat_id: null } : { status: 'ACTIVO' }
      const nuevas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((c: Fila) => ({ id: `${tabla}-${++contador}`, ...defaults, ...c }))
      ;(tablas[tabla] ??= []).push(...nuevas)
      filas = nuevas
    } else if (metodo === 'PATCH') {
      filas = filtrar(tabla, u.searchParams)
      for (const f of filas) Object.assign(f, cuerpo)
    }
    if (!representacion && !objeto) return new Response(null, { status: 204 })
  }
  if (objeto) {
    if (filas.length === 0 && (headers.get('accept') ?? '').includes('nulls=stripped')) return json(null)
    if (filas.length !== 1) return json({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }, 406)
    return json(filas[0])
  }
  return json(filas)
}

const fetchOriginal = globalThis.fetch
test.beforeAll(() => {
  for (const [k, v] of Object.entries(ENTORNO_FALSO)) {
    entornoOriginal[k] = process.env[k]
    process.env[k] = v
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    responder(String(input instanceof Request ? input.url : input), init)) as typeof fetch
})
test.afterAll(() => {
  globalThis.fetch = fetchOriginal
  for (const [k, v] of Object.entries(entornoOriginal)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function llamar(ruta: 'proponer' | 'confirmar', cuerpo: Record<string, unknown>) {
  const req = new Request('http://localhost/api/bot/regalo/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await (ruta === 'proponer' ? regaloP : regaloC).POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}

/** true: la base todavia no tiene la columna (el SQL no se ha corrido). */
let sinSql = false

function conRed(yaRegalos: LineaCartera[] = [YA]) {
  estadoInicial()
  sinSql = false
  tablas.entidades = tablas.entidades.filter((e) => e.id !== 'ent-aero')
  tablas.entidades.push(...RED.map((e) => ({ ...e, id_padre: null, id_nodo_padre: null })), { id: '11111111-1111-1111-1111-111111111111', nombre: 'Pendiente de asignar', rol: 'LOC', id_padre: null, id_nodo_padre: null })
  tablas.inventario_ledger.push({ id: 'inv-casa', id_producto: 'p-750', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 8, cubeta: 'CONSIGNADO', id_entidad_destino: 'ent-casa', id_entidad_origen: null, status: 'ACTIVO' })
  tablas.v_regalo_lineas = yaRegalos.map((l) => ({ ...l }) as unknown as Fila)
}

/** Lo que la vista ensenaria despues de la RPC (el doble no guarda encabezados). */
function aLaVista() {
  const r = rpcs[rpcs.length - 1]
  const porProducto = new Map<string, number>()
  for (const f of r.p_inventario) porProducto.set(String(f.id_producto), (porProducto.get(String(f.id_producto)) ?? 0) + Number(f.cantidad))
  for (const [id, piezas] of porProducto) {
    const p = PRODUCTOS.find((x) => x.id === id)!
    tablas.v_regalo_lineas.push({ id_regalo: `reg-n${rpcs.length}`, ...r.p_regalo, id_producto: id, producto: p.nombre, ml_por_unidad: p.ml_por_unidad, piezas, creado_en: '2026-11-25T18:00:00Z', id_entidad_destino: r.p_regalo.id_entidad_destino ?? null })
  }
}

test.beforeAll(() => {
  const dentro = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input)
    if (sinSql && /\/(?:regalos|v_regalo_lineas)\?/.test(u) && u.includes('id_entidad_destino')) {
      const t = u.includes('v_regalo_lineas') ? 'v_regalo_lineas' : 'regalos'
      return json({ code: '42703', message: `column ${t}.id_entidad_destino does not exist`, details: null, hint: null }, 400)
    }
    // Una vista sin la columna tampoco la devuelve.
    if (sinSql && u.includes('/v_regalo_lineas?')) return json(tablas.v_regalo_lineas.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'id_entidad_destino' && k !== 'destino'))))
    return dentro(input, init)
  }) as typeof fetch
})

const deCasa = () => JSON.stringify(tablas.inventario_ledger.filter((f) => f.id_entidad_origen === 'ent-casa' || f.id_entidad_destino === 'ent-casa'))
const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
const solicitud = { fecha: '2026-11-25', quien_regalo: 'Norman', motivo: 'Apertura', lineas: [{ id_producto: 'p-750', cantidad: 2 }] }
const hoy = () => S.hoyMx()

async function dictar(quien: number, texto: string) {
  const p = await llamar('proponer', { telegram_id: quien, texto })
  expect(p.j.ok, JSON.stringify(p.j)).toBe(true)
  return p.j
}

// ─── 5. El servidor ─────────────────────────────────────────────────────────

test.describe('destino: la escritura', () => {
  test('con destino: va en el encabezado, sale de la matriz, y nada de lo del local cambia', async () => {
    conRed()
    const antes = deCasa()
    expect(await S.registrarRegalo(cliente(), { ...solicitud, id_entidad_destino: 'ent-casa' }, 'ent-matriz', 'web@x')).toMatchObject({ ok: true, avisos: [] })
    expect(rpcs[0].p_regalo).toEqual({ fecha: '2026-11-25', quien_regalo: 'Norman', motivo: 'Apertura', id_entidad_origen: 'ent-matriz', usuario_creador: 'web@x', id_entidad_destino: 'ent-casa' })
    expect(tablas.inventario_ledger.filter((f) => f.id_regalo).every((f) => f.id_entidad_origen === 'ent-matriz' && f.id_entidad_destino === null)).toBe(true)
    expect(deCasa()).toBe(antes)
    expect(escrituras).toEqual(['POST rpc/registrar_regalo'])
  })

  test('sin destino: el cuerpo de la RPC es el de siempre, sin la llave nueva', async () => {
    for (const id_entidad_destino of [undefined, null, '']) {
      conRed()
      expect(await S.registrarRegalo(cliente(), { ...solicitud, id_entidad_destino }, 'ent-matriz', 'web@x')).toMatchObject({ ok: true })
      expect(Object.keys(rpcs[0].p_regalo)).toEqual(['fecha', 'quien_regalo', 'motivo', 'id_entidad_origen', 'usuario_creador'])
    }
  })

  test('un destino que no es distribuidor ni local real se rechaza y no escribe', async () => {
    for (const id of ['ent-matriz', 'ent-desc', 'ent-may', '11111111-1111-1111-1111-111111111111', 'no-existe']) {
      conRed()
      expect(await S.registrarRegalo(cliente(), { ...solicitud, id_entidad_destino: id }, 'ent-matriz', 'web@x'), id).toMatchObject({ ok: false })
      expect(rpcs).toEqual([])
    }
  })

  test('SQL sin correr: se guarda igual, el destino queda en el motivo y se AVISA', async () => {
    conRed()
    sinSql = true
    const r = await S.registrarRegalo(cliente(), { ...solicitud, id_entidad_destino: 'ent-casa' }, 'ent-matriz', 'web@x')
    expect(r).toMatchObject({ ok: true, avisos: [expect.stringContaining('falta correr el SQL')] })
    expect(rpcs[0].p_regalo).toEqual({ fecha: '2026-11-25', quien_regalo: 'Norman', motivo: 'Apertura (para Casa Verde)', id_entidad_origen: 'ent-matriz', usuario_creador: 'web@x' })
    const largo = 'x'.repeat(300)
    conRed()
    sinSql = true
    expect(await S.registrarRegalo(cliente(), { ...solicitud, motivo: largo, id_entidad_destino: 'ent-casa' }, 'ent-matriz', 'web@x')).toMatchObject({ ok: true })
    expect(String(rpcs[0].p_regalo.motivo)).toHaveLength(300)
    expect(String(rpcs[0].p_regalo.motivo)).toContain('(para Casa Verde)')
  })

  test('SQL sin correr: la cartera se lee como antes; la ficha dice que falta, no un cero', async () => {
    conRed()
    sinSql = true
    expect(await S.leerCartera(cliente())).toMatchObject({ hayDestinos: false, porDestino: [], total: { piezas: 1 }, registros: [{ quien_regalo: 'Norman' }] })
    expect(await S.leerRegalosDeNodo(cliente(), 'ent-casa')).toMatchObject({ hayDestinos: false })
    const q = await llamar('proponer', { telegram_id: NORMAN, texto: 'regalos de Casa Verde' })
    expect(String(q.j.texto)).toContain('falta correr el SQL')
  })

  test('otro error de lectura no se disfraza de "falta el SQL" ni de cero', async () => {
    conRed()
    const dentro = globalThis.fetch
    globalThis.fetch = (async (i: RequestInfo | URL, n?: RequestInit) =>
      String(i instanceof Request ? i.url : i).includes('v_regalo_lineas') ? json({ code: '42501', message: 'permission denied for view v_regalo_lineas', details: '', hint: '' }, 403) : dentro(i, n)) as typeof fetch
    try {
      await expect(S.leerRegalosDeNodo(cliente(), 'ent-casa')).rejects.toThrow('permission denied')
      await expect(S.leerCartera(cliente())).rejects.toThrow('permission denied')
    } finally {
      globalThis.fetch = dentro
    }
  })

  test('la ficha lee SOLO lo de ese local: ni lo de otro, ni lo que no tiene destino', async () => {
    conRed([YA, linea({}), linea({ id_regalo: 'r2', id_entidad_destino: 'ent-aero', piezas: 9 })])
    expect(await S.leerRegalosDeNodo(cliente(), 'ent-casa')).toMatchObject({ hayDestinos: true, total: { piezas: 3 }, registros: [{ id_regalo: 'r1' }] })
    expect((await S.leerRegalosDeNodo(cliente(), 'ent-son')).total.piezas).toBe(0)
  })
})

// ─── 6. El bot ──────────────────────────────────────────────────────────────

test.describe('destino: el bot', () => {
  test('las dos formas de dictarlo dan el mismo registro: una vez en Casa Verde, una vez en quien regala', async () => {
    for (const texto of ['Norman regaló 3 grandes a Casa Verde, motivo: apertura', 'Regalo 3 grandes de Casa Verde, motivo: apertura', 'Regalo 3 grandes para Casa Verde, motivo: apertura']) {
      conRed([])
      const p = await dictar(NORMAN, texto)
      expect(String(p.mensaje), texto).toContain('QUIEN:      Norman')
      expect(String(p.mensaje), texto).toContain('PARA:       Casa Verde (local)')
      expect(String(p.mensaje), texto).toContain('sale de la matriz, no de lo que tiene Casa Verde')
      const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.borrador_id, sello: p.sello })
      expect(c.j.ok, JSON.stringify(c.j)).toBe(true)
      expect(rpcs).toHaveLength(1)
      expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Norman', id_entidad_destino: 'ent-casa', id_entidad_origen: 'ent-matriz' })
      aLaVista()
      const cartera = await S.leerCartera(cliente())
      expect(cartera.porDestino.map((g) => [g.clave, g.piezas]), texto).toEqual([['Casa Verde', 3]])
      expect(cartera.porPersona.map((g) => [g.clave, g.piezas]), texto).toEqual([['Norman', 3]])
      expect(cartera.total.piezas).toBe(3)
    }
  })

  test('el mismo regalo dictado otra vez se AVISA antes del VA, y no se bloquea', async () => {
    conRed([])
    const a = await dictar(NORMAN, 'Norman regaló 3 grandes a Casa Verde, motivo: apertura')
    await llamar('confirmar', { telegram_id: NORMAN, borrador_id: a.borrador_id, sello: a.sello })
    aLaVista()
    const b = await dictar(NORMAN, 'Regalo 3 grandes de Casa Verde, motivo: apertura')
    expect(String(b.mensaje)).toContain('Ya hay un regalo igual para Casa Verde ese dia (de Norman')
    const otro = await dictar(NORMAN, 'Regalo 2 grandes de Casa Verde, motivo: apertura')
    expect(String(otro.mensaje)).not.toContain('Ya hay un regalo igual')
    const web = await S.registrarRegalo(cliente(), { ...solicitud, fecha: hoy(), lineas: [{ id_producto: 'p-750', cantidad: 3 }], id_entidad_destino: 'ent-casa' }, 'ent-matriz', 'web@x')
    expect(web).toMatchObject({ ok: true, avisos: expect.arrayContaining([expect.stringContaining('Ya habia un regalo igual')]) })
  })

  test('sin destino lo dice, y el borrador no lleva la llave', async () => {
    conRed()
    const p = await dictar(NORMAN, 'Regalo una grande en la feria')
    expect(String(p.mensaje)).toContain('PARA:       ningun distribuidor o local')
    const b = tablas.bot_borradores.find((x) => x.id === p.borrador_id) as Fila
    expect(Object.keys((b.payload as Fila).regalo as Fila)).not.toContain('id_entidad_destino')
  })

  test('un borrador de antes de esta version se confirma con su mismo sello', async () => {
    const viejo = { id_entidad: 'ent-matriz', fecha: '2026-11-25', quien_regalo: 'Kevin', motivo: 'expo', usuario_creador: 'telegram:norman', lineas: [{ id_producto: 'p-750', cantidad: 1 }] }
    conRed()
    const p = await dictar(NORMAN, 'Kevin regaló una grande, motivo: expo')
    const b = tablas.bot_borradores.find((x) => x.id === p.borrador_id) as Fila
    ;(b.payload as Fila).regalo = viejo
    b.sello = sellarRegalo(viejo as PayloadRegalo)
    expect((await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.borrador_id, sello: b.sello })).j.ok).toBe(true)
  })

  test('el sello cubre el destino: cambiarlo rompe el VA', async () => {
    conRed()
    const p = await dictar(NORMAN, 'Norman regaló 3 grandes a Casa Verde')
    const b = tablas.bot_borradores.find((x) => x.id === p.borrador_id) as Fila
    ;((b.payload as Fila).regalo as Fila).id_entidad_destino = 'ent-aero'
    expect((await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.borrador_id, sello: p.sello })).status).toBe(409)
    expect(rpcs).toEqual([])
  })

  test('sin tamano: pregunta una vez, y con la respuesta propone y guarda 3 a Casa Verde', async () => {
    for (const [dicho, producto] of [['grandes', 'p-750'], ['chicas', 'p-250'], ['mini', 'p-50'], ['750', 'p-750']]) {
      conRed([])
      const texto = 'Norman regaló 3 a Casa Verde, motivo: apertura'
      const a = await llamar('proponer', { telegram_id: NORMAN, texto })
      expect(a.j).toMatchObject({ ok: false, falta: 'piezas', texto })
      expect(a.j).not.toHaveProperty('no_es_regalo')
      expect(String(a.j.pregunta)).toContain('¿Grande, chica o mini? Son 3')
      const b = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'piezas', dicho } })
      expect(b.j.ok, JSON.stringify(b.j)).toBe(true)
      for (const x of ['QUIEN:      Norman', 'PARA:       Casa Verde (local)', 'PIEZAS:     3']) expect(String(b.j.mensaje), dicho).toContain(x)
      expect(String(b.j.mensaje)).not.toContain('Dictaste')
      const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: b.j.borrador_id, sello: b.j.sello })
      expect(c.j.ok, JSON.stringify(c.j)).toBe(true)
      expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Norman', id_entidad_destino: 'ent-casa' })
      expect(rpcs[0].p_inventario.filter((f: Fila) => f.id_producto === producto).reduce((s: number, f: Fila) => s + Number(f.cantidad), 0)).toBe(3)
    }
  })

  test('sin tamano: si la respuesta no lo dice, no se registra ni se vuelve a preguntar; si trae otra cuenta, se avisa', async () => {
    conRed([])
    const texto = 'Norman regaló 3 a Casa Verde, motivo: apertura'
    const a = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'piezas', dicho: 'de las minis y de las grandes' } })
    expect(a.j).toMatchObject({ ok: false, falta: 'tamano' })
    expect(String(a.j.pregunta)).toContain('no registré nada')
    expect(tablas.bot_borradores.filter((b) => b.estado === 'PENDIENTE')).toEqual([])
    const b = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'piezas', dicho: '1 grande' } })
    expect(String(b.j.mensaje)).toContain('Dictaste 3 y la respuesta suma 1')
    // La respuesta se junta con la misma lista con que se leyo el dictado.
    const e = await llamar('proponer', { telegram_id: NORMAN, texto: 'Norman regaló 3 Casa Verde, motivo: apertura', completa: { falta: 'piezas', dicho: 'grandes' } })
    expect(String(e.j.mensaje)).toContain('PARA:       Casa Verde (local)')
    // "regalo una botella" sin decir cual, se pregunta como siempre.
    const c = await llamar('proponer', { telegram_id: NORMAN, texto: 'Norman regaló botellas a Casa Verde', completa: { falta: 'piezas', dicho: 'grandes' } })
    expect(c.j).toMatchObject({ ok: false, falta: 'piezas' })
  })

  test('un gasto no se vuelve regalo: sigue su camino', async () => {
    conRed([])
    for (const texto of ['pagué 300 a Casa Verde', 'gasté 3 en la feria', 'compré un regalo de 300', 'compré un regalo de 300 para Casa Verde', 'regalo para la esposa de Gilberto 500', 'me regalaron un día libre', 'Norman regaló 300 a Casa Verde']) {
      const a = await llamar('proponer', { telegram_id: NORMAN, texto })
      expect(a.j, texto).toEqual({ ok: false, no_es_regalo: true })
    }
  })

  test('"de Gilberto Franco" por el bot: pregunta que hizo, y no escribe nada hasta la respuesta', async () => {
    conRed([])
    const texto = 'Regalo una grande de Gilberto Franco en la feria'
    const a = await llamar('proponer', { telegram_id: NORMAN, texto })
    expect(a.j).toMatchObject({ ok: false, falta: 'quien', pregunta: '¿Lo regaló Gilberto Franco o era para él? Contesta "lo dio él" o "para él".' })
    const dio = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'quien', dicho: 'lo dio él' } })
    expect(String(dio.j.mensaje)).toContain('QUIEN:      Gilberto Franco (distribuidor)')
    expect(String(dio.j.mensaje)).toContain('PARA:       ningun distribuidor o local')
    const para = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'quien', dicho: 'para él' } })
    expect(String(para.j.mensaje)).toContain('QUIEN:      Norman')
    expect(String(para.j.mensaje)).toContain('PARA:       Gilberto Franco (distribuidor)')
    expect(rpcs).toEqual([])
  })

  test('destino dudoso: pregunta con opciones; "ninguno" lo deja sin destino; la respuesta propone', async () => {
    conRed()
    const texto = 'Norman regaló 3 grandes a casa berde en la feria'
    const a = await llamar('proponer', { telegram_id: NORMAN, texto })
    expect(a.j).toMatchObject({ ok: false, falta: 'quien' })
    expect(String(a.j.pregunta)).toContain('Casa Verde (local)')
    expect(String(a.j.pregunta)).toContain('¿A quién se le dio?')
    const si = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'quien', dicho: 'casa verde' } })
    expect(String(si.j.mensaje)).toContain('PARA:       Casa Verde (local)')
    expect(String(si.j.mensaje)).toContain('QUIEN:      Norman')
    const no = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'quien', dicho: 'ninguno' } })
    expect(String(no.j.mensaje)).toContain('PARA:       ningun distribuidor o local')
  })

  test('"regalo una grande fany" por el bot: pregunta y no escribe nada', async () => {
    conRed()
    const a = await llamar('proponer', { telegram_id: NORMAN, texto: 'regalo una grande fany' })
    expect(a.j).toMatchObject({ ok: false, falta: 'quien' })
    expect(String(a.j.pregunta)).toContain('"fany"')
    expect(escrituras).toEqual([])
  })

  test('dos locales que se llaman igual: no adivina; sin destino y avisa', async () => {
    conRed()
    tablas.entidades.push({ id: 'ent-casa2', nombre: 'CASA VERDE', rol: 'LOC', id_padre: null, id_nodo_padre: null })
    const p = await dictar(NORMAN, 'Norman regaló 3 grandes a Casa Verde')
    expect(String(p.mensaje)).toContain('Hay 2 con el nombre')
    const b = tablas.bot_borradores.find((x) => x.id === p.borrador_id) as Fila
    expect(((b.payload as Fila).regalo as Fila).id_entidad_destino).toBeUndefined()
  })

  test('SQL sin correr: el bot propone, avisa y guarda', async () => {
    conRed()
    sinSql = true
    const p = await dictar(NORMAN, 'Norman regaló 3 grandes a Casa Verde, motivo: apertura')
    expect(String(p.mensaje)).toContain('Falta correr el SQL')
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.borrador_id, sello: p.sello })
    expect(c.j.ok, JSON.stringify(c.j)).toBe(true)
    expect(String(rpcs[0].p_regalo.motivo)).toContain('Casa Verde')
  })

  test('consulta: lo que se le ha dado, con el nombre entero o una parte; cero tambien', async () => {
    conRed([YA, linea({}), linea({ id_regalo: 'r2', id_entidad_destino: 'ent-son', destino: 'Al son del Mezcal', piezas: 2 })])
    const q = async (texto: string) => String((await llamar('proponer', { telegram_id: NORMAN, texto })).j.texto)
    expect(await q('regalos de Casa Verde')).toContain('REGALOS que le hemos dado a Casa Verde: 3 botellas (3 de 750ml)')
    expect(await q('cuantos regalos le hemos dado a casa verde?')).toContain('Casa Verde: 3 botellas')
    expect(await q('regalos de al son')).toContain('Al son del Mezcal: 2 botellas')
    expect(await q('regalos de Aeropuerto')).toContain('Aeropuerto: 0 botellas')
    const n = await q('regalos de Norman')
    expect(n).toContain('conferencia de IA')
    expect(n).toContain('(para Casa Verde)')
    expect(await q('regalos')).toContain('A QUIEN SE LE HAN DADO')
  })

  test('privacidad: un local no consulta los regalos, ni los suyos ni los de otro', async () => {
    conRed([linea({})])
    for (const texto of ['regalos de Casa Verde', 'regalos de Aeropuerto', 'regalos']) {
      const r = await llamar('proponer', { telegram_id: LOCAL, texto })
      expect(r.status, texto).toBe(403)
      expect(JSON.stringify(r.j)).not.toContain('botellas')
    }
  })
})

// ─── 7. Cableado y SQL ──────────────────────────────────────────────────────

test.describe('destino: la web y la migracion', () => {
  test('la ficha monta Regalos solo para la matriz, y la seccion ensena total, desglose e historial', () => {
    const ficha = ver('components', 'v2', 'nodo', 'FichaVista.tsx')
    expect(ficha).toContain('veLaMatriz(usuario.rol) && !propia && <RegalosNodo id={id} nombre={e.nombre} />')
    const r = ver('components', 'v2', 'regalos', 'RegalosNodo.tsx')
    for (const x of ['<h2>Regalos</h2>', 'desglosePorTamano(cartera)', 'cartera.total.piezas', 'horaCapturaMx(r.creado_en)', 'capturoTexto(r.usuario_creador)', '{r.motivo}', '0 regalos', 'esEntidadReal(nombre)', 'getServerSupabaseClient()'])
      expect(r, x).toContain(x)
    // Con la sesion de quien mira, nunca con la llave de servicio.
    expect(r).not.toMatch(/service_role|clienteDeServicio|getSupabaseAdmin|createClient/)
  })

  test('la pagina y el formulario traen el destino, por id; la accion lo pasa campo por campo', () => {
    expect(ver('components', 'v2', 'regalos', 'FormRegalo.tsx')).toContain('id_entidad_destino: destinoSel || null')
    expect(ver('components', 'v2', 'regalos', 'FormRegalo.tsx')).toContain('value={d.id}')
    expect(ver('app', 'panel', 'regalos', 'page.tsx')).toContain('destinos={destinos}')
    expect(ver('app', 'panel', 'regalos', 'page.tsx')).toContain('cartera.porDestino')
    expect(ver('app', 'actions', 'regalos.ts')).toContain('id_entidad_destino: solicitud?.id_entidad_destino')
  })

  test('borrar un distribuidor o local con regalos: un mensaje claro, no el error crudo', () => {
    const fk = { code: '23503', message: 'update or delete on table "entidades" violates foreign key constraint "regalos_id_entidad_destino_fkey" on table "regalos"', details: 'Key (id)=(x) is still referenced from table "regalos".' }
    expect(R.mensajeAlBorrarConRegalos(fk)).toContain('tiene regalos registrados')
    expect(R.mensajeAlBorrarConRegalos({ message: fk.message })).toContain('No se borró')
    expect(R.mensajeAlBorrarConRegalos({ code: '23503', message: 'violates foreign key constraint "ventas_id_fkey" on table "ventas"' })).toBeNull()
    expect(R.mensajeAlBorrarConRegalos({ code: '42501', message: 'permission denied for table "regalos"' })).toBeNull()
    expect(R.mensajeAlBorrarConRegalos(null)).toBeNull()
    const a = ver('app', 'actions', 'distribuidores.ts')
    const borra = a.slice(a.indexOf('export async function eliminarEntidadAction'))
    expect(borra).toContain('const conRegalos = mensajeAlBorrarConRegalos(deleteError)\n  if (conRegalos) return { error: conRegalos }\n  if (deleteError) throw new Error(deleteError.message)')
    for (const f of [['components', 'v2', 'red', 'EditarEntidad.tsx'], ['app', 'dashboard', 'distribuidores', 'EditEntidadModal.tsx']])
      expect(ver(...f), f.join('/')).toMatch(/const \{ error: noSeBorro \} = await eliminarEntidadAction\(row\.id\)\s+if \(noSeBorro\) \{\s+setError\(noSeBorro\)\s+return\s+\}/)
  })

  test('migracion: columna nullable con FK; nada de RLS ni de inventario; la vista sigue con la sesion de quien mira', () => {
    const sql = ver('supabase', 'migrations', '20261125120000_regalos_destino.sql').replace(/--.*$/gm, '')
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS id_entidad_destino uuid REFERENCES public\.entidades\(id\);/)
    expect(sql).not.toMatch(/SET NOT NULL|\bUPDATE\b|\bDELETE\b|POLICY|DISABLE|\bDROP\b/i)
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_regalo_lineas\s+WITH \(security_invoker = true\)/)
    expect(sql).toContain('SECURITY INVOKER')
    expect(sql).not.toContain('SECURITY DEFINER')
    // CREATE OR REPLACE VIEW solo deja agregar AL FINAL: las columnas de antes, en su orden, y luego la nueva.
    const vieja = ver('supabase', 'migrations', '20261120120000_regalos.sql').replace(/--.*$/gm, '')
    const columnas = (t: string) => [...t.slice(t.indexOf('SELECT r.id')).split('FROM public.regalos r')[0].matchAll(/(?:AS\s+)?(\w+)\s*(?:,|$)/gm)].map((m) => m[1])
    expect(columnas(sql)).toEqual([...columnas(vieja), 'id_entidad_destino'])
    // La funcion es la de antes mas el destino: quitando lo nuevo, es identica.
    const cuerpo = (t: string) => t.slice(t.indexOf('CREATE OR REPLACE FUNCTION'), t.indexOf('REVOKE ALL ON FUNCTION')).replace(/\s+/g, ' ').trim()
    const sinNuevo = cuerpo(sql).replace(', id_entidad_destino)', ')').replace(", NULLIF(btrim(COALESCE(p_regalo ->> 'id_entidad_destino', '')), '')::uuid )", ' )')
    expect(sinNuevo).toBe(cuerpo(vieja))
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.registrar_regalo(jsonb, jsonb) FROM PUBLIC, anon;')
  })
})
