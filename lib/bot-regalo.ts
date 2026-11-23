/**
 * REGALOS DESDE EL BOT — el lado puro. Escrito el 2026-11-20 por un ejecutor
 * del Socio. Se prueba en `tests/regalos.spec.ts`.
 *
 * "Kevin regalo 5 grandes, 5 chicas y 2 minis, motivo: evento X" -> propuesta
 * sellada -> VA -> `registrarRegalo` (`lib/regalos-servidor.ts`), la MISMA
 * escritura que el formulario de `/panel/regalos`.
 *
 * Diferencia con la merma: si no alcanza la existencia NO se detiene; la
 * propuesta lo AVISA y se guarda igual (regla de Norman: el ERP avisa, nunca
 * bloquea).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import type { AccionBot } from '@/lib/bot-permisos'
import { armarFilasRegalo, piezasTexto, type LecturaRegalo, type ProductoRegalo, type StockCelda } from '@/lib/regalos'

/**
 * Sale del inventario de la matriz: mismo permiso que la merma y el lote
 * (ADMIN directo; el trabajador, con Aprobar).
 */
export const PERMISO_REGALO: AccionBot = 'lote'
export const MENSAJE_REGALO_NO_PERMITIDO = 'Registrar regalos por aqui no te toca con tu alta.'

export interface PayloadRegalo {
  id_entidad: string
  fecha: string
  quien_regalo: string
  motivo: string
  usuario_creador: string
  lineas: { id_producto: string; cantidad: number }[]
}

export const LLAVES_REGALO = ['id_entidad', 'fecha', 'quien_regalo', 'motivo', 'usuario_creador', 'lineas'] as const

export function sellarRegalo(p: PayloadRegalo): string {
  return sellar(p, LLAVES_REGALO)
}

export function selloRegaloCoincide(p: PayloadRegalo, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_REGALO, sello)
}

/** La propuesta que se ensena antes del VA, con el aviso de existencia si aplica. **Pura.** */
export function mensajeDeRegalo(
  p: PayloadRegalo,
  productos: readonly ProductoRegalo[],
  entidad: string,
  stocks: ReadonlyMap<string, StockCelda>
): string {
  const nombre = new Map(productos.map((x) => [x.id, x.nombre]))
  const { avisos } = armarFilasRegalo(p.lineas, productos, stocks, '')
  const total = p.lineas.reduce((a, l) => a + l.cantidad, 0)
  const lineas = p.lineas.map((l) => `   ${piezasTexto(l.cantidad)} de ${nombre.get(l.id_producto) ?? 'producto'}`).join('\n')
  return (
    'REGALO: sale del inventario y NO toca dinero\n\n' +
    `QUIEN:      ${p.quien_regalo}\n` +
    `FECHA:      ${p.fecha}\n` +
    `PIEZAS:     ${piezasTexto(total)}\n${lineas}\n` +
    `MOTIVO:     ${p.motivo}\n` +
    `DE:         ${entidad}\n` +
    (avisos.length ? `\nAVISO: ${avisos.join('\n')}\n` : '') +
    '\nEs la misma escritura que "Regalos" de la web.\n' +
    'Contesta VA para escribirlo, o dime que cambio.'
  )
}

/** Lo que falta, en UNA pregunta. **Pura.** */
export function preguntaDeRegalo(l: Exclude<LecturaRegalo, { ok: true }>, productos: readonly ProductoRegalo[]): string {
  if (l.falta === 'tamano') {
    return `No tengo una presentacion "${l.dicho}". Dime grandes, chicas o minis (${productos.map((p) => p.nombre).join(', ')}).`
  }
  if (l.falta === 'uno_por_mensaje') {
    return 'Escucho a mas de una persona regalando. Mandame un regalo por mensaje: "Kevin regalo 2 grandes, motivo: …" y luego "Gilberto regalo 3 chicas, motivo: …".'
  }
  if (l.falta === 'piezas' || l.falta === 'no_es_regalo') {
    return '¿Cuantas y de cual (grande, chica o mini)? Contesta asi: "1 grande".'
  }
  if (l.falta === 'quien') return '¿Quien lo regalo? Contesta solo el nombre.'
  return '¿Cual fue la razon o el motivo? Contesta solo eso (o "sin motivo").'
}
