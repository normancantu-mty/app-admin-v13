/**
 * Alta de usuarios desde el login — el catalogo de roles que se ofrece.
 * Escrito el 2026-10-30 por el ejecutor del Socio (sesion + "Agregar usuario").
 *
 * PURO y sin secretos: lo importa el cliente (`app/login/AgregarUsuario.tsx`)
 * para pintar las opciones y el servidor (`app/actions/usuarios.ts`) para
 * validar. La autorizacion de verdad la decide la server action, no esta lista.
 *
 * Los roles salen del `CHECK` de la base, no de la imaginacion:
 *   `entidades_rol_check`: ADMIN, DST, LOC, SOCIO
 *   (supabase/migrations/20260101000000_v2_local_esquema_base_previo.sql:54).
 * `SUB-ADMIN` aparece en tipos de TypeScript pero la base lo rechaza: no se ofrece.
 * `EMPLEADO_ADMIN` (2026-11-13) NO es una entidad: es una fila en `accesos`
 * (`accesos_rol_check`) que opera como la matriz.
 *
 * Cada descripcion esta sacada del codigo que decide el permiso (la fuente va al
 * lado). Si cambia el permiso, cambia la descripcion.
 */

export type RolDeUsuario = 'SOCIO' | 'DST' | 'LOC' | 'EMPLEADO_ADMIN' | 'ADMIN'

export interface OpcionDeRol {
  rol: RolDeUsuario
  nombre: string
  descripcion: string
  /** false = se muestra para que se entienda que existe, pero no se puede crear aqui. */
  disponible: boolean
  motivo?: string
}

export const ROLES_DE_USUARIO: readonly OpcionDeRol[] = [
  {
    rol: 'SOCIO',
    nombre: 'Socio',
    // lib/v2/roles.ts: ROLES_DE_MANDO_V2 = ADMIN, SOCIO; puedeCapturarMatriz: "SOCIO es de solo lectura".
    descripcion: 'Ve el tablero de la matriz y su dinero en solo lectura; no captura ni opera nada.',
    disponible: true
  },
  {
    rol: 'DST',
    nombre: 'Distribuidor',
    // lib/v2/roles.ts: puedeVender (ADMIN y DST), puedeOperarNodo ("el DST, solo en su red");
    // app/panel/@modal/m/nodo/[id]/{abono,cobranza,conteo,devolucion}: "solo deja a ADMIN y DST".
    descripcion: 'Vende por el POS y opera los nodos de su red: abonos, cobranza, conteos y devoluciones.',
    disponible: true
  },
  {
    rol: 'LOC',
    nombre: 'Local',
    // lib/v2/roles.ts puedeVender: "El LOC no: la RLS de transacciones_tickets solo tiene INSERT
    // para ADMIN y DST"; components/v2/nodo/FichaVista.tsx: "el LOC no opera".
    descripcion: 'Entra a su panel de nodo y lo consulta; no vende por el POS ni registra abonos, cobranza o conteos.',
    disponible: true
  },
  {
    rol: 'EMPLEADO_ADMIN',
    nombre: 'Empleado administrativo',
    // lib/v2/roles.ts: puedeCapturarMatriz (lotes, envasado, compra, inventario) y puedeVerFinanzas
    // (solo con accesos.permiso_finanzas). Plan DESDE_CUARTEL_rol_empleado_admin_2026-11-13.md.
    descripcion:
      'Opera la matriz: lotes, envasado, compra de insumos e inventario (en la app, como ADMIN). ' +
      'Finanzas solo si se le da el permiso; no da de alta usuarios ni toca catálogo, precios ni aprobaciones.',
    disponible: true
  },
  {
    rol: 'ADMIN',
    nombre: 'Administrador (matriz)',
    // lib/v2/roles.ts puedeCapturarMatriz: gasto, compra, envasado, anular, aprobar.
    descripcion: 'Captura de la matriz: gastos, compras, envasado, anulaciones y aprobaciones.',
    disponible: false,
    motivo:
      'La matriz es una sola entidad: el sistema la busca por rol ADMIN y toma la primera que encuentra ' +
      '(produccion, cuentas de la matriz). Un segundo administrador necesita un cambio de esquema antes.'
  }
]

export function rolDisponibleParaAlta(rol: unknown): rol is Exclude<RolDeUsuario, 'ADMIN'> {
  return ROLES_DE_USUARIO.some((o) => o.rol === rol && o.disponible)
}

/** Lo que el formulario manda al servidor. Comisiones como el usuario las escribe (20 = 20%). */
export interface DatosNuevoUsuario {
  nombre: string
  email: string
  password: string
  rol: RolDeUsuario
  zona: string
  /** Solo LOC: el distribuidor del que cuelga. */
  idPadre?: string | null
  /** Solo DST. */
  comisionBase?: string
  /** Solo DST. */
  comisionHijoLocal?: string
  /** Solo LOC. */
  comisionBaseLocal?: string
  /** Solo EMPLEADO_ADMIN: `accesos.permiso_finanzas`. */
  permisoFinanzas?: boolean
}

/**
 * `accesos.etiqueta` a partir del nombre: minusculas sin acentos, lo demas a
 * `_`, valida contra el CHECK `^[a-z0-9_-]{2,24}$` y fuera de `ocupadas`
 * (agrega `-2`, `-3`, ... recortando la base para no pasar de 24).
 */
export function etiquetaDesdeNombre(nombre: string, ocupadas: ReadonlySet<string>): string {
  let base = String(nombre ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/, '')
  if (base.length < 2) base = `emp${base}`.slice(0, 24)
  if (!ocupadas.has(base)) return base
  for (let n = 2; ; n++) {
    const sufijo = `-${n}`
    const candidata = base.slice(0, 24 - sufijo.length) + sufijo
    if (!ocupadas.has(candidata)) return candidata
  }
}

export const LARGO_MINIMO_PASSWORD_USUARIO = 8
