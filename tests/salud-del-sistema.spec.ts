import { readdirSync } from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  RAIZ,
  correnLasDeEquivalencia,
  llaveServiceRole,
  motivoDeSalto,
  urlSupabase
} from './vistas-entorno'
import { recetaDeRecuperacion } from './receta-migracion'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SALUD DEL SISTEMA — las dos cosas que ninguna otra prueba estaba mirando
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Las demas pruebas comprueban que el ERP **calcula** bien. Estas comprueban
 * que el ERP **es lo que el repo dice que es**, que es un defecto distinto y
 * que ya se materializo.
 *
 * ─── 1. SINCRONIA DE MIGRACIONES (ERP-73) ───────────────────────────────────
 *
 * El error, con fecha: el **2026-09-12** se midio la base contra el repo y
 * salio esto:
 *
 *   * **3 migraciones aplicadas en produccion cuyo SQL no existia en ningun
 *     archivo.** Una, `cerrar_execute_usuario_de_sesion`, era de seguridad;
 *     otra, `vistas_canonicas_banderas_no_nulas`, es la definicion vigente de
 *     `v_movimiento_clasificado`. Si la base se pierde, ese SQL se pierde con
 *     ella.
 *   * **10 archivos con un timestamp distinto** al registrado en el servidor.
 *     Uno ordenaba `vistas_canonicas` DESPUES de la migracion que corrige su
 *     defecto de NULL: reproducir el repo desde cero habria reintroducido el
 *     bug.
 *
 * El nombre en ingles del problema es **schema drift**, y su forma mas cara es
 * esta: cuando el sistema vivo se vuelve la unica fuente de verdad, el
 * repositorio deja de servir para recuperar nada.
 *
 * Se arreglo a mano ese dia. **Un arreglo a mano se vuelve a romper** — y de
 * hecho se rompio otra vez a los diez minutos, porque `apply_migration` sella
 * el registro con **su propia hora UTC**, no con la que trae el nombre del
 * archivo. Por eso el archivo se nombra DESPUES de aplicar, nunca antes, y por
 * eso existe esta prueba: es lo unico que no depende de que alguien se acuerde.
 *
 * ─── 2. CONTROL POSITIVO DE LA COLA DE AVISOS (ERP-59) ──────────────────────
 *
 * El 2026-09-12 la cola llevaba una semana viva y con **cero filas**. Dos
 * explicaciones producen esa misma observacion —la captura fue impecable, o el
 * detector no muerde— y **una tabla vacia no distingue entre las dos**. Es el
 * mismo patron que una medicion negativa sin control positivo.
 *
 * Esta prueba mete un aviso a proposito, comprueba que llega, se lee y se
 * cierra, y luego lo borra.
 *
 * ⚠️ **LO QUE NO PRUEBA, dicho aqui para que nadie se confie:** comprueba que
 * **la tuberia** funciona (tabla, permisos, trigger de autor, lectura, cierre).
 * **NO** comprueba que los 11 puntos de codigo que deben disparar avisos los
 * disparen: eso exige correr cada flujo de captura con su caso torcido, y va
 * por las pruebas de humo. Verde aqui significa *"la cola recibe"*, nunca
 * *"la cola se esta llenando cuando debe"*.
 */

const SALTO = !correnLasDeEquivalencia()

