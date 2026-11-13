'use server'

/**
 * "Agregar usuario" desde la pantalla de login. Escrito el 2026-10-30 por el
 * ejecutor del Socio.
 *
 * ─── EL PERMISO ─────────────────────────────────────────────────────────────
 * Quien agrega no tiene sesion en el navegador: escribe correo y contrasena de
 * un ADMIN. Se comprueban AQUI, en el servidor, con un cliente de Supabase
 * efimero (`persistSession: false`, sin cookies): el navegador nunca recibe la
 * sesion del ADMIN. El rol se lee de `entidades` por `auth_id` (igual que
 * `getCurrentUser`, sin el respaldo por correo: el RLS ya no lo reconoce).
 *
 * La accion de GUARDAR vuelve a comprobar la credencial completa: no confia en
 * que el paso 1 haya pasado. El cliente solo guarda en memoria lo que tecleo.
 *
 * ─── QUIEN ESCRIBE QUE ──────────────────────────────────────────────────────
 * - El usuario de Auth: `service_role` (`auth.admin.createUser`), lo unico que
 *   exige esa llave. La llave vive solo en este archivo de servidor.
 * - La entidad y su cuenta: `crear_entidad_atomica`, llamada CON LA SESION DEL
 *   ADMIN (cliente efimero autenticado), no con service_role. Asi el RLS
 *   (`entidades_ins_admin`) vuelve a exigir ADMIN en la base: el permiso queda
 *   comprobado en TypeScript y en Postgres.
 * - DST: por `crearEntidad` (lib/entidad-servidor.ts), el mismo camino de la
 *   pantalla de distribuidores y del bot (D16).
 * - SOCIO y LOC: la misma RPC con el mismo payload que arma `crearEntidad`,
 *   porque `crearEntidad` solo le crea acceso al DST y rechaza SOCIO.
 * - Si la RPC falla, se borra el usuario de Auth recien creado (mismo orden que
 *   `crearEntidad`: un Auth huerfano se borra; una entidad sin cuenta, no).
 * - EMPLEADO_ADMIN (2026-11-13): NO es entidad. Usuario de Auth + una fila en
 *   `accesos` (rol EMPLEADO_ADMIN, id_entidad = la matriz, permiso_finanzas),
 *   ambas con service_role (`accesos` no tiene politica de escritura). Si la
 *   fila falla, se borra el usuario de Auth.
 * - Quien agrega: ADMIN segun `accesos` primero y luego `entidades`, el mismo
 *   orden que `mi_rol()` en la base.
 *
 * Los errores se DEVUELVEN, no se lanzan: en produccion Next oculta el mensaje
 * de un error lanzado desde una server action.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { comisionValidada, esZonaValida, type PayloadAlta } from '@/lib/bot-entidad'
import { crearEntidad, type PuertaDeAuth } from '@/lib/entidad-servidor'
import {
  LARGO_MINIMO_PASSWORD_USUARIO,
  etiquetaDesdeNombre,
  rolDisponibleParaAlta,
  type DatosNuevoUsuario
} from '@/lib/usuarios-roles'

type Cliente = SupabaseClient<Database>

const SOLO_ADMIN = 'Solo un administrador puede agregar usuarios.'
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ResultadoValidacion =
  | { ok: true; distribuidores: { id: string; nombre: string }[] }
  | { ok: false; error: string }

export type ResultadoAlta =
  | { ok: true; nombre: string; email: string; rol: string }
  | { ok: false; error: string }

function mensaje(e: unknown, respaldo: string): string {
  return e instanceof Error && e.message ? e.message : respaldo
}

function clienteEfimero(): Cliente {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw new Error('Configuración de Supabase incompleta.')
  return createClient<Database>(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
}

function clienteServicio(): Cliente {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const llave = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !llave) throw new Error('Configuración de Supabase Admin incompleta.')
  return createClient<Database>(url, llave, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
}

interface AdminComprobado {
  cliente: Cliente
  idEntidad: string
}

/**
 * Credencial correcta Y entidad ligada con rol ADMIN. Cualquier otro caso da
 * el mismo mensaje: no se le dice a quien prueba si fallo el correo, la
 * contrasena o el rol.
 */
