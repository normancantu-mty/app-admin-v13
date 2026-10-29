'use client'
// Paridad v2: copia de app/dashboard/conteo/CapturaConteo.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useEffect, useState, useTransition } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import {
  leerLibroDeEntidadAction,
  registrarConteoFisicoAction,
  type EntidadParaConteo,
  type RenglonDeLibro
} from '@/app/actions/conteo'
import type { Cubeta } from '@/lib/inventario-types'

/** Hoy en hora de Mexico. El navegador puede estar en otro huso; el hecho no. */
function hoyEnMexico(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function claveRenglon(renglon: RenglonDeLibro): string {
  return `${renglon.cubeta}|${renglon.idProducto}`
}

interface ResultadoVisible {
  tono: 'ok' | 'error'
  texto: string
  detalle?: string[]
}

export function CapturaConteo({ entidades, fija }: { entidades: EntidadParaConteo[]; fija?: string }) {
  const { marcarCambio } = useModalV2()
  const [idEntidad, setIdEntidad] = useState('')
  const [fecha, setFecha] = useState(hoyEnMexico())
  const [notas, setNotas] = useState('')
  const [renglones, setRenglones] = useState<RenglonDeLibro[]>([])
  const [contadas, setContadas] = useState<Record<string, string>>({})
  const [resultado, setResultado] = useState<ResultadoVisible | null>(null)
  const [cargandoLibro, setCargandoLibro] = useState(false)
  const [guardando, empezarGuardado] = useTransition()

  // Paridad v2: en la ficha del nodo la entidad ya viene elegida.
  useEffect(() => {
    if (fija) void elegirEntidad(fija)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fija])

  async function elegirEntidad(id: string) {
    setIdEntidad(id)
    setRenglones([])
    setContadas({})
    setResultado(null)

    if (!id) return

    setCargandoLibro(true)
    const libro = await leerLibroDeEntidadAction(id)
    setCargandoLibro(false)

    if (!libro.success) {
      setResultado({ tono: 'error', texto: libro.error })
      return
    }

    if (libro.renglones.length === 0) {
      setResultado({
        tono: 'error',
        texto: 'Ese punto de venta no tiene nada en el libro. No hay que contar.'
      })
      return
    }

    setRenglones(libro.renglones)
  }

  function guardar() {
    const lineas = renglones
      .map((renglon) => ({ renglon, crudo: contadas[claveRenglon(renglon)] }))
      .filter(({ crudo }) => crudo !== undefined && crudo.trim() !== '')
      .map(({ renglon, crudo }) => ({
        idProducto: renglon.idProducto,
        cubeta: renglon.cubeta as Cubeta,
        piezasContadas: Number(crudo)
      }))

    if (lineas.length === 0) {
      setResultado({
        tono: 'error',
        texto: 'No escribiste ni una cantidad. Lo que dejes en blanco no se cuenta.'
      })
      return
    }

    empezarGuardado(async () => {
      const respuesta = await registrarConteoFisicoAction({
        idEntidad,
        fechaConteo: fecha,
        lineas,
        notas: notas.trim() || undefined
      })

      if (!respuesta.success) {
        setResultado({ tono: 'error', texto: respuesta.error })
        return
      }

      const nombrePorId = new Map(renglones.map((r) => [r.idProducto, r.producto]))
      const detalle = respuesta.diferencias
        .filter((d) => d.diferencia !== 0)
        .map((d) => {
          const nombre = nombrePorId.get(d.idProducto) ?? d.idProducto
          const verbo = d.diferencia > 0 ? 'faltan' : 'sobran'
          return `${nombre} (${d.cubeta}): el libro dice ${d.libroDecia}, contaste ${d.piezasContadas} — ${verbo} ${Math.abs(d.diferencia)}`
        })

      setResultado({ tono: 'ok', texto: `Conteo guardado. ${respuesta.resumen}`, detalle })
      setContadas({})
    })
  }

  return (
    <div className="mt-6 max-w-3xl space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Punto de venta</span>
          <select
            value={idEntidad}
            onChange={(e) => void elegirEntidad(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-3 text-gray-900"
          >
            <option value="">Elige uno…</option>
            {entidades.map((entidad) => (
              <option key={entidad.id} value={entidad.id}>
                {entidad.nombre} ({entidad.rol})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Dia en que se conto
          </span>
          <input
            type="date"
            value={fecha}
            max={hoyEnMexico()}
            onChange={(e) => setFecha(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-3 text-gray-900"
          />
          <span className="mt-1 block text-xs text-gray-500">
            El dia del hecho, no el de la captura.
          </span>
        </label>
      </div>

      {cargandoLibro && <p className="text-sm text-gray-500">Leyendo el libro…</p>}

      {renglones.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="p-3 font-medium text-gray-700">Producto</th>
                <th className="p-3 font-medium text-gray-700">Cubeta</th>
                <th className="p-3 text-right font-medium text-gray-700">
                  El libro dice
                </th>
                <th className="p-3 text-right font-medium text-gray-700">
                  Contaste
                </th>
              </tr>
            </thead>
            <tbody>
              {renglones.map((renglon) => {
                const clave = claveRenglon(renglon)
                return (
                  <tr key={clave} className="border-t border-gray-200">
                    <td className="p-3 text-gray-900">{renglon.producto}</td>
                    <td className="p-3 text-gray-500">{renglon.cubeta}</td>
                    <td className="p-3 text-right tabular-nums text-gray-500">{renglon.libroDice}</td>
                    <td className="p-3 text-right">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        placeholder="—"
                        value={contadas[clave] ?? ''}
                        onChange={(e) =>
                          setContadas((previo) => ({ ...previo, [clave]: e.target.value }))
                        }
                        className="w-24 rounded-lg border border-gray-300 bg-white p-2 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {renglones.length > 0 && (
        <>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <input
              type="text"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Quien conto, que se vio raro…"
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-3 text-gray-900"
            />
          </label>

          <button
            type="button"
            onClick={guardar}
            disabled={guardando}
            className="w-full rounded-lg bg-blue-600 p-3 font-semibold text-white disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {guardando ? 'Guardando…' : 'Guardar conteo'}
          </button>
        </>
      )}

      {resultado && (
        <div
          className={
            resultado.tono === 'ok'
              ? 'rounded-lg bg-green-50 p-4 text-green-800'
              : 'rounded-lg bg-red-50 p-4 text-red-700'
          }
        >
          <p className="font-medium">{resultado.texto}</p>
          {resultado.detalle && resultado.detalle.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {resultado.detalle.map((linea) => (
                <li key={linea}>{linea}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