function cliente(): SupabaseClient {
  return createClient(urlSupabase()!, llaveServiceRole()!, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

// ════════════════════════════════════════════════════════════════════════════
// 1. EL REPO Y LA BASE CUENTAN LA MISMA HISTORIA
// ════════════════════════════════════════════════════════════════════════════

test.describe('ERP-73 · sincronia de migraciones', () => {
  test.skip(SALTO, motivoDeSalto())

  test('cada migracion aplicada tiene su archivo en el repo, con el mismo sello', async () => {
    const { data, error } = await cliente().rpc('migraciones_aplicadas')
    expect(error, error?.message).toBeNull()

    const enLaBase = (data as { version: string; name: string }[]).map(
      (m) => `${m.version}_${m.name}`
    )

    const enElRepo = readdirSync(path.join(RAIZ, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))

    const soloEnLaBase = enLaBase.filter((m) => !enElRepo.includes(m))
    const soloEnElRepo = enElRepo.filter((m) => !enLaBase.includes(m))

    const receta = recetaDeRecuperacion(soloEnLaBase)

    expect(
      soloEnLaBase,
      'APLICADAS EN PRODUCCION Y SIN ARCHIVO. Su SQL solo existe dentro de la base: si la ' +
        'base se pierde, se pierde con ella. Casi nunca la aplico quien esta empujando: ' +
        '`apply_migration` sella la base y NO escribe el archivo del repo (ERP-83).' +
        receta
    ).toEqual([])

    expect(
      soloEnElRepo,
      'ARCHIVOS QUE LA BASE NO RECONOCE. O no se aplicaron —y la pantalla que dependa de ' +
        'ellos esta rota—, o se aplicaron por fuera y el registro no se entero. Ojo con el ' +
        'segundo caso: apply_migration sella con SU hora UTC, no con la del nombre del ' +
        'archivo. El archivo se nombra DESPUES de aplicar.'
    ).toEqual([])
  })

  test('el orden de los archivos es el orden en que se aplicaron', async () => {
    const { data } = await cliente().rpc('migraciones_aplicadas')
    const versiones = (data as { version: string }[]).map((m) => m.version)

    expect(
      versiones,
      'Reproducir el repo desde cero correria las migraciones en un orden distinto al real. ' +
        'Ya paso: vistas_canonicas quedo DESPUES de la migracion que corrige su defecto de NULL.'
    ).toEqual([...versiones].sort())
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. LA COLA DE AVISOS RECIBE DE VERDAD
// ════════════════════════════════════════════════════════════════════════════

test.describe('ERP-59 · control positivo de la cola de avisos', () => {
  test.skip(SALTO, motivoDeSalto())

  test('un aviso metido a proposito llega, se lee y se puede cerrar', async () => {
    const db = cliente()

    const { data: entidad } = await db
      .from('entidades')
      .select('id, nombre')
      .eq('rol', 'LOC')
      .limit(1)
      .single()

    expect(entidad, 'hace falta al menos una entidad LOC para colgar el aviso').toBeTruthy()

    const marca = `PRUEBA AUTOMATICA ${Date.now()}`
    let idCreado: string | null = null

    try {
      const { data: creado, error: errorInsert } = await db
        .from('avisos_captura')
        .insert({
          tipo: 'W12',
          severidad: 'REVISAR',
          mensaje: marca,
          id_entidad: entidad!.id,
          estado: 'ABIERTO',
          datos_capturados: { origen: 'tests/salud-del-sistema.spec.ts' }
        })
        .select('id, tipo, severidad, estado')
        .single()

      expect(
        errorInsert,
        'LA COLA NO RECIBE. Mientras esto falle, la tabla puede estar vacia porque el ' +
          'detector esta roto y no porque la captura salga limpia — y las dos se ven igual. ' +
          `Detalle: ${errorInsert?.message ?? 'sin detalle'}`
      ).toBeNull()

      idCreado = creado!.id as string
      expect(creado!.estado, 'un aviso nace ABIERTO').toBe('ABIERTO')
      expect(creado!.severidad, 'W12 es REVISAR segun el catalogo de lib/avisos.ts').toBe('REVISAR')

      // Se lee por el mismo camino que la pantalla: filtro por estado.
      const { data: abiertos } = await db
        .from('avisos_captura')
        .select('id')
        .eq('estado', 'ABIERTO')

      expect(
        (abiertos ?? []).map((a) => a.id),
        'el aviso entro pero la consulta de la pantalla no lo ve'
      ).toContain(idCreado)

      // CONTROL NEGATIVO: el mismo filtro tiene que poder devolver vacio.
      const { data: ajenos } = await db
        .from('avisos_captura')
        .select('id')
        .eq('mensaje', `${marca}-QUE-NO-EXISTE`)
      expect(ajenos ?? [], 'si todo devuelve filas, el filtro no esta filtrando').toEqual([])

      // W12 no exige asignacion: se debe poder cerrar.
      const { error: errorCierre } = await db
        .from('avisos_captura')
        .update({ estado: 'RESUELTO' })
        .eq('id', idCreado)

      expect(errorCierre, 'un W12 se cierra sin condiciones; solo W4 tiene candado').toBeNull()
    } finally {
      if (idCreado) {
        await db.from('avisos_captura').delete().eq('id', idCreado)
        const { data: sobra } = await db.from('avisos_captura').select('id').eq('id', idCreado)
        expect(sobra ?? [], 'la prueba no deja basura en produccion').toEqual([])
      }
    }
  })
})
