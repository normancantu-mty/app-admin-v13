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
import { EQUIPO, QUIENES_CONOCIDOS, esDeLaRed, etiquetaQuien, quienExacto, type QuienPermitido } from '@/lib/regalos-quien'

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
  /** Solo si lo hay: un borrador viejo, sin esta llave, sella igual que antes. */
  id_entidad_destino?: string
}

export const LLAVES_REGALO = ['id_entidad', 'fecha', 'quien_regalo', 'motivo', 'usuario_creador', 'lineas', 'id_entidad_destino'] as const

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
  stocks: ReadonlyMap<string, StockCelda>,
  quienes: readonly QuienPermitido[] = EQUIPO,
  otrosAvisos: readonly string[] = []
): string {
  const nombre = new Map(productos.map((x) => [x.id, x.nombre]))
  const quien = quienExacto(p.quien_regalo, quienes)
  const deLaRed = esDeLaRed(quien)
  const destino = p.id_entidad_destino ? (quienes.find((q) => q.ids?.includes(p.id_entidad_destino!)) ?? null) : null
  const avisos = [...armarFilasRegalo(p.lineas, productos, stocks, '').avisos, ...otrosAvisos]
  // "Sale de la matriz": se dice si el que regala, o el que recibe, es un distribuidor o un local.
  const conExistencia = deLaRed ? p.quien_regalo : (destino?.nombre ?? '')
  const total = p.lineas.reduce((a, l) => a + l.cantidad, 0)
  const lineas = p.lineas.map((l) => `   ${piezasTexto(l.cantidad)} de ${nombre.get(l.id_producto) ?? 'producto'}`).join('\n')
  return (
    'REGALO: sale del inventario y NO toca dinero\n\n' +
    `QUIEN:      ${deLaRed ? etiquetaQuien(quien) : p.quien_regalo}\n` +
    `PARA:       ${destino ? `${etiquetaQuien(destino)}, se suma a sus regalos` : 'ningun distribuidor o local'}\n` +
    `FECHA:      ${p.fecha}\n` +
    `PIEZAS:     ${piezasTexto(total)}\n${lineas}\n` +
    `MOTIVO:     ${p.motivo}\n` +
    `DE:         ${entidad}\n` +
    (conExistencia ? `OJO:        sale de la matriz, no de lo que tiene ${conExistencia}.\n` : '') +
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
  if (l.falta === 'uno_por_mensaje' && l.destinos) {
    return 'Escucho a mas de un destino (o no todas las piezas son para el mismo). Mandame un regalo por mensaje: "Norman regalo 2 grandes a Casa Verde".'
  }
  if (l.falta === 'uno_por_mensaje') {
    return 'Escucho a mas de una persona regalando. Mandame un regalo por mensaje: "Kevin regalo 2 grandes, motivo: …" y luego "Gilberto regalo 3 chicas, motivo: …".'
  }
  if (l.falta === 'piezas' && l.cuantas !== undefined) {
    return `¿Grande, chica o mini? ${l.cuantas === 1 ? 'Es 1' : `Son ${l.cuantas}`}; contesta solo el tamaño, por ejemplo "grandes".`
  }
  if (l.falta === 'piezas' || l.falta === 'no_es_regalo') {
    return '¿Cuantas y de cual (grande, chica o mini)? Contesta asi: "1 grande".'
  }
  if (l.falta === 'quien') {
    const d = l.duda
    if (!d) return '¿Quien lo regalo? Contesta solo el nombre.'
    // Sin "regalo" en la respuesta: el bot tomaria "lo regalo el" como un regalo nuevo.
    if (d.motivo === 'rol') return `¿Lo regaló ${d.opciones[0]?.nombre ?? d.dicho} o era para él? Contesta "lo dio él" o "para él".`
    const opciones = d.opciones.map(etiquetaQuien)
    const lista = opciones.length > 1 ? `${opciones.slice(0, -1).join(', ')} o ${opciones[opciones.length - 1]}` : opciones.join('')
    if (d.sobre === 'destino') {
      const cabeza = d.motivo === 'ambiguo' ? `"${d.dicho}" puede ser ${lista}.` : `No reconozco a "${d.dicho}". ¿Quisiste decir ${lista}?`
      return `${cabeza} ¿A quién se le dio? Contesta el nombre como viene aquí, o "ninguno" si es otra persona.`
    }
    if (d.motivo === 'ambiguo') return `"${d.dicho}" puede ser ${lista}. ¿Quién fue? Contesta el nombre como viene aquí.`
    if (d.motivo === 'cual') return `No me queda claro de quién es este regalo: ¿${lista}? Contesta solo el nombre.`
    return (
      `No reconozco a "${d.dicho}", así que no registro nada todavía. ` +
      `Puede ser del equipo (${QUIENES_CONOCIDOS.join(', ')}), un distribuidor o un local. ` +
      (lista ? `¿Quisiste decir ${lista}? ` : '') +
      '¿Quién fue? Contesta solo el nombre, o "yo".'
    )
  }
  return '¿Cual fue la razon o el motivo? Contesta solo eso (o "sin motivo").'
}
