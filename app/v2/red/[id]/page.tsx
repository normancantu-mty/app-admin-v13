/**
 * Paginas v2 — `/v2/red/<id>`: la ficha COMPLETA de un nodo como pagina.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Es la misma `FichaVista` del modal `/v2/m/nodo/<id>` (no se duplica logica),
 * con encabezado de pagina. Sus capturas (venta, cobranza, abono, devolucion,
 * conteo) se abren como modal encima de esta pagina y, al guardar, vuelven aqui
 * (`ProveedorModal` recuerda la base). `leerFichaNodo` aplica la visibilidad
 * por rol: el DST solo abre lo suyo; lo ajeno es 404.
 */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { leerFichaNodo } from '@/lib/v2/nodo'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { FichaVista } from '@/components/v2/nodo/FichaVista'

export const dynamic = 'force-dynamic'

export default async function FichaNodoV2({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  const { id } = await params
  const ficha = await leerFichaNodo(id, usuario)
  if (!ficha) notFound()
  const conRed = esRolDeMandoV2(usuario.rol) || usuario.rol === 'DST'
  return (
    <>
      <EncabezadoPagina
        titulo={ficha.entidad.nombre}
        sub={id === usuario.id ? 'Tu ficha' : 'Ficha del nodo'}
        migas={conRed ? [{ href: '/v2/red', texto: usuario.rol === 'DST' ? 'Mi red' : 'Red' }] : undefined}
      />
      <FichaVista ficha={ficha} usuario={usuario} />
    </>
  )
}
