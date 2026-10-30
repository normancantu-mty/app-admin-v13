/**
 * Paginas v2 — `/panel/red`: TODO el apartado de la red de distribucion en una
 * pagina. Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * El modal `/panel/m/red` es la vista rapida desde el panel; aqui va el directorio
 * completo (seguimiento, editar, alta) y, para la matriz, la cartera completa.
 * Cada nodo lleva a su ficha completa (`/panel/red/<id>`); «Ver estado» sigue
 * abriendo la ficha rapida en modal. El alta se abre como modal encima.
 *
 * Roles: ADMIN y SOCIO ven toda la red (SOCIO solo lee); el DST ve SU red
 * (`leerRed` filtra por usuario) y no ve la cartera de la matriz. LOC y
 * SUB-ADMIN no tienen esta pagina (igual que el modal).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { leerRed } from '@/lib/v2/red'
import { mxn } from '@/lib/v2/formato'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import Directorio from '@/components/v2/red/Directorio'
import { CarteraVista } from '@/components/v2/red/CarteraVista'

export const dynamic = 'force-dynamic'

export default async function RedV2() {
  const usuario = await exigirSesionV2()
  if (usuario.rol !== 'ADMIN' && usuario.rol !== 'SOCIO' && usuario.rol !== 'DST') notFound()
  const filas = await leerRed(await getServerSupabaseClient(), usuario)
  const esAdmin = usuario.rol === 'ADMIN'
  const mando = esRolDeMandoV2(usuario.rol)
  const dst = filas.filter((f) => f.rol === 'DST').length
  const loc = filas.filter((f) => f.rol === 'LOC').length
  const pendiente = filas.reduce((a, f) => a + f.saldoPendiente, 0)

  return (
    <>
      <EncabezadoPagina
        titulo={mando ? 'Red de distribución' : 'Mi red'}
        sub={mando ? 'Directorio completo, seguimiento y cartera' : 'Tus locales, su saldo y su seguimiento'}
        acciones={
          esAdmin ? (
            <AbrirModal className="btn p" href={`${RUTA_BASE}/m/red/nuevo?volver=${RUTA_BASE}/red`} titulo="Nuevo miembro" tam="md" data-testid="red-pagina-alta">
              + Nuevo miembro
            </AbrirModal>
          ) : null
        }
      />

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi fuerte">
          <span className="t">Total red</span>
          <span className="v">{filas.length}</span>
        </div>
        <div className="kpi">
          <span className="t">Distribuidores</span>
          <span className="v">{dst}</span>
        </div>
        <div className="kpi">
          <span className="t">Locales</span>
          <span className="v">{loc}</span>
        </div>
        <div className="kpi">
          <span className="t">Saldo pendiente</span>
          <span className="v">{mxn(pendiente)}</span>
          <span className="d">suma de v_saldo_entidad de la red visible</span>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Directorio</h2>
            <div className="sub">Busca, filtra por rol, da seguimiento y edita. «Ficha completa» abre todo lo del nodo.</div>
          </div>
        </div>
        {filas.length === 0 ? (
          <div className="vacio">
            <b>No hay miembros en la red</b>
          </div>
        ) : (
          <div className="v1">
            <Directorio rows={filas} canEdit={esAdmin} canDeleteEntity={esAdmin} showZonaColumn={esAdmin} fichaEnPagina />
          </div>
        )}
        <div className="fuente">entidades · v_saldo_entidad</div>
      </section>

      {mando && (
        <section data-testid="red-cartera">
          <div className="ph" style={{ marginTop: 8 }}>
            <div>
              <h1 style={{ fontSize: 20 }}>Cartera</h1>
              <p>Quién debe, cuánto y desde cuándo</p>
            </div>
          </div>
          <CarteraVista fichaEnPagina />
        </section>
      )}
    </>
  )
}