async function comprobarAdmin(email: string, password: string): Promise<AdminComprobado | null> {
  const correo = String(email ?? '').trim().toLowerCase()
  const clave = String(password ?? '')
  if (!correo || !clave) return null

  const cliente = clienteEfimero()
  const { data, error } = await cliente.auth.signInWithPassword({ email: correo, password: clave })
  if (error || !data.user) return null

  // `accesos` primero, como `mi_rol()`: un login de `accesos` con rol ADMIN es ADMIN
  // para la base, y un EMPLEADO_ADMIN no lo es.
  const { data: acceso, error: errAcceso } = await cliente
    .from('accesos')
    .select('id_entidad, rol')
    .eq('auth_id', data.user.id)
    .eq('activo', true)
    .maybeSingle()
  if (errAcceso) {
    await soltar(cliente)
    return null
  }
  if (acceso) {
    if (acceso.rol !== 'ADMIN') {
      await soltar(cliente)
      return null
    }
    return { cliente, idEntidad: acceso.id_entidad }
  }

  const { data: entidad, error: errEntidad } = await cliente
    .from('entidades')
    .select('id, rol')
    .eq('auth_id', data.user.id)
    .maybeSingle()

  if (errEntidad || !entidad || entidad.rol !== 'ADMIN') {
    await soltar(cliente)
    return null
  }
  return { cliente, idEntidad: entidad.id }
}

/** Cierra la sesion efimera del ADMIN. `local`: solo esta, no las de sus otros dispositivos. */
async function soltar(cliente: Cliente): Promise<void> {
  try {
    await cliente.auth.signOut({ scope: 'local' })
  } catch {
    // La sesion efimera muere con el proceso de todos modos.
  }
}

function puertaDeAuth(servicio: Cliente): PuertaDeAuth {
  return {
    crear: async (correo: string, clave: string) => {
      const { data, error } = await servicio.auth.admin.createUser({
        email: correo,
        password: clave,
        email_confirm: true
      })
      if (error) {
        const msg = error.message?.toLowerCase() ?? ''
        const status = (error as { status?: number }).status
        if (msg.includes('already been registered') || msg.includes('already exists') || status === 422 || status === 409) {
          throw new Error('Ese correo ya tiene acceso al sistema. Usa otro correo.')
        }
        if (msg.includes('password')) {
          throw new Error('La contraseña no cumple las reglas de acceso: ' + error.message)
        }
        throw new Error('No se pudo crear el acceso: ' + (error.message || 'error desconocido'))
      }
      if (!data.user?.id) throw new Error('No se pudo crear el acceso.')
      return data.user.id
    },
    borrar: async (authId: string) => {
      const { error } = await servicio.auth.admin.deleteUser(authId)
      if (error) throw new Error(error.message)
    }
  }
}

/** Paso 1: ¿es un ADMIN? Si si, devuelve los distribuidores (para colgar un LOC). */
export async function validarAdminParaAltaAction(email: string, password: string): Promise<ResultadoValidacion> {
  let admin: AdminComprobado | null = null
  try {
    admin = await comprobarAdmin(email, password)
    if (!admin) return { ok: false, error: SOLO_ADMIN }

    const { data, error } = await admin.cliente
      .from('entidades')
      .select('id, nombre')
      .eq('rol', 'DST')
      .order('nombre', { ascending: true })
    if (error) return { ok: false, error: 'No pude leer los distribuidores: ' + error.message }

    return { ok: true, distribuidores: (data ?? []).map((d) => ({ id: d.id, nombre: d.nombre })) }
  } catch (e) {
    return { ok: false, error: mensaje(e, SOLO_ADMIN) }
  } finally {
    if (admin) await soltar(admin.cliente)
  }
}

