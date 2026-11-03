/**
 * FASE 9 (D94 + D98) — LA PUERTA DE TODO `/confirmar`: QUIEN PUEDE DAR EL VA.
 *
 * Antes de la Fase 9 cada ruta `confirmar` repetia dos lineas: "el borrador es
 * tuyo" y "esta PENDIENTE". Con los grupos hay tres casos, y viven aqui para
 * que las nueve rutas decidan IGUAL:
 *
 *   1. `directo`  — el dueno del borrador da VA y no requiere aprobacion
 *                   (Norman, un DST): se escribe, como siempre.
 *   2. `esperar`  — el dueno da VA pero su identidad `requiere_aprobacion`
 *                   (Kevin): **no se escribe nada**; el borrador pasa a
 *                   `ESPERA_APROBACION` y a Norman le llega por privado.
 *   3. `aprobar`  — un aprobador (ADMIN sin marca) que NO es el dueno aprieta
 *                   Aprobar sobre un borrador en `ESPERA_APROBACION`: se escribe
 *                   con la identidad del AUTOR (es su captura: su etiqueta en
 *                   `usuario_creador`, su entidad, sus cuentas) y el sello
 *                   intacto. Si el borrador cambio, el sello no empata y no se
 *                   escribe — igual que siempre.
 *
 * Cualquier otra combinacion se rechaza. En particular: el VA de B sobre el
 * borrador PENDIENTE de A (mismo grupo) es 403 — **la identidad es la persona,
 * no el chat** (D94).
 *
 * `decidirPuerta` es PURA (`tests/bot-fase9-permisos.spec.ts`).
 */

import { NextResponse } from 'next/server'
import type { ClienteServicio, IdentidadBot } from '@/lib/bot-servidor'
import { resolverIdentidad } from '@/lib/bot-servidor'
import {
  esAprobador,
  puedeAprobar,
  entidadesAlcanzables,
  ROL_TRABAJADOR,
  type ActorBot,
  type Alcance
} from '@/lib/bot-permisos'

export type ModoPuerta = 'directo' | 'esperar' | 'aprobar'

export type DecisionPuerta =
  | { ok: true; modo: ModoPuerta }
  | { ok: false; status: number; error: string }

export interface HechosDeLaPuerta {
  estado: string
  /** `bot_borradores.telegram_id`: la persona que propuso. */
  dueno: number
  /** La persona que aprieta el boton. */
  quien: number
  quienRol: string
  quienRequiereAprobacion: boolean
  /**
   * FASE 10 (D106): si el AUTOR requiere aprobacion (Kevin). Solo importa en
   * ESPERA_APROBACION: lo de Kevin lo aprueba solo quien no la requiere.
   */
  duenoRequiereAprobacion?: boolean
  /** El rol del autor. Sin dato, junto con la marca, se trata como Kevin. */
  duenoRol?: string
}

function puedeAprobarHechos(h: HechosDeLaPuerta): boolean {
  return puedeAprobar(
    { telegramId: h.quien, rol: h.quienRol, requiereAprobacion: h.quienRequiereAprobacion },
    // Un autor sin dato se trata como Kevin: lo mas cerrado.
    {
      telegramId: h.dueno,
      rol: h.duenoRol ?? 'ADMIN',
      requiereAprobacion: h.duenoRequiereAprobacion ?? true
    }
  )
}

export function decidirPuerta(h: HechosDeLaPuerta): DecisionPuerta {
  if (h.estado === 'PENDIENTE') {
    if (h.dueno !== h.quien) return { ok: false, status: 403, error: 'Ese borrador no es tuyo.' }
    return { ok: true, modo: h.quienRequiereAprobacion ? 'esperar' : 'directo' }
  }
  if (h.estado === 'ESPERA_APROBACION') {
    // FASE 10 (D106): nadie aprueba lo suyo. 403, no 409: no es un estado que
    // cambie esperando, es una puerta que no le toca.
    if (h.dueno === h.quien) {
      return { ok: false, status: 403, error: 'Nadie aprueba lo suyo: esto espera el Aprobar de otro.' }
    }
    if (!puedeAprobarHechos(h)) {
      return {
        ok: false,
        status: 403,
        error: esAprobador({ rol: h.quienRol, requiereAprobacion: h.quienRequiereAprobacion })
          ? 'Lo que propone el equipo lo aprueba Norman.'
          : 'Aprobar lo que propone otro lo hace solo Norman. Tu clic no escribe nada.'
      }
    }
    return { ok: true, modo: 'aprobar' }
  }
  return { ok: false, status: 409, error: `Ese borrador ya esta ${h.estado.toLowerCase()}.` }
}

/**
 * Quien puede apagar un borrador (FASE 9, D98). PENDIENTE: solo el dueno, como
 * siempre. ESPERA_APROBACION: el dueno (se arrepintio) o un aprobador (es el
 * Rechazar de Norman). **Pura.**
 */
