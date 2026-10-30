'use client'

/**
 * "Agregar usuario" en el login. Escrito el 2026-10-30 por el ejecutor del Socio.
 *
 * Dos pasos: (1) correo y contrasena de un ADMIN, comprobados en el servidor;
 * (2) los datos del nuevo usuario. La credencial del ADMIN se queda en memoria
 * de este componente solo para mandarla otra vez al guardar: el servidor la
 * vuelve a comprobar y no confia en que el paso 1 haya pasado. Al terminar o
 * cancelar se borra.
 */

import { useState, type FormEvent } from 'react'
import { agregarUsuarioAction, validarAdminParaAltaAction } from '@/app/actions/usuarios'
import { LARGO_MINIMO_PASSWORD_USUARIO, ROLES_DE_USUARIO, type RolDeUsuario } from '@/lib/usuarios-roles'

const CAMPO =
  'w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-900 dark:border-gray-600'
const ETIQUETA = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'

type Paso = 'admin' | 'datos' | 'hecho'

export default function AgregarUsuario({ onCerrar }: { onCerrar: () => void }) {
  const [paso, setPaso] = useState<Paso>('admin')
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState('')

  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [distribuidores, setDistribuidores] = useState<{ id: string; nombre: string }[]>([])

  const [nombre, setNombre] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rol, setRol] = useState<RolDeUsuario>('SOCIO')
  const [zona, setZona] = useState('Zacatecas')
  const [idPadre, setIdPadre] = useState('')
  const [comisionBase, setComisionBase] = useState('')
  const [comisionHijoLocal, setComisionHijoLocal] = useState('')
  const [comisionBaseLocal, setComisionBaseLocal] = useState('')
  const [creado, setCreado] = useState<{ nombre: string; email: string; rol: string } | null>(null)

  const cerrar = () => {
    setAdminPassword('')
    setPassword('')
    onCerrar()
  }

  const validarAdmin = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setCargando(true)
    try {
      const r = await validarAdminParaAltaAction(adminEmail, adminPassword)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setDistribuidores(r.distribuidores)
      setPaso('datos')
    } catch {
      setError('No se pudo comprobar. Intenta otra vez.')
    } finally {
      setCargando(false)
    }
  }

  const guardar = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setCargando(true)
    try {
      const r = await agregarUsuarioAction(adminEmail, adminPassword, {
        nombre,
        email,
        password,
        rol,
        zona,
        idPadre: rol === 'LOC' ? idPadre : null,
        comisionBase: rol === 'DST' ? comisionBase : undefined,
        comisionHijoLocal: rol === 'DST' ? comisionHijoLocal : undefined,
        comisionBaseLocal: rol === 'LOC' ? comisionBaseLocal : undefined
      })
      if (!r.ok) {
        setError(r.error)
        return
      }
      setCreado({ nombre: r.nombre, email: r.email, rol: r.rol })
      setAdminPassword('')
      setPassword('')
      setPaso('hecho')
    } catch {
      setError('No se pudo guardar. Intenta otra vez.')
    } finally {
      setCargando(false)
    }
  }

  const aviso = error ? (
    <div className="bg-red-50 border border-red-200 rounded-md p-3" role="alert">
      <p className="text-sm text-red-600">{error}</p>
    </div>
  ) : null

  if (paso === 'hecho' && creado) {
    return (
      <div className="space-y-4" data-testid="alta-usuario-hecha">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Usuario agregado</h2>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          <b>{creado.nombre}</b> ({creado.rol}) ya puede entrar con <b>{creado.email}</b> y la contraseña que le
          pusiste.
        </p>
        <button type="button" onClick={cerrar} className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 font-medium">
          Volver a iniciar sesión
        </button>
      </div>
    )
  }

  if (paso === 'admin') {
    return (
      <form onSubmit={validarAdmin} className="space-y-4" data-testid="alta-usuario-admin">
        <div>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Agregar usuario</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">Primero, la autorización de un administrador.</p>
        </div>
        <div>
          <label htmlFor="admin-email" className={ETIQUETA}>Correo del administrador</label>
          <input id="admin-email" type="email" autoComplete="off" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required className={CAMPO} />
        </div>
        <div>
          <label htmlFor="admin-password" className={ETIQUETA}>Contraseña del administrador</label>
          <input id="admin-password" type="password" autoComplete="off" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} required className={CAMPO} />
        </div>
        {aviso}
        <div className="flex gap-3">
          <button type="button" onClick={cerrar} className="flex-1 border border-gray-300 dark:border-gray-600 py-2 px-4 rounded-md font-medium">
            Cancelar
          </button>
          <button type="submit" disabled={cargando} className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium">
            {cargando ? 'Comprobando…' : 'Continuar'}
          </button>
        </div>
      </form>
    )
  }

  const opcion = ROLES_DE_USUARIO.find((o) => o.rol === rol)

  return (
    <form onSubmit={guardar} className="space-y-4" data-testid="alta-usuario-datos">
      <div>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Nuevo usuario</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">Autorizado por {adminEmail.trim().toLowerCase()}.</p>
      </div>
      <div>
        <label htmlFor="nu-nombre" className={ETIQUETA}>Nombre</label>
        <input id="nu-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required className={CAMPO} />
      </div>
      <div>
        <label htmlFor="nu-email" className={ETIQUETA}>Correo</label>
        <input id="nu-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required className={CAMPO} />
      </div>
      <div>
        <label htmlFor="nu-password" className={ETIQUETA}>Contraseña (mínimo {LARGO_MINIMO_PASSWORD_USUARIO})</label>
        <input id="nu-password" type="password" autoComplete="new-password" minLength={LARGO_MINIMO_PASSWORD_USUARIO} value={password} onChange={(e) => setPassword(e.target.value)} required className={CAMPO} />
      </div>

      <fieldset>
        <legend className={ETIQUETA}>Nivel</legend>
        <div className="space-y-2">
          {ROLES_DE_USUARIO.map((o) => (
            <label
              key={o.rol}
              className={`flex gap-3 items-start p-2 rounded-md border ${rol === o.rol ? 'border-blue-500' : 'border-gray-200 dark:border-gray-700'} ${o.disponible ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
            >
              <input type="radio" name="nu-rol" value={o.rol} checked={rol === o.rol} disabled={!o.disponible} onChange={() => setRol(o.rol)} className="mt-1" />
              <span>
                <span className="block text-sm font-semibold text-gray-800 dark:text-gray-100">
                  {o.nombre} <span className="font-mono text-xs text-gray-500">{o.rol}</span>
                </span>
                <span className="block text-xs text-gray-600 dark:text-gray-400">{o.descripcion}</span>
                {!o.disponible && o.motivo ? <span className="block text-xs text-amber-700 dark:text-amber-400 mt-1">No disponible aquí: {o.motivo}</span> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="nu-zona" className={ETIQUETA}>Zona</label>
        <select id="nu-zona" value={zona} onChange={(e) => setZona(e.target.value)} className={CAMPO}>
          <option value="Zacatecas">Zacatecas</option>
          <option value="Foraneo">Foráneo</option>
        </select>
      </div>

      {rol === 'DST' ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="nu-cb" className={ETIQUETA}>Comisión cuando vende él (%)</label>
            <input id="nu-cb" inputMode="decimal" value={comisionBase} onChange={(e) => setComisionBase(e.target.value)} required className={CAMPO} placeholder="20" />
          </div>
          <div>
            <label htmlFor="nu-chl" className={ETIQUETA}>Cuando vende su local (%)</label>
            <input id="nu-chl" inputMode="decimal" value={comisionHijoLocal} onChange={(e) => setComisionHijoLocal(e.target.value)} required className={CAMPO} placeholder="5" />
          </div>
        </div>
      ) : null}

      {rol === 'LOC' ? (
        <>
          <div>
            <label htmlFor="nu-padre" className={ETIQUETA}>Distribuidor del que cuelga</label>
            <select id="nu-padre" value={idPadre} onChange={(e) => setIdPadre(e.target.value)} required className={CAMPO}>
              <option value="">Elige…</option>
              {distribuidores.map((d) => (
                <option key={d.id} value={d.id}>{d.nombre}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="nu-cbl" className={ETIQUETA}>Comisión del local (%)</label>
            <input id="nu-cbl" inputMode="decimal" value={comisionBaseLocal} onChange={(e) => setComisionBaseLocal(e.target.value)} required className={CAMPO} placeholder="10" />
          </div>
        </>
      ) : null}

      {opcion?.rol === 'SOCIO' ? null : (
        <p className="text-xs text-gray-500 dark:text-gray-400">Comisión en porciento: 20 = 20%. &quot;1&quot; es ambiguo: escribe 0.01 o 100.</p>
      )}

      {aviso}
      <div className="flex gap-3">
        <button type="button" onClick={cerrar} className="flex-1 border border-gray-300 dark:border-gray-600 py-2 px-4 rounded-md font-medium">
          Cancelar
        </button>
        <button type="submit" disabled={cargando} className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium">
          {cargando ? 'Guardando…' : 'Agregar usuario'}
        </button>
      </div>
    </form>
  )
}
