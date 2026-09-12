/**
 * ERP-54 — Contar sin cobrar.
 *
 * Aqui vive la aritmetica del conteo, **sin Supabase y sin `'use server'`**,
 * para que se pueda probar sin base y sin navegador. Lo que toca la red esta en
 * `app/actions/conteo.ts`.
 *
 * EL MODELO, EN UNA LINEA: un conteo dice cuantas piezas HAY. El libro dice
 * cuantas DEBERIA haber. **La diferencia entre los dos es el producto de este
 * evento** — no se corrige sola, no se cobra y no se esconde.
 */

import type { Cubeta } from '@/lib/inventario-types'

/** Una linea de captura: un SKU, una cubeta, las piezas que se contaron. */
export interface LineaConteo {
  idProducto: string
  cubeta: Cubeta
  piezasContadas: number
}

export interface ConteoCapturado {
  idEntidad: string
  /** Fecha del HECHO en hora de Mexico (`YYYY-MM-DD`), no la de la captura. */
  fechaConteo: string
  lineas: LineaConteo[]
  notas?: string
}

/** Lo que el libro dice hoy, por SKU y cubeta. Clave: `${cubeta}|${idProducto}`. */
export type LibroPorSku = Map<string, number>

export function claveDeLibro(cubeta: Cubeta, idProducto: string): string {
  return `${cubeta}|${idProducto}`
}

export interface DiferenciaConteo {
  idProducto: string
  cubeta: Cubeta
  piezasContadas: number
  libroDecia: number
  /** Positiva = FALTAN piezas en el piso. Negativa = hay de mas. */
  diferencia: number
}

/**
 * Las validaciones, todas juntas y en un solo lugar.
 *
 * **Ninguna de estas es un aviso: son rechazos.** La frontera del prompt 18-bis
 * dice que se avisa cuando el hecho ocurrio y falta un dato; aqui, en cambio,
 * lo que falla es el hecho mismo — una fecha futura o un SKU repetido no son un
 * conteo incompleto, son un conteo que no paso asi.
 */
export function validarConteo(entrada: ConteoCapturado, hoyMx: string): string[] {
  const errores: string[] = []

  if (!entrada.idEntidad) {
    errores.push('Falta la entidad: un conteo es siempre de alguien.')
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada.fechaConteo)) {
    errores.push(`Fecha del conteo ilegible: "${entrada.fechaConteo}". Se espera AAAA-MM-DD.`)
  } else if (entrada.fechaConteo > hoyMx) {
    errores.push(`La fecha del conteo (${entrada.fechaConteo}) es futura. Hoy es ${hoyMx}.`)
  }

  if (entrada.lineas.length === 0) {
    errores.push('El conteo no trae ni una linea. Un conteo parcial vale; uno vacio no dice nada.')
  }

  const vistas = new Set<string>()
  for (const linea of entrada.lineas) {
    const clave = claveDeLibro(linea.cubeta, linea.idProducto)

    if (vistas.has(clave)) {
      errores.push(`El mismo SKU aparece dos veces en la cubeta ${linea.cubeta}.`)
    }
    vistas.add(clave)

    if (!Number.isFinite(linea.piezasContadas) || linea.piezasContadas < 0) {
      errores.push(`Piezas invalidas (${linea.piezasContadas}): no puede haber menos de cero.`)
    }
    if (!Number.isInteger(linea.piezasContadas)) {
      errores.push(`Piezas invalidas (${linea.piezasContadas}): las botellas no se cuentan en fracciones.`)
    }
  }

  return errores
}

/**
 * Lo contado contra lo que el libro decia EN ESE MOMENTO.
 *
 * `libroDecia` se congela aqui y se guarda en la fila: el libro sigue
 * moviendose, y una diferencia que cambia sola cada vez que se consulta no es
 * evidencia de nada.
 *
 * **Un SKU que el libro no conoce vale 0, no se salta.** Si en el piso hay algo
 * que el sistema cree inexistente, esa es justo la anomalia que interesa.
 */
export function diferenciasDeConteo(
  lineas: readonly LineaConteo[],
  libro: LibroPorSku
): DiferenciaConteo[] {
  return lineas.map((linea) => {
    const libroDecia = libro.get(claveDeLibro(linea.cubeta, linea.idProducto)) ?? 0

    return {
      idProducto: linea.idProducto,
      cubeta: linea.cubeta,
      piezasContadas: linea.piezasContadas,
      libroDecia,
      diferencia: libroDecia - linea.piezasContadas
    }
  })
}

/** Las que no cuadran. Las que cuadran tambien se guardan: son la prueba de que se conto. */
export function soloDescuadres(diferencias: readonly DiferenciaConteo[]): DiferenciaConteo[] {
  return diferencias.filter((d) => d.diferencia !== 0)
}

/**
 * El renglon que lee un humano en la cola de avisos. Sin nombres de producto
 * —esta capa no conoce el catalogo—, con el conteo dicho en piezas.
 */
export function resumenDeDescuadres(diferencias: readonly DiferenciaConteo[]): string {
  const descuadres = soloDescuadres(diferencias)
  if (descuadres.length === 0) return 'El conteo cuadro con el libro en todas las lineas.'

  const faltan = descuadres
    .filter((d) => d.diferencia > 0)
    .reduce((suma, d) => suma + d.diferencia, 0)
  const sobran = descuadres
    .filter((d) => d.diferencia < 0)
    .reduce((suma, d) => suma - d.diferencia, 0)

  const partes: string[] = []
  if (faltan > 0) partes.push(`faltan ${faltan}`)
  if (sobran > 0) partes.push(`sobran ${sobran}`)

  return `${descuadres.length} SKU sin cuadrar: ${partes.join(' y ')} respecto al libro.`
}