/** Una comision escrita por una persona: obligatoria (nada de 0 en silencio) y con el criterio del bot. */
function comisionObligatoria(crudo: string | undefined, etiqueta: string): number {
  const texto = String(crudo ?? '').trim().replace('%', '')
  if (!texto) throw new Error(etiqueta + ': escribe el porcentaje (0 si no lleva).')
  const n = Number(texto)
  if (!Number.isFinite(n)) throw new Error(etiqueta + ': no lo leí como un porcentaje.')
  return comisionValidada(n, etiqueta)
}

/** Paso 2: guardar. Re-valida la credencial del ADMIN en esta misma llamada. */
export async function agregarUsuarioAction(
  adminEmail: string,
  adminPassword: string,
  datos: DatosNuevoUsuario
): Promise<ResultadoAlta> {
  let admin: AdminComprobado | null = null
  try {
    admin = await comprobarAdmin(adminEmail, adminPassword)
    if (!admin) return { ok: false, error: SOLO_ADMIN }

    // ── Validacion de lo que llega del formulario ────────────────────────────
    const nombre = String(datos?.nombre ?? '').trim().replace(/\s+/g, ' ')
    const email = String(datos?.email ?? '').trim().toLowerCase()
    const password = String(datos?.password ?? '')
    const rol = datos?.rol
    const zona = datos?.zona

    if (nombre.length < 2) return { ok: false, error: 'Escribe el nombre.' }
    if (nombre.length > 200) return { ok: false, error: 'El nombre es demasiado largo.' }
    // La cuenta nace como "Efectivo (<nombre>)" y la maquina de impuestos decide
    // FULL_TAX por la subcadena "fresnillo" en el nombre de la cuenta
    // (CLAUDE.md, regla 2). Un usuario llamado asi volveria fiscal su cuenta.
    if (nombre.toLowerCase().includes('fresnillo')) {
      return { ok: false, error: 'El nombre no puede contener "Fresnillo": volvería fiscal su cuenta de efectivo.' }
    }
    if (!CORREO.test(email)) return { ok: false, error: 'El correo no es válido.' }
    if (password.length < LARGO_MINIMO_PASSWORD_USUARIO) {
      return { ok: false, error: `La contraseña necesita al menos ${LARGO_MINIMO_PASSWORD_USUARIO} caracteres.` }
    }
    if (!rolDisponibleParaAlta(rol)) return { ok: false, error: 'Ese nivel no se puede crear desde aquí.' }

    const cliente = admin.cliente

    // `entidades.email` es UNIQUE: mejor decirlo antes de crear el acceso.
    const { data: yaExiste, error: errExiste } = await cliente
      .from('entidades')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    if (errExiste) return { ok: false, error: 'No pude comprobar el correo: ' + errExiste.message }
    if (yaExiste) return { ok: false, error: 'Ese correo ya pertenece a otra entidad del sistema.' }

    const servicio = clienteServicio()
    const puerta = puertaDeAuth(servicio)
    const actor = { idEntidad: admin.idEntidad, rol: 'ADMIN' }

    // ── EMPLEADO_ADMIN: Auth + fila en `accesos`, sin entidad ni cuenta ──────
    if (rol === 'EMPLEADO_ADMIN') {
      // La matriz: la primera entidad con rol ADMIN (el mismo criterio que el resto del repo).
      const { data: matriz, error: errMatriz } = await cliente
        .from('entidades')
        .select('id')
        .eq('rol', 'ADMIN')
        .limit(1)
        .maybeSingle()
      if (errMatriz || !matriz) return { ok: false, error: 'No encontré la matriz: ' + (errMatriz?.message ?? 'sin entidad ADMIN') }
      const { data: etiquetas, error: errEtiquetas } = await servicio.from('accesos').select('etiqueta')
      if (errEtiquetas) return { ok: false, error: 'No pude leer los accesos: ' + errEtiquetas.message }
      const etiqueta = etiquetaDesdeNombre(nombre, new Set((etiquetas ?? []).map((f) => f.etiqueta)))

      const authIdEmpleado = await puerta.crear(email, password)
      const { error: errAcceso } = await servicio.from('accesos').insert({
        nombre,
        etiqueta,
        rol: 'EMPLEADO_ADMIN',
        id_entidad: matriz.id,
        auth_id: authIdEmpleado,
        permiso_finanzas: datos.permisoFinanzas === true
      })
      if (errAcceso) {
        // Sin medio alta: el usuario de Auth sin fila en `accesos` se borra.
        try {
          await puerta.borrar(authIdEmpleado)
        } catch (errBorrado) {
          console.error('[usuarios] no pude borrar el usuario de Auth huerfano', authIdEmpleado, errBorrado)
          return {
            ok: false,
            error: `No se pudo guardar el acceso: ${errAcceso.message}. Además quedó un acceso huérfano (${email}) que hay que borrar a mano.`
          }
        }
        return { ok: false, error: 'No se pudo guardar el acceso: ' + errAcceso.message }
      }
      return { ok: true, nombre, email, rol }
    }

    // La zona va despues del empleado administrativo: el no es entidad y no lleva zona.
    if (!esZonaValida(zona)) return { ok: false, error: 'Zona inválida.' }

    // ── DST: el camino unico de alta (D16) ───────────────────────────────────
    if (rol === 'DST') {
      const fila: PayloadAlta = {
        nombre,
        rol: 'DST',
        zona,
        email,
        telefono: null,
        id_nodo_padre: null,
        comision_base: comisionObligatoria(datos.comisionBase, 'Comisión cuando vende él'),
        comision_base_local: 0,
        comision_hijo_local: comisionObligatoria(datos.comisionHijoLocal, 'Comisión cuando vende su local')
      }
      const creada = await crearEntidad(cliente, actor, fila, password, puerta)
      return { ok: true, nombre: creada.nombre, email, rol }
    }

    // ── SOCIO y LOC: misma RPC, mismo payload que `crearEntidad` ─────────────
    let idPadre: string | null = null
    let comisionBaseLocal = 0
    if (rol === 'LOC') {
      idPadre = String(datos.idPadre ?? '').trim()
      if (!UUID.test(idPadre)) return { ok: false, error: 'Elige el distribuidor del que cuelga el local.' }
      const { data: padre, error: errPadre } = await cliente
        .from('entidades')
        .select('id, rol')
        .eq('id', idPadre)
        .maybeSingle()
      if (errPadre) return { ok: false, error: 'No pude leer el distribuidor: ' + errPadre.message }
      if (!padre || padre.rol !== 'DST') return { ok: false, error: 'El local tiene que colgar de un distribuidor.' }
      comisionBaseLocal = comisionObligatoria(datos.comisionBaseLocal, 'Comisión del local')
    }

    const authId = await puerta.crear(email, password)
    try {
      const { data: id, error } = await cliente.rpc('crear_entidad_atomica', {
        p_entidad: {
          nombre,
          rol,
          zona,
          email,
          auth_id: authId,
          telefono: null,
          ubicacion_maps: null,
          es_distribuidor: false,
          // Puente legacy: las dos columnas del padre se leen, asi que se escriben las dos.
          id_nodo_padre: idPadre,
          id_padre: idPadre,
          comision_base: 0,
          comision_base_local: comisionBaseLocal,
          comision_hijo_local: 0,
          comision_logistica: 0,
          aplica_redondeo_costo: true
        },
        p_cuenta: { nombre: `Efectivo (${nombre})`, tipo_fiscalidad: 'LIBRE' }
      })
      if (error) throw new Error(error.message)
      if (!id) throw new Error('El alta no devolvió id.')
    } catch (e) {
      try {
        await puerta.borrar(authId)
      } catch (errBorrado) {
        console.error('[usuarios] no pude borrar el usuario de Auth huerfano', authId, errBorrado)
        return {
          ok: false,
          error: `${mensaje(e, 'Falló el alta')}. Además quedó un acceso huérfano (${email}) que hay que borrar a mano.`
        }
      }
      throw e
    }

    return { ok: true, nombre, email, rol }
  } catch (e) {
    return { ok: false, error: mensaje(e, 'No se pudo agregar el usuario.') }
  } finally {
    if (admin) await soltar(admin.cliente)
  }
}
