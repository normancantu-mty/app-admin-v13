/** v2 — modal «Suscripciones»: catalogo, estado del mes y total; alta y edicion. Escrito el 2026-11-09 por el Socio (ejecutor). */

import { notFound } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esAdmin } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { cuentaUsableporElBot } from '@/lib/bot-servidor'
import { hoyEnMX } from '@/lib/date-format'
import { lineasDeTotal, mesDe, montoConMoneda, nombreDeMes, pesos, SUBCATEGORIAS_SUSCRIPCION } from '@/lib/suscripciones'
import { leerSuscripciones } from '@/lib/suscripciones-leer'
import { Modal } from '@/components/v2/modal/Modal'
import Suscripciones from '@/components/v2/finanzas/Suscripciones'

export default async function ModalSuscripciones() {
  const usuario = await exigirSesionV2()
  if (!esAdmin(usuario.rol)) notFound()
  const tipada = await getServerSupabaseClient()
  const hoy = hoyEnMX(new Date())
  const mes = mesDe(hoy)
  const [lectura, { data: cuentas }] = await Promise.all([
    leerSuscripciones(tipada as unknown as SupabaseClient, mes, hoy),
    tipada.from('cuentas_financieras').select('id, nombre, tipo_fiscalidad').eq('id_entidad', usuario.id).order('nombre', { ascending: true })
  ])
  const usables = ((cuentas ?? []) as { id: string; nombre: string; tipo_fiscalidad: string | null }[])
    .filter(cuentaUsableporElBot)
    .map((c) => ({ id: c.id, nombre: c.nombre }))
  return (
    <Modal titulo="Suscripciones" sub="Lo que se cobra cada mes · el bot pregunta si ya se pagó" tam="md">
      <div className="v1">
        {lectura.ok ? (
          <Suscripciones
            mes={nombreDeMes(mes)}
            items={lectura.datos.renglones.map((r) => ({
              ...r.s,
              notas: r.s.notas ?? null,
              montoTexto: montoConMoneda(r.s),
              estado: r.estado,
              pagadoTexto: r.montoPagado !== null ? pesos(r.montoPagado) : null
            }))}
            totalLineas={lineasDeTotal(lectura.datos.total)}
            anteriores={lectura.datos.anteriores.map(
              (a) =>
                `${a.s.nombre} · ${nombreDeMes(a.fila.mes)} · ${montoConMoneda(a.s)}` +
                (a.fila.estado === 'PAGADA' ? ' · el egreso se anuló' : '')
            )}
            cuentas={usables}
            subcategorias={[...SUBCATEGORIAS_SUSCRIPCION]}
          />
        ) : (
          <p className="text-red-700">
            {lectura.faltanTablas ? 'Falta aplicar la migración de suscripciones en la base.' : 'No pude leer las suscripciones.'}
          </p>
        )}
      </div>
    </Modal>
  )
}
