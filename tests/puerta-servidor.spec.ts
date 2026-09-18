import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import {
  AREAS_DE_MANDO,
  CABECERA_RUTA,
  destinoPorRol,
  esAreaDeMando,
  esRutaProtegida,
  RUTAS_PROTEGIDAS,
  RUTA_LOGIN
} from '../lib/puerta-dashboard'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ERP-07 — la puerta de `/dashboard` se cierra en el SERVIDOR.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * EL DEFECTO. `app/dashboard/layout.tsx` era `'use client'` y comprobaba la
 * sesion dentro de un `useEffect`. Una proteccion que corre en el navegador no
 * es una proteccion: para cuando ese `useEffect` decide redirigir, el HTML del
 * Server Component y los datos que traia YA se entregaron. El `router.replace`
 * cambia lo que se ve; no deshace lo que viajo por el cable.
 *
 * POR QUE ESTA PRUEBA NO NECESITA SERVIDOR NI CREDENCIALES. `proxy.ts`
 * exporta una funcion: se le entrega un `NextRequest` sin cookies y se mira lo
 * que devuelve. Es la MISMA funcion que corre en produccion en cada peticion,
 * no una imitacion. Sin sesion, `auth.getUser()` contesta "no hay sesion" sin
 * salir a la red, asi que esto vive en el proyecto `puras` y corre en cada
 * push. Una prueba de seguridad que se salta por falta de contrasenas es una
 * prueba que nadie ve fallar.
 *
 * LA PREGUNTA DEL CONTROL — "si esto estuviera roto, ¿que veria yo aqui?" Si la
 * puerta volviera al cliente, `proxy()` devolveria un `next()` con
 * status 200 en lugar de un 307 a `/login`: la asercion de abajo se pone roja.
 * Y para que no quede en teoria, el ultimo bloque **reproduce la puerta vieja**
 * y exige que falle.
 */

/** El fuente sin lineas de comentario: la prosa explica lo que se quito. */
function codigoVivo(archivo: string): string {
  return readFileSync(archivo, 'utf8')
    .split('\n')
    .filter((linea) => {
      const l = linea.trim()
      return !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*')
    })
    .join('\n')
}

const RAIZ = path.resolve(__dirname, '..')
const LAYOUT = path.join(RAIZ, 'app', 'dashboard', 'layout.tsx')
const SHELL = path.join(RAIZ, 'components', 'DashboardShell.tsx')
const ORIGEN = 'http://localhost:3000'

/**
 * `createServerClient` exige URL y llave o lanza al construirse. Se ponen de
 * mentiras si no hay `.env`: esta prueba comprueba el camino SIN sesion, que
 * no llega a hablar con Supabase. Lo que ya venga del entorno no se pisa.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://ejemplo-de-prueba.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'llave-anon-de-prueba'

/** Se importa DESPUES de poner el entorno: el modulo lo lee al construir. */
async function cargarLaPuerta() {
  return (await import('../proxy')) as {
    proxy: (request: NextRequest) => Promise<Response>
  }
}

function peticionSinSesion(ruta: string): NextRequest {
  return new NextRequest(new URL(ruta, ORIGEN))
}

