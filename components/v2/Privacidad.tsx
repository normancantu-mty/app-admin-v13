'use client'

/**
 * Front v2 — el ojito del encabezado. Escrito el 2026-10-30 por el Socio.
 *
 * Mismo modo privado que la v1 (`components/ui/PrivacidadToggle.tsx`): solo
 * prende `data-privado` en el `<html>`; el motor `EnmascararCifras` ya esta
 * montado en `app/layout.tsx` y tapa el dinero de cualquier pantalla. Esto es
 * PRESENTACION, no permisos (ver `lib/privacidad.ts`).
 */

import { useSyncExternalStore } from 'react'
import { ATRIBUTO, guardarEstado, leerEstadoGuardado } from '@/lib/privacidad'

const oyentes = new Set<() => void>()
function suscribir(fn: () => void) {
  oyentes.add(fn)
  return () => oyentes.delete(fn)
}

function leer(): boolean {
  const attr = document.documentElement.getAttribute(ATRIBUTO)
  if (attr === null) {
    // Primera lectura: el estado guardado manda y se refleja en el <html>.
    const guardado = leerEstadoGuardado()
    document.documentElement.setAttribute(ATRIBUTO, guardado ? '1' : '0')
    return guardado
  }
  return attr === '1'
}

export function PrivacidadV2() {
  // false en el servidor y en la hidratacion; el estado real solo existe en el navegador.
  const privado = useSyncExternalStore(suscribir, leer, () => false)

  const alternar = () => {
    const nuevo = !privado
    guardarEstado(nuevo)
    document.documentElement.setAttribute(ATRIBUTO, nuevo ? '1' : '0')
    oyentes.forEach((fn) => fn())
  }

  return (
    <button
      type="button"
      className={`ojito${privado ? ' on' : ''}`}
      onClick={alternar}
      aria-pressed={privado}
      data-testid="ojito-privacidad"
      aria-label={privado ? 'Mostrar las cifras' : 'Ocultar las cifras'}
      title={privado ? 'Cifras ocultas. Clic para mostrarlas.' : 'Ocultar las cifras (para enseñar la pantalla)'}
    >
      {privado ? '🙈' : '👁️'}
      <span>{privado ? 'Cifras ocultas' : 'Ocultar cifras'}</span>
    </button>
  )
}
