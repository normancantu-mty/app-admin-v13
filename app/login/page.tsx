'use client'

import { RUTA_BASE } from '@/lib/v2/rutas'
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import AgregarUsuario from './AgregarUsuario'

// `?cambiar=1` lo pone el menu de sesion de /panel ("Cambiar de usuario"): correo
// vacio y enfocado, y sin rebote automatico a /panel. Se lee de `location` y no con
// useSearchParams para no exigir un <Suspense> alrededor de toda la pagina.
const sinSuscripcion = () => () => {}
const leerCambiar = () => new URLSearchParams(window.location.search).get('cambiar') === '1'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [agregando, setAgregando] = useState(false)
  const cambiar = useSyncExternalStore(sinSuscripcion, leerCambiar, () => false)
  const campoCorreo = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (cambiar) campoCorreo.current?.focus()
  }, [cambiar])

  useEffect(() => {
    if (cambiar) return
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session && session.user.email) {
        const { data: entidad } = await supabase
          .from('entidades')
          .select('id, rol')
          .eq('email', session.user.email)
          .single()
        
        if (entidad) {
          // Todos los roles entran al panel unico (A1, 2026-10-30): /panel decide que ve cada uno.
          router.push(RUTA_BASE)
        }
      }
    }
    checkSession()
  }, [router, cambiar])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email,
        password: password,
      })

      if (error) throw error

      if (data.user && data.user.email) {
        const { data: entidad } = await supabase
          .from('entidades')
          .select('id, rol')
          .eq('email', data.user.email)
          .single()
        
        if (entidad) {
          // Todos los roles entran al panel unico (A1, 2026-10-30): /panel decide que ve cada uno.
          router.push(RUTA_BASE)
        } else {
          throw new Error('Usuario no encontrado en el sistema')
        }
      }
    } catch (error: unknown) {
      setError((error instanceof Error && error.message) || 'Error al iniciar sesión')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Destilado Digital</h1>
          <p className="text-gray-600">Acceso Operativo</p>
        </div>

        {agregando ? (
          <AgregarUsuario onCerrar={() => setAgregando(false)} />
        ) : (
        <>
        {cambiar ? (
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4 text-center" data-testid="login-cambiar">
            Sesión cerrada. Entra con otro usuario.
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
              Correo Electrónico
            </label>
            <input
              ref={campoCorreo}
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="usuario@destilado.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
          >
            {isLoading ? 'Iniciando sesión...' : 'Iniciar Sesión'}
          </button>
        </form>
        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
          <button
            type="button"
            onClick={() => {
              setError('')
              setAgregando(true)
            }}
            className="text-sm font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
            data-testid="login-agregar-usuario"
          >
            Agregar usuario
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  )
}
