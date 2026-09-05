/**
 * ERP-59 — El escritor de avisos.
 *
 * **No lleva `'use server'` a proposito**, por la misma razon que
 * `lib/server-session.ts`: en un archivo `'use server'` toda exportacion se
 * vuelve un endpoint invocable desde el navegador, y esta funcion la llaman las
 * validaciones desde dentro del servidor. Nadie debe poder fabricar avisos
 * desde fuera.
 *
 * LA REGLA QUE MANDA EN TODO ESTE ARCHIVO: **registrar un aviso jamas puede
 * tumbar la escritura que lo genero.** Si el INSERT del aviso falla, se anota en
 * consola y se sigue. Al reves seria absurdo: la cola existe para que la fila
 * entre, y no puede convertirse ella misma en un motivo nuevo de rechazo.
 */

import type { ClienteServidor } from '@/lib/server-session'
import { severidadDeAviso, type TipoAviso } from '@/lib/avisos'

export interface AvisoNuevo {
  tipo: TipoAviso
  /** De QUIEN es el aviso. Decide quien lo ve (RLS). Nunca vacio. */
  idEntidad: string
  /** Que le falta o que se ve raro, en una linea legible por un humano. */
  mensaje: string
  /** A que fila apunta, cuando apunta a una. Los dos o ninguno. */
  tabla?: 'transacciones_tickets' | 'finanzas_ledger' | 'inventario_ledger'
  idRegistro?: string
  /**
   * Lo que el capturista SI escribio y no cupo en la fila. Sin esto el aviso
   * dice "falta algo" y pierde justo el dato con el que se arregla.
   */
  datosCapturados?: Record<string, unknown>
}

/**
 * Escribe un aviso. No devuelve nada y no lanza: quien la llama ya decidio
 * dejar entrar la fila.
 *
 * La severidad NO se recibe como parametro — sale del catalogo de
 * `lib/avisos.ts`. Si se pudiera pasar a mano, dos llamadas del mismo tipo
 * podrian discrepar y la cola dejaria de poder ordenarse.
 */
export async function registrarAviso(
  supabase: ClienteServidor,
  aviso: AvisoNuevo
): Promise<void> {
  try {
    const tienePuntero = Boolean(aviso.tabla && aviso.idRegistro)

    const { error } = await supabase.from('avisos_captura').insert({
      tipo: aviso.tipo,
      severidad: severidadDeAviso(aviso.tipo),
      mensaje: aviso.mensaje,
      id_entidad: aviso.idEntidad,
      tabla: tienePuntero ? aviso.tabla! : null,
      id_registro: tienePuntero ? aviso.idRegistro! : null,
      datos_capturados: aviso.datosCapturados
        ? (aviso.datosCapturados as never)
        : null
      // `usuario_creador` lo pone el trigger `trg_autor_avisos` con el correo de
      // la sesion. Mandarlo desde aqui seria ruido: el servidor lo pisa.
    })

    if (error) {
      // A gritos y con el aviso completo: si la cola se queda muda, lo unico que
      // queda del hecho es esta linea de log.
      console.error(
        `[avisos] NO SE PUDO REGISTRAR EL AVISO ${aviso.tipo}: ${error.message}. ` +
          `La escritura SI entro. Aviso perdido: ${JSON.stringify(aviso)}`
      )
    }
  } catch (e) {
    console.error(
      `[avisos] EXCEPCION AL REGISTRAR EL AVISO ${aviso.tipo}: ${
        e instanceof Error ? e.message : String(e)
      }. La escritura SI entro. Aviso perdido: ${JSON.stringify(aviso)}`
    )
  }
}
