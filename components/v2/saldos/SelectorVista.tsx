'use client'

/**
 * Front v2 — la pildora «Individual | Sumado» del encabezado. Escrito el
 * 2026-10-30 por el ejecutor de saldos (lanzado por el Socio).
 *
 * COMO CAMBIA SIN IR AL SERVIDOR: las pantallas de saldos pintan las DOS vistas
 * (`.vs-ind` y `.vs-sum`) y el CSS de `app/v2/v2.css` esconde una u otra segun el
 * `data-vista` de esta pildora (`.v2:has(.vs-sel[data-vista="sumado"])`). El clic
 * solo cambia ese atributo: instantaneo, y vale igual dentro de los modales,
 * porque el slot `@modal` y `#v2-portal` viven dentro de `.v2`.
 *
 * SIN PARPADEO: la eleccion se guarda en una cookie (convencion del repo:
 * el cliente escribe `document.cookie`, el servidor la lee con `cookies()`), y
 * `VistaSaldos` la lee al pintar, asi que el HTML ya llega con la vista buena.
 */

import { useSyncExternalStore } from 'react'
import { guardarVista, type Vista } from './vista'

const OPCIONES: { v: Vista; l: string; t: string }[] = [
  { v: 'individual', l: 'Individual', t: 'Una tarjeta por cuenta, cada una con sus datos' },
  { v: 'sumado', l: 'Sumado', t: 'Todas las cuentas juntas: el total y lo que aporta cada una' }
]

// Estado COMPARTIDO entre todas las pildoras montadas (la del encabezado y la del
// modal de cuenta, que tapa el encabezado): null = nadie ha elegido en esta carga.
let actual: Vista | null = null
const oyentes = new Set<() => void>()
function suscribir(fn: () => void) {
  oyentes.add(fn)
  return () => oyentes.delete(fn)
}
function fijar(v: Vista) {
  actual = v
  guardarVista(v) // presentacion, no permisos
  oyentes.forEach((fn) => fn())
}

export function SelectorVista({ inicial }: { inicial: Vista }) {
  const vista = useSyncExternalStore(suscribir, () => actual, () => null) ?? inicial


  return (
    <div className="tema vs-sel" role="radiogroup" aria-label="Vista de saldos" data-vista={vista} data-testid="vista-saldos">
      {OPCIONES.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={vista === o.v}
          className={vista === o.v ? 'on' : ''}
          title={o.t}
          onClick={() => fijar(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}