export function puedeCancelar(h: HechosDeLaPuerta): boolean {
  if (h.dueno === h.quien) return true
  // El Rechazar sigue la misma regla que el Aprobar (D106).
  return h.estado === 'ESPERA_APROBACION' && puedeAprobarHechos(h)
}

// ─── EL LADO DEL SERVIDOR ───────────────────────────────────────────────────

export interface BorradorEnPuerta {
  id: string
  telegram_id: number
  estado: string
  chat_id?: number | null
}

export type PuertaAbierta =
  | { ok: true; modo: ModoPuerta; autor: IdentidadBot }
  | { ok: false; respuesta: NextResponse }

/**
 * Decide la puerta y devuelve la identidad con la que la ruta sigue: la del
 * AUTOR del borrador. En `directo`/`esperar` es la misma persona que aprieta;
 * en `aprobar` se relee por `borrador.telegram_id` (si ya no esta dado de
 * alta, no se escribe).
 */
export async function abrirPuerta(
  supabase: ClienteServicio,
  quien: IdentidadBot,
  borrador: BorradorEnPuerta
): Promise<PuertaAbierta> {
  // En ESPERA_APROBACION se lee al autor ANTES de decidir: la regla de quien
  // aprueba depende de si el autor requiere aprobacion (D106).
  const ajeno = borrador.estado === 'ESPERA_APROBACION' && Number(borrador.telegram_id) !== quien.telegramId
  const autor = ajeno ? await resolverIdentidad(supabase, Number(borrador.telegram_id)) : quien
  const d = decidirPuerta({
    estado: borrador.estado,
    dueno: Number(borrador.telegram_id),
    quien: quien.telegramId,
    quienRol: quien.rolEntidad,
    quienRequiereAprobacion: quien.requiereAprobacion,
    duenoRequiereAprobacion: autor?.requiereAprobacion,
    duenoRol: autor?.rolEntidad
  })
  if (!d.ok) return { ok: false, respuesta: NextResponse.json({ error: d.error }, { status: d.status }) }
  if (d.modo !== 'aprobar') return { ok: true, modo: d.modo, autor: quien }
  if (!autor) {
    return {
      ok: false,
      respuesta: NextResponse.json(
        { error: 'Quien lo propuso ya no esta dado de alta. No escribo nada.' },
        { status: 409 }
      )
    }
  }
  return { ok: true, modo: 'aprobar', autor }
}

export function actorDe(identidad: IdentidadBot): ActorBot {
  return { rol: identidad.rolEntidad, requiereAprobacion: identidad.requiereAprobacion }
}

/**
 * A quienes avisar "lo apruebo?" (D106): los que PUEDEN aprobar lo de este
 * autor. Norman y Kevin, nunca el autor, y lo de Kevin solo a Norman. El
 * primero que decide gana; el otro ve que ya se resolvio.
 */
export async function aprobadoresDelBot(
  supabase: ClienteServicio,
  autor: Pick<IdentidadBot, 'telegramId' | 'rolEntidad' | 'requiereAprobacion'>
): Promise<number[]> {
  const { data } = await supabase
    .from('bot_identidades')
    // `*`: con o sin `rol_bot` (WP-6). Un TRABAJADOR apunta a una entidad ADMIN;
    // sin leer `rol_bot` contaria como aprobador.
    .select('*, entidades!inner(rol)')
    .eq('activo', true)
  const personaAutor = {
    telegramId: autor.telegramId,
    rol: autor.rolEntidad,
    requiereAprobacion: autor.requiereAprobacion
  }
  return (data ?? [])
    .filter((f) =>
      puedeAprobar(
        {
          telegramId: Number(f.telegram_id),
          rol:
            (f as unknown as { rol_bot?: string | null }).rol_bot === ROL_TRABAJADOR
              ? ROL_TRABAJADOR
              : (f as unknown as { entidades: { rol: string | null } }).entidades?.rol ?? '',
          requiereAprobacion: Boolean(f.requiere_aprobacion)
        },
        personaAutor
      )
    )
    .map((f) => Number(f.telegram_id))
}

