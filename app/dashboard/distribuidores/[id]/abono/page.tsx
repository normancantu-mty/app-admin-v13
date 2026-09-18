'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { hoyEnMX } from '@/lib/date-format'
import { METODOS_PAGO } from '@/lib/abonos'
import {
  getPropuestaAbonoAction,
  registrarAbonoAction,
  type PropuestaTicketAbono
} from '@/app/actions/abonos'

// Esta pantalla NO escribe en la base. Solo lee catalogos para poblar los
// selects y delega todo INSERT a `registrarAbonoAction`, que resuelve la sesion
// en servidor y toma `usuario_creador` de ahi.

interface CuentaOption {
  id: string
  nombre: string
  ownerEntityId: string | null
  ownerRole: string | null
  ownerNombre: string | null
}

/**
 * Hoy **en hora de Mexico**, que no es lo mismo que "en hora del navegador".
 *
 * ERP-23: esto leia `getTimezoneOffset()`, o sea el reloj de la maquina de
 * quien abre la pantalla. Acierta en una laptop puesta en Zacatecas y falla en
 * cualquier otra — y falla de la peor forma, porque **el servidor nunca
 * compartio ese criterio**: `hoyEnMexico()` en `app/actions/abonos.ts` siempre
 * midio en hora de Mexico. Con los dos relojes en desacuerdo, el formulario
 * proponia por default una fecha que el servidor recibia como futura y
 * levantaba un aviso W10/W11 sobre un pago que no tenia nada de malo. Ahora los
 * dos lados dicen `hoyEnMX`.
 */
function hoyLocalISO(): string {
  return hoyEnMX()
}

function formatFechaTicket(fecha: string | null): string {
  if (!fecha) return 'Sin fecha'
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return 'Sin fecha'
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: '2-digit' })
}

