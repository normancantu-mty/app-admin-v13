/**
 * ERP-80 / ERP-81 — las dos decisiones de la pantalla del POS, puras.
 *
 * POR QUE EXISTE ESTE ARCHIVO. Las dos vivian dentro de `app/pos/page.tsx`, que
 * es un Client Component de ~800 lineas: imposible de probar sin navegador, y
 * por eso nadie noto que **el camino W4 estaba muerto desde el cliente**. El
 * servidor dejo de rechazar la concesion sin comprador, pero el boton "Generar
 * Ticket" seguia deshabilitado, asi que la unica forma de ejercer el caso
 * estrella de la cola era llamar a `procesarVentaPOS` a mano.
 *
 * LA LECCION, QUE VALE PARA TODA LA COLA: **un rechazo no deja de serlo por
 * vivir en el cliente.** Ablandar una validacion del servidor sin quitar el
 * `disabled=` que la acompaña no ablanda nada; solo mueve el rechazo a un sitio
 * donde ninguna prueba lo mira.
 */

import { ENTIDAD_PENDIENTE_DE_ASIGNAR, esCompradorSeleccionable } from '@/lib/avisos'

export interface EntidadCompradora {
  id: string
  rol: string
  id_padre?: string | null
  id_nodo_padre?: string | null
}

export interface VendedorActual {
  id: string
  rol: string
}

/**
 * ERP-80 — quien puede aparecer en el desplegable de comprador.
 *
 * El orden importa: **el centinela se descarta ANTES de mirar el rol**. Nace
 * como `LOC` para portarse como cualquier comprador ante el candado de la
 * cuenta fiscal, y el filtro del ADMIN (`rol === 'DST' || rol === 'LOC'`) lo
 * dejaba pasar derechito. No es un cliente: es el marcador de las
 * consignaciones sin dueño.
 */
export function filtrarCompradoresPermitidos<T extends EntidadCompradora>(
  lista: readonly T[],
  vendedor: VendedorActual
): T[] {
  return lista.filter((candidato) => {
    if (candidato.id === vendedor.id) return false
    if (!esCompradorSeleccionable(candidato)) return false

    if (vendedor.rol === 'ADMIN') {
      return candidato.rol === 'DST' || candidato.rol === 'LOC'
    }
    return candidato.id_padre === vendedor.id || candidato.id_nodo_padre === vendedor.id
  })
}

export interface EstadoVentaPOS {
  isSubmitting: boolean
  idVendedor: string
  itemsEnCarrito: number
  condicionPago: 'CONTADO' | 'CONCESION'
  idComprador: string
}

/**
 * ERP-81 — cuando se puede pulsar "Generar Ticket".
 *
 * Los tres motivos que quedan son **hechos que impiden que exista una venta**,
 * no datos incompletos: sin vendedor no hay quien venda, sin renglones no hay
 * que vender, y con un envio en vuelo no se manda otro. Ninguno se puede
 * arreglar despues desde la cola.
 *
 * **Lo que ya NO bloquea: una concesion sin comprador identificado.** Ese es
 * justo el caso W4 — la botella sale del almacen y quien la debe es el campo
 * que falta. Bloquearlo aqui es la razon por la que hay 72 botellas facturadas
 * fuera del ERP: cuando capturar bien es imposible, la gente no captura mal, no
 * captura. Ahora entra, se registra a nombre del centinela y deja su aviso.
 */
export function puedeGenerarTicket(estado: EstadoVentaPOS): boolean {
  if (estado.isSubmitting) return false
  if (!estado.idVendedor) return false
  if (estado.itemsEnCarrito <= 0) return false
  return true
}

/**
 * El letrero de la pantalla cuando la venta va a quedar sin dueño.
 *
 * Antes decia "Identifique al cliente para otorgar concesión" y venia con el
 * boton apagado: era un **bloqueo**. Ahora es un **aviso**: dice lo que va a
 * pasar, no lo que hay que hacer antes de seguir. Devuelve `null` cuando no
 * aplica, para que la pantalla no pinte nada.
 */
export function avisoConcesionSinComprador(
  condicionPago: 'CONTADO' | 'CONCESION',
  idComprador: string
): string | null {
  const sinComprador =
    String(idComprador ?? '').trim() === '' || idComprador === ENTIDAD_PENDIENTE_DE_ASIGNAR

  if (condicionPago !== 'CONCESION' || !sinComprador) return null

  return (
    'Se registrará a nombre de PENDIENTE DE ASIGNAR y quedará un aviso abierto ' +
    'hasta que asignes al comprador.'
  )
}
