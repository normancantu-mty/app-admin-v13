export function calcularSemaforoDeuda(fechaUltimoAbono: string | null): 'VERDE' | 'AMARILLO' | 'ROJO' {
  if (!fechaUltimoAbono) return 'ROJO'

  const hoy = new Date()
  const fechaAbono = new Date(fechaUltimoAbono)
  const diasTranscurridos = Math.floor((hoy.getTime() - fechaAbono.getTime()) / (1000 * 60 * 60 * 24))

  if (diasTranscurridos <= 7) return 'VERDE'
  if (diasTranscurridos <= 15) return 'AMARILLO'
  return 'ROJO'
}
