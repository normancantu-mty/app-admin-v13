'use client'

import { useEffect, useState } from 'react'
import { ATRIBUTO, guardarEstado, leerEstadoGuardado } from '@/lib/privacidad'

/**
 * El ojito. Un clic tapa todas las cifras de la pantalla, otro las devuelve.
 *
 * Para enseñar el ERP sin enseñar los numeros de la empresa. **Es
 * presentacion, no permisos** — los datos siguen llegando al navegador; quien
 * abra las DevTools los ve. Para esconderle datos a un usuario estan el RLS y
 * los roles.
 *
 * El estado vive en un atributo del `<html>` y no en un contexto de React
 * porque asi lo pueden leer el CSS (para los `<input>`, que no son nodos de
 * texto) y `EnmascararCifras` sin que ninguno de los tres se conozca.
 */
export function PrivacidadToggle() {
  const [montado, setMontado] = useState(false)
  const [privado, setPrivado] = useState(false)

  useEffect(() => {
    const guardado = leerEstadoGuardado()
    setPrivado(guardado)
    document.documentElement.setAttribute(ATRIBUTO, guardado ? '1' : '0')
    setMontado(true)
  }, [])

  // Mismo hueco que ThemeToggle: sin el, el servidor pinta un estado y el
  // cliente otro, y la hidratacion se queja.
  if (!montado) {
    return (
      <button
        type="button"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700"
        aria-label="Cargar el modo privado"
        disabled
      />
    )
  }

  const alternar = () => {
    const nuevo = !privado
    setPrivado(nuevo)
    guardarEstado(nuevo)
    document.documentElement.setAttribute(ATRIBUTO, nuevo ? '1' : '0')
  }

  return (
    <button
      type="button"
      onClick={alternar}
      aria-pressed={privado}
      data-testid="ojito-privacidad"
      className={
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border text-lg transition-colors ' +
        (privado
          ? 'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900'
          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700')
      }
      aria-label={privado ? 'Mostrar las cifras' : 'Ocultar las cifras'}
      title={
        privado
          ? 'Cifras ocultas. Clic para mostrarlas.'
          : 'Ocultar las cifras (para enseñar la pantalla)'
      }
    >
      {privado ? '🙈' : '👁️'}
    </button>
  )
}