/**
 * FASE 10 (D106): el Aprobar se RECLAMA antes de escribir. Con dos aprobadores
 * (Norman y Kevin) los dos pueden apretar a la vez; sin esto, los dos pasan la
 * puerta (los dos leyeron ESPERA_APROBACION) y se escribe dos veces. Un UPDATE
 * condicionado es atomico: solo uno cambia la fila; el otro recibe 409.
 * `resuelto_en` marca el reclamo: un borrador en espera nunca lo tiene.
 *
 * FASE 11 (D107): **el reclamo ya no caduca.** Hasta la Fase 10 vencia a los 2
 * minutos, para liberar al huerfano de una escritura que fallo. Pero un lease
 * que vence no distingue "el otro fallo sin escribir" de "el otro YA escribio y
 * no pudo marcar CONFIRMADO" (medido por el auditor: la marca falla, a los 2 min
 * Kevin aprueba -> 2 cotizaciones). Ahora:
 *   · si la ruta falla ANTES de escribir, ella misma suelta el reclamo
 *     (`liberarReclamo`): no hay huerfano que esperar;
 *   · si la escritura salio, el reclamo se queda puesto aunque la marca falle
 *     (`marcarConfirmado` revisa el error y lo registra);
 *   · si el proceso murio a media escritura, el borrador queda TRABADO: el
 *     siguiente Aprobar recibe 409 `trabado` y lo dice. Norman revisa si se
 *     escribio y lo cancela con Rechazar. **Nunca se libera solo.**
 * Preferimos "a lo mas una vez, y si se traba se ve" a "al menos una vez".
 * Devuelve `null` si se puede seguir escribiendo.
 */
export async function reclamarAprobacion(
  supabase: ClienteServicio,
  borradorId: string,
  modo: ModoPuerta
): Promise<NextResponse | null> {
  if (modo !== 'aprobar') return null
  const r = await supabase
    .from('bot_borradores')
    .update({ resuelto_en: new Date().toISOString() })
    .eq('id', borradorId)
    .eq('estado', 'ESPERA_APROBACION')
    .is('resuelto_en', null)
    .select('id')
  // En ensayo la escritura no sale (`lib/bot-ensayo.ts`): no hay reclamo que
  // hacer, y nada se va a escribir despues.
  if ((r as { statusText?: string }).statusText === 'ENSAYO') return null
  if (r.error) {
    console.error('[bot] no pude reclamar la aprobacion', borradorId, r.error)
    return NextResponse.json({ error: 'No pude aprobarlo. No escribi nada.' }, { status: 500 })
  }
  if (!r.data || r.data.length !== 1) {
    // ¿Lo resolvio otro, o quedo trabado? Sigue en espera con reclamo puesto =
    // alguien empezo a escribirlo y no termino de marcarlo.
    const { data: actual } = await supabase
      .from('bot_borradores')
      .select('estado, resuelto_en')
      .eq('id', borradorId)
      .maybeSingle()
    if (actual?.estado === 'ESPERA_APROBACION' && actual?.resuelto_en) {
      return NextResponse.json(
        {
          error:
            'Esta aprobacion ya empezo a escribirse y no termino de marcarse. No la repito: ' +
            'revisa si quedo escrita; si no, Rechazala y que se vuelva a proponer.',
          trabado: true
        },
        { status: 409 }
      )
    }
    return NextResponse.json(
      { error: 'Eso ya lo resolvio otro aprobador. No escribi nada.', ya_resuelto: true },
      { status: 409 }
    )
  }
  return null
}

/**
 * FASE 11 (D107): la ruta fallo ANTES de escribir nada; suelta el reclamo para
 * que se pueda volver a Aprobar. Solo se llama donde el codigo SABE que no
 * salio ninguna escritura. Si hay duda, no se llama: queda trabado y se ve.
 */
export async function liberarReclamo(
  supabase: ClienteServicio,
  borradorId: string,
  modo: ModoPuerta
): Promise<void> {
  if (modo !== 'aprobar') return
  const { error } = await supabase
    .from('bot_borradores')
    .update({ resuelto_en: null })
    .eq('id', borradorId)
    .eq('estado', 'ESPERA_APROBACION')
  if (error && (error as { code?: string }).code !== 'ENSAYO') {
    console.error('[bot] no pude soltar el reclamo (queda trabado, se ve)', borradorId, error)
  }
}

/** Lo que se le dice a quien aprobo si la escritura salio y la marca no. */
export const AVISO_MARCA_FALLO =
  'Quedo escrito, pero no pude marcar la propuesta como hecha. No se va a repetir: ' +
  'si alguien aprieta Aprobar otra vez, le digo que ya empezo.'

/**
 * FASE 11 (D107): la marca final, con su error REVISADO. Hasta la Fase 10 nadie
 * lo leia. Devuelve `null` si quedo marcado, o el aviso para la respuesta. Si
 * falla, el reclamo (si lo hubo) se queda puesto: no se libera.
 */
export async function marcarConfirmado(
  supabase: ClienteServicio,
  borradorId: string,
  idRegistro: string | null
): Promise<string | null> {
  const campos: Record<string, unknown> = { estado: 'CONFIRMADO', resuelto_en: new Date().toISOString() }
  if (idRegistro !== null) campos.id_registro = idRegistro
  const { error } = await supabase.from('bot_borradores').update(campos).eq('id', borradorId)
  if (error && (error as { code?: string }).code !== 'ENSAYO') {
    console.error('[bot] ESCRIBI pero no pude marcar CONFIRMADO', borradorId, idRegistro, error)
    return AVISO_MARCA_FALLO
  }
  return null
}

