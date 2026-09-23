/**
 * FASE 9 (D95) — NORMAN LE DICE AL BOT QUIEN ES QUIEN, EN EL GRUPO.
 *
 * Norman responde al mensaje de alguien con "este es Gilberto" (o `/registrar
 * Gilberto`) y el bot propone el alta en `bot_identidades` con VA. **Solo
 * Norman registra** (`permisoDeAccion(..., 'registrar')`): nadie se auto-asigna
 * una entidad, que era la ventaja de seguridad del alta manual (Q-14).
 *
 * Reglas del alta (decididas, y dichas en el informe):
 *   · A una entidad ADMIN (la Matriz) solo se da de alta **con**
 *     `requiere_aprobacion` (es el caso de Kevin). Un segundo aprobador no se
 *     crea desde el chat: lo mas cerrado.
 *   · La cuenta (`id_cuenta_destino` es NOT NULL): la primera cuenta usable de
 *     la entidad; para la Matriz, la del aprobador. Sin cuenta, no hay alta.
 *   · La etiqueta sale del nombre dicho (minusculas, sin acentos, `_`), unica.
 *
 * Todo aqui es PURO (`tests/bot-fase9-permisos.spec.ts`).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'

export interface PayloadAltaMiembro {
  telegram_id: number
  etiqueta: string
  id_entidad: string
  id_cuenta_destino: string
  requiere_aprobacion: boolean
  creado_por: string
}

export const LLAVES_MIEMBRO = [
  'creado_por',
  'etiqueta',
  'id_cuenta_destino',
  'id_entidad',
  'requiere_aprobacion',
  'telegram_id'
] as const

export function sellarMiembro(p: PayloadAltaMiembro): string {
  return sellar(p, LLAVES_MIEMBRO)
}

export function selloMiembroCoincide(p: PayloadAltaMiembro, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_MIEMBRO, sello)
}

/** "José Luis" -> "jose_luis"; unica contra `tomadas`; cumple `^[a-z0-9_-]{2,24}$`. */
export function etiquetaDeNombre(nombre: unknown, tomadas: ReadonlySet<string>): string | null {
  const base = String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
  if (base.length < 2) return null
  if (!tomadas.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const otra = `${base}${i}`
    if (!tomadas.has(otra)) return otra
  }
  return null
}

/** El nombre que dijo Norman: "este es Gilberto" / "es Kevin" / "/registrar Ale". */
export function nombreDelRegistro(texto: unknown): string {
  return String(texto ?? '')
    .replace(/^\s*\/registrar(@\w+)?/i, '')
    .replace(/^\s*(este|esta|ella|el)?\s*(es|se llama)\s+/i, '')
    .replace(/[.!?¡¿]+$/g, '')
    .trim()
}

export function mensajeDeAltaMiembro(a: {
  nombre: string
  entidad: string
  rol: string
  requiereAprobacion: boolean
}): string {
  const lineas = [
    'Esto es lo que voy a registrar. Revisalo:',
    '',
    `   ${a.nombre}  ->  ${a.entidad} (${a.rol})`
  ]
  if (a.requiereAprobacion) {
    lineas.push('', `Propone todo lo que propones tu, pero su VA espera TU Aprobar.`)
  } else if (a.rol === 'DST') {
    lineas.push('', 'Vende, cotiza y abona a su nombre; sus abonos te llegan para aprobar.')
  } else if (a.rol === 'LOC') {
    lineas.push('', 'Solo consulta lo suyo (inventario, lo que debe, precios).')
  }
  lineas.push('', 'Contesta VA para registrarlo.')
  return lineas.join('\n')
}