export default function RegistrarAbonoPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [cuentasAdmin, setCuentasAdmin] = useState<CuentaOption[]>([])
  const [cuentasEntidad, setCuentasEntidad] = useState<CuentaOption[]>([])

  const [idCuentaOrigen, setIdCuentaOrigen] = useState('')
  const [idCuentaDestino, setIdCuentaDestino] = useState('')
  const [monto, setMonto] = useState('')
  const [referencia, setReferencia] = useState('')
  const [fechaPago, setFechaPago] = useState(hoyLocalISO)
  const [metodoPago, setMetodoPago] = useState('')
  const [nota, setNota] = useState('')

  const [ticketsPendientes, setTicketsPendientes] = useState<PropuestaTicketAbono[]>([])
  const [aplicaciones, setAplicaciones] = useState<Record<string, string>>({})
  const [propuestaError, setPropuestaError] = useState<string | null>(null)
  const [cargandoPropuesta, setCargandoPropuesta] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    const fetchCuentas = async () => {
      try {
        const { data: cuentasRaw, error: cuentasError } = await supabase
          .from('cuentas_financieras')
          .select('id, nombre, id_entidad')
          .order('nombre', { ascending: true })

        if (cuentasError || !cuentasRaw) {
          console.error('Error fetching cuentas:', cuentasError)
          return
        }

        const entityIds = Array.from(new Set(cuentasRaw.map((c) => c.id_entidad).filter(Boolean)))
        const { data: entidadesRaw, error: entidadesError } = await supabase
          .from('entidades')
          .select('id, nombre, rol')
          .in('id', entityIds)

        if (entidadesError || !entidadesRaw) {
          console.error('Error fetching entidades owners:', entidadesError)
          return
        }

        const entidadById = new Map(entidadesRaw.map((entidad) => [entidad.id, entidad]))
        const mapped: CuentaOption[] = cuentasRaw.map((cuenta) => {
          const owner = cuenta.id_entidad ? entidadById.get(cuenta.id_entidad) : null
          return {
            id: cuenta.id,
            nombre: cuenta.nombre,
            ownerEntityId: cuenta.id_entidad,
            ownerRole: owner?.rol ?? null,
            ownerNombre: owner?.nombre ?? null
          }
        })

        const sinVirtual = (cuenta: CuentaOption) => !cuenta.nombre.toLowerCase().includes('virtual')
        setCuentasAdmin(mapped.filter((cuenta) => cuenta.ownerRole === 'ADMIN' && sinVirtual(cuenta)))
        setCuentasEntidad(mapped.filter((cuenta) => cuenta.ownerEntityId === resolvedParams.id && sinVirtual(cuenta)))
      } catch (error) {
        console.error('Error in fetchCuentas:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchCuentas()
  }, [resolvedParams.id])

  const cuentaOrigen = [...cuentasAdmin, ...cuentasEntidad].find((cuenta) => cuenta.id === idCuentaOrigen)
  const cuentaDestino = [...cuentasAdmin, ...cuentasEntidad].find((cuenta) => cuenta.id === idCuentaDestino)
  const origenEsAdmin = cuentaOrigen?.ownerRole === 'ADMIN'
  const destinoEsAdmin = cuentaDestino?.ownerRole === 'ADMIN'

  const conceptoAutomatico = (() => {
    if (!cuentaOrigen || !cuentaDestino) return 'Transferencia manual'
    if (origenEsAdmin && !destinoEsAdmin) return 'Cargo de Deuda (Admin → Distribuidor)'
    if (!origenEsAdmin && destinoEsAdmin) return 'Abono de Deuda (Distribuidor → Admin)'
    return 'Transferencia manual'
  })()

  // Solo un abono (Distribuidor → Admin) paga pedidos. Un cargo de deuda no.
  const esAbonoDeDeuda = Boolean(cuentaOrigen && cuentaDestino && !origenEsAdmin && destinoEsAdmin)
  const montoNum = Number.parseFloat(monto)
  const montoValido = Number.isFinite(montoNum) && montoNum > 0

  const cargarPropuesta = useCallback(async () => {
    if (!esAbonoDeDeuda || !montoValido) {
      setTicketsPendientes([])
      setAplicaciones({})
      setPropuestaError(null)
      return
    }

    setCargandoPropuesta(true)
    setPropuestaError(null)
    try {
      const result = await getPropuestaAbonoAction(resolvedParams.id, montoNum)
      if (!result.success || !result.data) {
        setTicketsPendientes([])
        setAplicaciones({})
        setPropuestaError(result.error ?? 'No se pudo calcular la propuesta.')
        return
      }

      setTicketsPendientes(result.data.tickets)
      const iniciales: Record<string, string> = {}
      for (const ticket of result.data.tickets) {
        iniciales[ticket.id_ticket] = ticket.propuesto > 0 ? ticket.propuesto.toFixed(2) : ''
      }
      setAplicaciones(iniciales)
    } catch (error) {
      console.error('Error cargando propuesta de abono:', error)
      setPropuestaError('No se pudo calcular la propuesta.')
    } finally {
      setCargandoPropuesta(false)
    }
  }, [esAbonoDeDeuda, montoValido, montoNum, resolvedParams.id])

  // La propuesta se deriva del monto y de la direccion: al cambiar cualquiera
  // de los dos se vuelve a proponer desde cero (con debounce para no pegarle al
  // servidor en cada tecla).
  useEffect(() => {
    const timer = setTimeout(() => {
      void cargarPropuesta()
    }, 450)
    return () => clearTimeout(timer)
  }, [cargarPropuesta])

  const aplicacionesList = ticketsPendientes
    .map((ticket) => ({
      id_ticket: ticket.id_ticket,
      monto: Number.parseFloat(aplicaciones[ticket.id_ticket] ?? '')
    }))
    .filter((a) => Number.isFinite(a.monto) && a.monto > 0)

  const totalAplicado = aplicacionesList.reduce((suma, a) => suma + a.monto, 0)
  const sobrante = montoValido ? Number((montoNum - totalAplicado).toFixed(2)) : 0
  const excedeMonto = montoValido && totalAplicado - montoNum > 0.004

  const limpiarAplicaciones = () => {
    setAplicaciones(Object.fromEntries(ticketsPendientes.map((t) => [t.id_ticket, ''])))
  }

  const handleGuardarTransferencia = async () => {
    setFormError(null)

    // ERP-59 · W13. Igual que en el boton: solo el ORIGEN se ablanda. El
    // servidor cae a la cuenta propia de la entidad -- nunca a una ADMIN ni a la
    // fiscal -- y deja el aviso.
    if (!idCuentaDestino || !monto) {
      setFormError('Completa destino y monto.')
      return
    }
    if (idCuentaOrigen && idCuentaOrigen === idCuentaDestino) {
      setFormError('Origen y destino deben ser diferentes.')
      return
    }
    if (!montoValido) {
      setFormError('El monto debe ser mayor a cero.')
      return
    }
    if (excedeMonto) {
      setFormError('La suma aplicada a pedidos excede el monto del abono.')
      return
    }

    setIsLoading(true)
    try {
      const result = await registrarAbonoAction({
        idEntidad: resolvedParams.id,
        idCuentaOrigen,
        idCuentaDestino,
        monto: montoNum,
        fechaPago,
        metodoPago: metodoPago || null,
        nota,
        referencia,
        aplicaciones: aplicacionesList
      })

      if (!result.success) {
        setFormError(result.error ?? 'No se pudo registrar el abono.')
        return
      }

      alert(
        result.requiereAprobacionAdmin
          ? 'Abono registrado y enviado a la cola de aprobación del Admin.'
          : 'Transferencia registrada correctamente.'
      )
      router.push(`/dashboard/distribuidores/${resolvedParams.id}`)
      router.refresh()
    } catch (error) {
      console.error('Error registrando transferencia:', error)
      setFormError('No se pudo registrar la transferencia.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <Link
            href={`/dashboard/distribuidores/${resolvedParams.id}`}
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver al Estado de Cuenta
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Transferencia Manual</h1>
          <p className="text-gray-600 mt-2">Control explícito de abonos, pagos de comisión y movimientos cruzados.</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6 space-y-6">
          <div>
            <label htmlFor="origen" className="block text-sm font-medium text-gray-700 mb-2">
              Origen
            </label>
            <select
              id="origen"
              value={idCuentaOrigen}
              onChange={(e) => setIdCuentaOrigen(e.target.value)}
              disabled={isLoadingData}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">{isLoadingData ? 'Cargando cuentas...' : 'Selecciona origen...'}</option>
              <optgroup label="Cuentas ADMIN">
                {cuentasAdmin.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
              <optgroup label="Cuentas Distribuidor/Local">
                {cuentasEntidad.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div>
            <label htmlFor="destino" className="block text-sm font-medium text-gray-700 mb-2">
              Destino
            </label>
            <select
              id="destino"
              value={idCuentaDestino}
              onChange={(e) => setIdCuentaDestino(e.target.value)}
              disabled={isLoadingData}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">{isLoadingData ? 'Cargando cuentas...' : 'Selecciona destino...'}</option>
              <optgroup label="Cuentas ADMIN">
                {cuentasAdmin.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
              <optgroup label="Cuentas Distribuidor/Local">
                {cuentasEntidad.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="monto" className="block text-sm font-medium text-gray-700 mb-2">
                Monto
              </label>
              <input
                id="monto"
                type="number"
                min="0.01"
                step="0.01"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="Ej. 1500.00"
              />
            </div>

            <div>
              <label htmlFor="fechaPago" className="block text-sm font-medium text-gray-700 mb-2">
                Fecha del pago
              </label>
              {/*
                ERP-59 · W11. Tenia un tope de fecha en el propio input y un
                rechazo en el envio: entre los dos, una fecha futura no se podia
                ni teclear. Ahora entra
                y el servidor la ancla a hoy dejando el aviso con la original --
                guardarla en el futuro la haria desaparecer de todo filtro
                "hasta hoy", que es peor que una fecha mal puesta.
              */}
              <input
                id="fechaPago"
                type="date"
                value={fechaPago}
                onChange={(e) => setFechaPago(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <p className="text-xs text-gray-500 mt-1">Cuándo se recibió el dinero, no cuándo se captura.</p>
              {fechaPago > hoyLocalISO() && (
                <p className="mt-1 text-xs text-amber-700">
                  ⚠️ Fecha futura: el abono se registrará con la fecha de hoy y quedará un aviso abierto.
                </p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="metodoPago" className="block text-sm font-medium text-gray-700 mb-2">
              Método de pago <span className="text-gray-400 font-normal">(opcional)</span>
            </label>
            <select
              id="metodoPago"
              value={metodoPago}
              onChange={(e) => setMetodoPago(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">Sin especificar</option>
              {METODOS_PAGO.map((metodo) => (
                <option key={metodo} value={metodo}>{metodo}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="referencia" className="block text-sm font-medium text-gray-700 mb-2">
              Referencia / Concepto
            </label>
            <input
              id="referencia"
              type="text"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder={conceptoAutomatico}
            />
            <p className="text-xs text-gray-500 mt-1">Concepto sugerido: {conceptoAutomatico}</p>
          </div>

          <div>
            <label htmlFor="nota" className="block text-sm font-medium text-gray-700 mb-2">
              Nota <span className="text-gray-400 font-normal">(opcional)</span>
            </label>
            <textarea
              id="nota"
              rows={3}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Quién entregó el dinero, folio del depósito, acuerdos..."
            />
          </div>

          {esAbonoDeDeuda && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-md p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                    ¿A qué pedido aplica?
                  </h2>
                  <p className="text-xs text-gray-500">
                    Propuesta automática del más antiguo al más nuevo. Puedes editarla o dejarla vacía.
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void cargarPropuesta()}
                    disabled={cargandoPropuesta || !montoValido}
                    className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Recalcular
                  </button>
                  <button
                    type="button"
                    onClick={limpiarAplicaciones}
                    disabled={!ticketsPendientes.length}
                    className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Dejar sin aplicar
                  </button>
                </div>
              </div>

              {!montoValido && (
                <p className="text-xs text-gray-500">Captura un monto para ver la propuesta.</p>
              )}
              {cargandoPropuesta && <p className="text-xs text-gray-500">Calculando propuesta...</p>}
              {propuestaError && <p className="text-xs text-red-600">{propuestaError}</p>}
              {montoValido && !cargandoPropuesta && !propuestaError && !ticketsPendientes.length && (
                <p className="text-xs text-gray-600">
                  Esta entidad no tiene pedidos en consignación con saldo pendiente. El abono se
                  registrará &quot;a cuenta&quot;, sin pedido.
                </p>
              )}

              {ticketsPendientes.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 pr-3">Pedido</th>
                        <th className="py-2 pr-3 text-right">Total</th>
                        <th className="py-2 pr-3 text-right">Ya abonado</th>
                        <th className="py-2 pr-3 text-right">Saldo</th>
                        <th className="py-2 text-right">Aplicar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ticketsPendientes.map((ticket) => (
                        <tr key={ticket.id_ticket} className="border-b border-gray-100 dark:border-gray-700">
                          <td className="py-2 pr-3">
                            <div>{formatFechaTicket(ticket.fecha_transaccion)}</div>
                            <div className="text-xs text-gray-400">#{ticket.id_ticket.slice(0, 8)}</div>
                          </td>
                          <td className="py-2 pr-3 text-right">{formatCurrency(ticket.total_cobrado_real)}</td>
                          <td className="py-2 pr-3 text-right text-gray-500">{formatCurrency(ticket.ya_aplicado)}</td>
                          <td className="py-2 pr-3 text-right font-medium">{formatCurrency(ticket.saldo)}</td>
                          <td className="py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              max={ticket.saldo}
                              step="0.01"
                              value={aplicaciones[ticket.id_ticket] ?? ''}
                              onChange={(e) =>
                                setAplicaciones((prev) => ({ ...prev, [ticket.id_ticket]: e.target.value }))
                              }
                              className="w-28 px-2 py-1 border border-gray-300 rounded-md text-right"
                              placeholder="0.00"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {montoValido && (
                <div className="text-sm flex flex-wrap gap-x-6 gap-y-1 pt-1">
                  <span>
                    Aplicado a pedidos: <strong>{formatCurrency(totalAplicado)}</strong>
                  </span>
                  <span className={excedeMonto ? 'text-red-600' : ''}>
                    Sin aplicar (a cuenta): <strong>{formatCurrency(sobrante)}</strong>
                  </span>
                  {aplicacionesList.length > 1 && (
                    <span className="text-xs text-gray-500 basis-full">
                      Se escribirán {aplicacionesList.length + (sobrante > 0.004 ? 1 : 0)} movimientos:
                      uno por pedido, con la misma fecha, método y nota.
                    </span>
                  )}
                </div>
              )}

              {excedeMonto && (
                <p className="text-sm text-red-600">
                  La suma aplicada excede el monto del abono. Ajusta antes de guardar.
                </p>
              )}
            </div>
          )}

          {formError && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2">
              {formError}
            </p>
          )}

          <div className="flex gap-4 pt-2">
            <button
              type="button"
              onClick={handleGuardarTransferencia}
              // ERP-59 · W13: `!idCuentaOrigen` salio. Destino, monto y el reparto
              // que no cuadra SE QUEDAN: sin destino no hay a donde mandar el
              // dinero, y un reparto excedido cobra dos veces el mismo pedido.
              disabled={isLoading || !idCuentaDestino || !monto || excedeMonto}
              className="flex-1 bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 disabled:bg-gray-400 font-semibold"
            >
              {isLoading ? 'Registrando...' : 'Guardar Transferencia'}
            </button>
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}`}
              className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium"
            >
              Cancelar
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