// ────────────────────────────────────────────────────────────────────────────
// 0. Guardia contra la prueba vacia
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · guardia: el instrumento existe', () => {
  test('las zonas protegidas y las areas de mando siguen declaradas', () => {
    // Si un refactor vacia estas listas, TODAS las pruebas de abajo pasarian
    // sobre cero rutas. Un instrumento roto y una medicion limpia se ven igual.
    expect(RUTAS_PROTEGIDAS.length).toBeGreaterThanOrEqual(3)
    expect(RUTAS_PROTEGIDAS).toContain('/dashboard')
    expect(AREAS_DE_MANDO).toContain('/dashboard/finanzas')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 1. LA PRUEBA: sin sesion no se entrega el tablero
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · una peticion sin sesion no recibe el tablero', () => {
  test('/dashboard/general sin cookies: 307 a /login y CUERPO VACIO', async () => {
    const { proxy } = await cargarLaPuerta()
    const respuesta = await proxy(peticionSinSesion('/dashboard/general'))

    expect(respuesta.status, 'la puerta dejo pasar una peticion sin sesion').toBe(307)

    const destino = respuesta.headers.get('location')
    expect(destino, 'no mando a /login').toBeTruthy()
    expect(new URL(destino!).pathname).toBe(RUTA_LOGIN)

    // Esta es la mitad que el `useEffect` no podia dar: no es que el navegador
    // se vaya a otro lado DESPUES de recibir el tablero — es que el tablero no
    // se entrega. Si el cuerpo trajera algo, habria datos viajando.
    expect(await respuesta.text(), 'la respuesta trajo cuerpo').toBe('')
  })

  test('la raiz de cada zona protegida rebota, no solo sus subrutas', async () => {
    const { proxy } = await cargarLaPuerta()

    for (const zona of RUTAS_PROTEGIDAS) {
      const respuesta = await proxy(peticionSinSesion(zona))
      expect(respuesta.status, `${zona} no rebota`).toBe(307)
    }
  })

  test('/pos y /ticket tambien: eran los otros dos <ProtectedRoute>', async () => {
    const { proxy } = await cargarLaPuerta()

    for (const ruta of ['/pos', '/ticket/abc-123']) {
      const respuesta = await proxy(peticionSinSesion(ruta))
      expect(respuesta.status, `${ruta} quedo abierto`).toBe(307)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. Lo que NO se puede cerrar: el bot y el propio login
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · la puerta no muerde a quien no debe', () => {
  test('/login no rebota (seria un bucle)', async () => {
    const { proxy } = await cargarLaPuerta()
    const respuesta = await proxy(peticionSinSesion(RUTA_LOGIN))
    expect(respuesta.status).not.toBe(307)
  })

  test('/api/bot/** pasa: el bot entra con sello, no con cookies', async () => {
    const { proxy } = await cargarLaPuerta()
    const respuesta = await proxy(peticionSinSesion('/api/bot/gasto/proponer'))
    expect(respuesta.status, 'la puerta dejo mudo al bot de Telegram').not.toBe(307)
  })

  test('el pathname viaja al Server Component en su cabecera', async () => {
    const { proxy } = await cargarLaPuerta()
    const respuesta = await proxy(peticionSinSesion('/login'))
    // Next devuelve las cabeceras de peticion sobreescritas en `x-middleware-*`.
    // Basta con comprobar que el nombre viaja: sin el, el layout no sabe la
    // ruta y la reubicacion por rol del servidor deja de ocurrir en silencio.
    const sobreescritas = respuesta.headers.get('x-middleware-override-headers') ?? ''
    expect(sobreescritas.toLowerCase()).toContain(CABECERA_RUTA)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Que cuenta como zona protegida, por segmento y no por prefijo
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · esRutaProtegida compara segmentos', () => {
  const PROTEGIDAS = ['/dashboard', '/dashboard/', '/dashboard/finanzas', '/pos', '/ticket/1']
  const LIBRES = ['/', '/login', '/api/bot/webhook', '/dashboardsecreto', '/positivo']

  for (const ruta of PROTEGIDAS) {
    test(`protegida: ${ruta}`, () => expect(esRutaProtegida(ruta)).toBe(true))
  }
  for (const ruta of LIBRES) {
    test(`libre: ${ruta}`, () => expect(esRutaProtegida(ruta)).toBe(false))
  }

  test('las areas de mando se reconocen igual', () => {
    expect(esAreaDeMando('/dashboard/finanzas')).toBe(true)
    expect(esAreaDeMando('/dashboard/finanzas/nuevo')).toBe(true)
    expect(esAreaDeMando('/dashboard/catalogo')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. La reubicacion por rol, que antes decidia el navegador
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · destinoPorRol: la misma decision, ahora en el servidor', () => {
  const ENTIDAD = 'f0443423-60a0-4156-9bcd-52394ae274fe'

  test('ADMIN y SOCIO entran a las areas de mando', () => {
    for (const rol of ['ADMIN', 'SOCIO']) {
      expect(destinoPorRol({ rol, entidadId: ENTIDAD, pathname: '/dashboard/finanzas' })).toBeNull()
    }
  })

  test('DST pidiendo finanzas se va al directorio', () => {
    expect(destinoPorRol({ rol: 'DST', entidadId: ENTIDAD, pathname: '/dashboard/finanzas' })).toBe(
      '/dashboard/distribuidores'
    )
  })

  test('LOC pidiendo inventario se va a su estado de cuenta', () => {
    expect(destinoPorRol({ rol: 'LOC', entidadId: ENTIDAD, pathname: '/dashboard/inventario' })).toBe(
      `/dashboard/distribuidores/${ENTIDAD}`
    )
  })

  test('fuera de las areas de mando no se reubica a nadie', () => {
    expect(destinoPorRol({ rol: 'LOC', entidadId: ENTIDAD, pathname: '/dashboard/catalogo' })).toBeNull()
  })

  test('sin rol resuelto no se reubica: esa decision no es de esta funcion', () => {
    expect(destinoPorRol({ rol: null, entidadId: null, pathname: '/dashboard/finanzas' })).toBeNull()
  })

  test('nunca redirige a donde ya estas (eso es un bucle, no una puerta)', () => {
    expect(
      destinoPorRol({ rol: 'DST', entidadId: ENTIDAD, pathname: '/dashboard/distribuidores' })
    ).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5. Que la puerta no vuelva al navegador por el mismo camino
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · el layout es de servidor y el cascaron no decide permisos', () => {
  test('app/dashboard/layout.tsx ya no es "use client"', () => {
    const vivo = codigoVivo(LAYOUT)
    expect(vivo.trimStart().startsWith("'use client'"), 'el layout volvio a ser de cliente').toBe(
      false
    )
    expect(vivo, 'el layout ya no comprueba la sesion').toContain('getAuthUser')
    expect(vivo, 'el layout ya no redirige en el servidor').toContain('redirect(RUTA_LOGIN)')
    expect(vivo, 'volvio un useEffect al layout: ahi es donde vivia el defecto').not.toContain(
      'useEffect'
    )
  })

  test('el cascaron de cliente no manda a nadie a /login', () => {
    const vivo = codigoVivo(SHELL)

    expect(vivo, 'el cascaron volvio a decidir la sesion en el navegador').not.toContain(RUTA_LOGIN)
    expect(vivo, 'el cascaron volvio a leer la sesion del navegador').not.toContain('auth.getSession')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 6. CONTROL NEGATIVO — la prueba SI distingue
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-07 · CONTROL NEGATIVO: la puerta vieja no pasa esta prueba', () => {
  /**
   * Reproduce lo que hacia el codigo anterior: el servidor entregaba la pagina
   * y era el navegador quien decidia. Modelado como lo unico que el servidor
   * hacia — dejar pasar. Si la asercion principal de arriba pudiera pasar
   * tambien con esto, no estaria midiendo nada.
   */
  test('una puerta que deja pasar da 200, no 307', async () => {
    const puertaVieja = async (_request: NextRequest) => NextResponse.next()

    const respuesta = await puertaVieja(peticionSinSesion('/dashboard/general'))

    expect(respuesta.status, 'el control negativo no reprodujo el defecto').not.toBe(307)
    expect(respuesta.headers.get('location')).toBeNull()
  })
})
