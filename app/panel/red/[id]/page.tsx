/**
 * Paginas v2 — `/panel/red/<id>`: la ficha COMPLETA de un nodo como pagina.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Es la misma `FichaVista` del modal `/panel/m/nodo/<id>` (no se duplica logica),
 * con encabezado de pagina. Sus capturas (venta, cobranza, abono, devolucion,
 * conteo) se abren como modal encima de esta pagina y, al guardar, vuelven aqui
 * (`ProveedorModal` recuerda la base). `leerFichaNodo` aplica la visibilidad
 * por rol: el DST solo abre lo suyo; lo ajeno es 404.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { leerFichaNodo } from '@/lib/v2/nodo'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { FichaVista } from '@/components/v2/nodo/FichaVista'
import { precargarCobranzaNodo } from '@/components/v2/cobranza/ResumenCobranzaNodo'

export const dynamic = 'force-dynamic'

export default async function FichaNodoV2({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  const { id } = await params
  // La franja de cobranza (solo mando) arranca junto con la ficha, no despues.
  if (esRolDeMandoV2(usuario.rol)) precargarCobranzaNodo(id)
  const ficha = await leerFichaNodo(id, usuario)
  if (!ficha) notFound()
  const conRed = esRolDeMandoV2(usuario.rol) || usuario.rol === 'DST'
  return (
    <>
      <EncabezadoPagina
        titulo={ficha.entidad.nombre}
        sub={id === usuario.id ? 'Tu ficha' : 'Ficha del nodo'}
        migas={conRed ? [{ href: `${RUTA_BASE}/red`, texto: usuario.rol === 'DST' ? 'Mi red' : 'Red' }] : undefined}
      />
      <FichaVista ficha={ficha} usuario={usuario} />
    </>
  )
}
