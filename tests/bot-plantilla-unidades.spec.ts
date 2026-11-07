import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { convertirMasa, unidadCorta } from '../lib/bot-compra'

/**
 * Fase 7 (auditoria 2026-11-07). Norman: "no quiero la equivalencia, quiero que
 * sean 180 gramos". Dos guardas sobre la plantilla del lote (bot/plantillas/lote.yaml):
 *  1. ninguna pregunta de cantidad de insumo usa una unidad fija distinta a la
 *     del catalogo de ese insumo;
 *  2. contestar la pregunta con el numero de la receta NO escribe 1000 veces la
 *     receta (el error de "Cuantos kilos de aditivo 1?" -> 8 -> 8000 g).
 *
 * El catalogo y la receta son los de PRODUCCION, leidos con SELECT de solo
 * lectura el 2026-11-07 (catalogo_productos.unidad_medida y
 * receta_liquido_estandar.cantidad_por_lote). Si cambian alla, se actualizan aqui.
 */
const CATALOGO_REAL: Record<string, string> = {
  'mosto-1': 'GRAMOS',
  'aditivo-2': 'GRAMOS',
  'chile-guajillo': 'KILOGRAMOS',
  'chile-guajon': 'KILOGRAMOS'
}
const RECETA_REAL: Record<string, number> = { 'mosto-1': 8, 'chile-guajillo': 12 }

const YAML = readFileSync(join(__dirname, '..', 'bot', 'plantillas', 'lote.yaml'), 'utf8')

interface CampoYaml {
  nombre: string
  tipo?: string
  unidad?: string
  insumo?: string
  pregunta?: string
}

/** Lector minimo de la seccion `campos:` (sin dependencia de un parser YAML). */
function camposDelYaml(y: string): CampoYaml[] {
  const ini = y.search(/^campos:\s*$/m)
  expect(ini, 'el YAML trae la seccion campos:').toBeGreaterThanOrEqual(0)
  const resto = y.slice(ini).split(/\r?\n/).slice(1)
  const fin = resto.findIndex((l) => /^\S/.test(l) && l.trim() !== '' && !l.startsWith('#'))
  const bloque = (fin === -1 ? resto : resto.slice(0, fin)).join('\n')
  return bloque
    .split(/^\s{2}- nombre:/m)
    .slice(1)
    .map((b) => {
      const v = (k: string) => {
        const m = b.match(new RegExp('^\\s{4}' + k + ":\\s*'?([^'\\n]*)'?\\s*$", 'm'))
        return m ? m[1].trim() : undefined
      }
      return { nombre: b.split(/\r?\n/)[0].trim(), tipo: v('tipo'), unidad: v('unidad'), insumo: v('insumo'), pregunta: v('pregunta') }
    })
}

function skusDe(insumo: string): string[] {
  if (insumo === 'chiles') {
    const m = YAML.match(/conocidos:\s*\n((?:\s{4}\w+:\s*\S+\s*\n)+)/)
    expect(m, 'chiles.conocidos').not.toBeNull()
    return [...m![1].matchAll(/:\s*(\S+)/g)].map((x) => x[1])
  }
  const m = YAML.match(new RegExp('^' + insumo + ":\\s*'([^']+)'", 'm'))
  expect(m, insumo + ' en el YAML').not.toBeNull()
  return [m![1]]
}

const MASA = new Set(['g', 'kg'])
const PALABRA: Record<string, RegExp> = { g: /\bgramos?\b/i, kg: /\bkilos?\b/i }

test('ninguna pregunta de cantidad de insumo usa una unidad fija distinta a la del catalogo', () => {
  const campos = camposDelYaml(YAML)
  const deMasa = campos.filter((c) => c.tipo === 'numero' && MASA.has(String(c.unidad)))
  expect(deMasa.map((c) => c.nombre).sort()).toEqual(['aditivo_1', 'kg_chile'])
  for (const c of deMasa) {
    // Toda cantidad en g/kg dice de que insumo es; si no, no se puede revisar.
    expect(c.insumo, `${c.nombre}: falta 'insumo' en el YAML`).toBeTruthy()
    for (const sku of skusDe(c.insumo!)) {
      expect(CATALOGO_REAL[sku], `${sku} no esta en el catalogo real de la prueba`).toBeTruthy()
      expect(c.unidad, `${c.nombre} (${sku}): la plantilla pregunta en ${c.unidad} y el catalogo lo lleva en ${CATALOGO_REAL[sku]}`).toBe(
        unidadCorta(CATALOGO_REAL[sku])
      )
    }
    // Y la pregunta que lee la persona nombra esa unidad, no la otra.
    const otra = c.unidad === 'g' ? 'kg' : 'g'
    expect(PALABRA[c.unidad!].test(String(c.pregunta)), `${c.nombre}: "${c.pregunta}"`).toBe(true)
    expect(new RegExp('^[^(]*' + PALABRA[otra].source, 'i').test(String(c.pregunta)), `${c.nombre}: "${c.pregunta}"`).toBe(false)
  }
})

test('contestar la pregunta con el numero de la receta no escribe 1000 veces la receta', () => {
  const campos = camposDelYaml(YAML).filter((c) => c.insumo)
  let revisados = 0
  for (const c of campos) {
    for (const sku of skusDe(c.insumo!)) {
      const receta = RECETA_REAL[sku]
      if (receta === undefined) continue
      // La persona contesta la pregunta con el numero solo; la plantilla lo
      // manda con la unidad del campo y el servidor convierte a la del catalogo
      // (app/api/bot/lote/proponer/route.ts -> convertirMasa).
      const conv = convertirMasa(receta, c.unidad as 'g' | 'kg', CATALOGO_REAL[sku])
      expect(conv.ok, JSON.stringify(conv)).toBe(true)
      if (!conv.ok) continue
      const razon = conv.cantidad / receta
      expect(razon, `${c.nombre} (${sku}): receta ${receta}, se escribiria ${conv.cantidad}`).toBeLessThan(1000)
      expect(conv.cantidad).toBe(receta)
      revisados++
    }
  }
  expect(revisados, 'aditivo 1 y chile guajillo tienen receta').toBe(2)
})