/** El nombre con que el bot llama a alguien: su etiqueta, capitalizada. */
export function nombreDeEtiqueta(etiqueta: string): string {
  const e = String(etiqueta ?? '').replace(/[_-]+/g, ' ').trim()
  return e.replace(/\b([a-z])/g, (m) => m.toUpperCase()) || '(sin nombre)'
}

/**
 * El VA de Kevin: el borrador pasa a `ESPERA_APROBACION` y **no se escribe
 * nada**. Se llama DESPUES de comprobar los dos sellos (lo que espera es
 * exactamente lo que se enseno) y ANTES de cualquier escritura.
 */
export async function pasarAEspera(
  supabase: ClienteServicio,
  borradorId: string,
  autor: IdentidadBot,
  /** "un gasto", "una venta"... El texto completo de la propuesta lo reenvia el bot. */
  queEs: string
): Promise<NextResponse> {
  const { error } = await supabase
    .from('bot_borradores')
    .update({ estado: 'ESPERA_APROBACION' })
    .eq('id', borradorId)
    .eq('estado', 'PENDIENTE')
  if (error && (error as { code?: string }).code !== 'ENSAYO') {
    console.error('[bot] no pude pasar a espera', borradorId, error)
    return NextResponse.json({ error: 'No pude mandarlo a aprobar. No escribi nada.' }, { status: 500 })
  }
  const nombre = nombreDeEtiqueta(autor.etiqueta)
  return NextResponse.json({
    ok: false,
    espera_aprobacion: true,
    borrador_id: borradorId,
    avisar_a: await aprobadoresDelBot(supabase, autor),
    propuesto_por: nombre,
    mensaje: autor.requiereAprobacion
      ? `Listo, ${nombre}. No lo escribo todavia: se lo mande a Norman para que lo apruebe.`
      : `Listo, ${nombre}. No lo escribo todavia: se lo mande a Norman y a Kevin para que lo aprueben.`,
    mensaje_aprobador: `${nombre} propone ${queEs} y espera tu Aprobar.`
  })
}

/**
 * FASE 9 (D96/D99): las entidades que alcanza una identidad, leidas con la
 * MISMA regla que `mis_entidades()` (la propia + hijos por `id_padre` o
 * `id_nodo_padre`). No se llama al rpc porque el cliente del bot es de
 * servicio y `mis_entidades()` lee `auth.uid()`. `null` = todas (ADMIN).
 */
export async function redDe(
  supabase: ClienteServicio,
  identidad: IdentidadBot,
  alcance: Alcance
): Promise<Set<string> | null> {
  if (alcance === 'todo') return null
  const { data } = await supabase.from('entidades').select('id, id_padre, id_nodo_padre')
  return entidadesAlcanzables(alcance, identidad.idEntidad, data ?? [])
}

/** El alcance de lo que un actor puede tocar al proponer: ADMIN todo, DST su red, resto lo propio. */
export function alcanceDeCaptura(identidad: IdentidadBot): Alcance {
  if (identidad.rolEntidad === 'ADMIN') return 'todo'
  // WP-6: el trabajador captura para la Matriz (a cualquier cliente) y todo lo
  // suyo espera el Aprobar. Ver la lista de clientes no es una cifra agregada.
  if (identidad.rolEntidad === ROL_TRABAJADOR) return 'todo'
  return identidad.rolEntidad === 'DST' ? 'red' : 'propio'
}

/**
 * FASE 9 (D97): la cuenta de la MATRIZ a la que entra el abono de un DST. Un DST
 * no tiene cuentas de la matriz en su alta; se usa la cuenta por defecto del
 * aprobador (Norman). Norman lo aprueba antes de que cuente, y en la pantalla
 * de aprobaciones puede verlo igual que un abono capturado en la app.
 */
export async function cuentaDeLaMatrizParaAbono(
  supabase: ClienteServicio
): Promise<{ id: string; nombre: string } | null> {
  const { data } = await supabase
    .from('bot_identidades')
    .select('id_cuenta_destino, creado_en, entidades!inner(rol), cuentas_financieras!inner(nombre)')
    .eq('activo', true)
    .eq('requiere_aprobacion', false)
    .order('creado_en', { ascending: true })
  const fila = (data ?? []).find(
    (f) => (f as unknown as { entidades: { rol: string | null } }).entidades?.rol === 'ADMIN'
  ) as unknown as { id_cuenta_destino: string; cuentas_financieras: { nombre: string | null } } | undefined
  if (!fila) return null
  return { id: fila.id_cuenta_destino, nombre: fila.cuentas_financieras?.nombre ?? '(cuenta de la matriz)' }
}
