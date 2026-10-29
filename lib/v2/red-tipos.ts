/** Paridad v2 — tipos de la red, usables desde el cliente. Escrito el 2026-10-29 por el ejecutor del Socio. */

export type RolRed = 'DST' | 'LOC' | 'SOCIO'

/** La forma de una fila del directorio (igual a DirectoryRow de la v1). */
export interface FilaRed {
  id: string
  nombre: string
  rol: RolRed
  zona: string
  telefono: string | null
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
  aplica_redondeo_costo: boolean
  ubicacionMaps: string | null
  patrocinador: string
  saldoPendiente: number
  saldoPorPagar: number
  semaforo: string
  diasSeguimiento: number | null
  seguimientoTexto: string
}

