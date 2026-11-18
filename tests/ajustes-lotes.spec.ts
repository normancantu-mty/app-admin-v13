/**
 * Correccion de lotes + alias + consecutivo (migracion 20261118192907).
 * Escrito el 2026-11-18 por el agente (Cuartel). PURAS: sin base ni red.
 *
 * 1. Nombres y alias (`lib/lote-alias.ts`): el bot encuentra el lote por su
 *    nombre actual o cualquiera anterior, y el consecutivo es el de SQL.
 * 2. La doble confirmacion de la cabecera (`lib/ajustes-lotes.ts`).
 * 3. Los textos de la migracion: lo que el ensayo BEGIN/ROLLBACK probo contra
 *    prod tiene que seguir escrito asi (RPC SECURITY INVOKER que revalida ADMIN,
 *    CAMBIO_CONCURRENTE, triggers de alias, vacio = recomendado).
 * 4. Las rutas del bot buscan con `resolver_lote` / alias, no con `.ilike`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  aliasPorLote,
  avisoDeCodigoNumerico,
  esCodigoNumerico,
  nombreDelLote,
  nombresTomados,
  nombreTomado,
  normalizarNombreLote,
  siguienteCodigoNumerico
} from '@/lib/lote-alias'
import {
  cabeceraDesdeForm,
  cambiosDeLote,
  confirmacionLoteCasa,
  formDesdeCabecera,
  mensajeDeErrorLote,
  renombraDeVerdad,
  validarSolicitudLote,
  type CabeceraLote,
  type SolicitudLote
} from '@/lib/ajustes-lotes'
import { elegirLoteDestino, filasDelPeriodo, type FilaEnvasado } from '@/lib/bot-envasado'
import { validarLote } from '@/components/v2/lotes/validar'

const RAIZ = process.cwd()
const leer = (f: string) => fs.readFileSync(path.join(RAIZ, f), 'utf-8')
const MIGRACION = leer('supabase/migrations/20261118192907_v2_correccion_lotes.sql')
const ROLLBACK = leer('supabase/ROLLBACK_correccion_lotes_2026-11-18.sql')
const ID = '44444444-4444-4444-8444-444444444444'

const L04: CabeceraLote = {
  codigo_lote: 'L-04-11.1',
  fecha_inicio: '2026-11-04',
  fecha_fin_fermentacion: '2026-11-11',
  horas_fermentacion: 168,
  brix_chile: 2.5,
  brix_final: 10.7,
  notas: null
}

test.describe('lotes · nombres y alias', () => {
  test('el nombre se compara sin mayusculas ni espacios, contra el actual y los alias', () => {
    const lote = { codigo_lote: '136', alias: ['L-04-11.1'] }
    expect(normalizarNombreLote('  l-04-11.1 ')).toBe('L-04-11.1')
    expect(nombreDelLote('136', lote)).toBe(true)
    expect(nombreDelLote(' l-04-11.1', lote)).toBe(true)
    expect(nombreDelLote('L-05-11.1', lote)).toBe(false)
    expect(nombreDelLote('', lote)).toBe(false)
  })

  test('el bot elige el lote por un nombre anterior (envasar) y filtra produccion por alias', () => {
    const lotes = [
      { id: 'a', codigo_lote: '136', fecha_inicio: '2026-11-04', alias: ['L-04-11.1'] },
      { id: 'b', codigo_lote: 'L-05-11.1', fecha_inicio: '2026-11-05' }
    ]
    const r = elegirLoteDestino('l-04-11.1', lotes, '2026-11-18')
    expect(r.ok && r.lote.id).toBe('a')
    const filas: FilaEnvasado[] = [
      { fecha: '2026-11-10', codigo_lote: '136', alias: ['L-04-11.1'], producto: 'X', botellas: 10 },
      { fecha: '2026-11-10', codigo_lote: 'L-05-11.1', producto: 'X', botellas: 5 }
    ]
    expect(filasDelPeriodo(filas, { tipo: 'lote', codigo: 'L-04-11.1', etiqueta: '' }).map((f) => f.botellas)).toEqual([10])
    expect(filasDelPeriodo(filas, { tipo: 'lote', codigo: '136', etiqueta: '' }).map((f) => f.botellas)).toEqual([10])
  })

  test('los nombres tomados juntan actuales y alias; el choque es sin mayusculas', () => {
    const alias = [
      { id_lote: 'a', alias: 'L-04-11.1' },
      { id_lote: 'a', alias: '135' }
    ]
    expect(aliasPorLote(alias).get('a')).toEqual(['L-04-11.1', '135'])
    const tomados = nombresTomados(['136', null, ' '], alias)
    expect(tomados).toEqual(['136', 'L-04-11.1', '135'])
    expect(nombreTomado('l-04-11.1', tomados)).toBe(true)
    expect(nombreTomado('137', tomados)).toBe(false)
  })

  test('consecutivo: 1 + el mayor solo-digitos (actuales y alias); 1 si no hay', () => {
    expect(siguienteCodigoNumerico([])).toBe('1')
    expect(siguienteCodigoNumerico(['L-04-11.1', 'L-20261111', '12a'])).toBe('1')
    expect(siguienteCodigoNumerico(['136', '135', ' 140 '])).toBe('141')
    expect(siguienteCodigoNumerico(['99999999999999999999'])).toBe('100000000000000000000')
    expect(esCodigoNumerico(' 136 ')).toBe(true)
    expect(esCodigoNumerico('L-136')).toBe(false)
  })

  test('un numero a mano que no es el recomendado AVISA; texto libre no', () => {
    expect(avisoDeCodigoNumerico('140', '137')).toMatch(/consecutivo que sigue es 137/)
    expect(avisoDeCodigoNumerico('137', '137')).toBeNull()
    expect(avisoDeCodigoNumerico('LOTE-ESPECIAL', '137')).toBeNull()
    expect(avisoDeCodigoNumerico('L-04-11.1', '137')).toBeNull()
  })
})

test.describe('lotes · formulario y doble confirmacion', () => {
  test('el formulario va y vuelve; «en curso» quita la fecha de fin', () => {
    const f = formDesdeCabecera(L04)
    expect(f.terminada).toBe(true)
    const ida = cabeceraDesdeForm(f)
    expect(ida.ok && ida.cabecera).toEqual(L04)
    const enCurso = cabeceraDesdeForm({ ...f, terminada: false })
    expect(enCurso.ok && enCurso.cabecera.fecha_fin_fermentacion).toBeNull()
    expect(cabeceraDesdeForm({ ...f, terminada: true, fecha_fin_fermentacion: '' })).toMatchObject({ ok: false })
    expect(cabeceraDesdeForm({ ...f, fecha_fin_fermentacion: '2026-11-01' })).toMatchObject({ ok: false })
    expect(cabeceraDesdeForm({ ...f, codigo_lote: '  ' })).toMatchObject({ ok: false })
    expect(cabeceraDesdeForm({ ...f, horas_fermentacion: '12,5' })).toMatchObject({ ok: false })
  })

  test('los cambios salen campo por campo; notas vacias = null', () => {
    const nuevo = { ...L04, codigo_lote: '136', fecha_fin_fermentacion: null, notas: '' }
    expect(cambiosDeLote(L04, nuevo).map((c) => c.campo)).toEqual(['codigo_lote', 'fecha_fin_fermentacion'])
    expect(cambiosDeLote(L04, { ...L04 })).toEqual([])
    expect(renombraDeVerdad('L-04-11.1', 'l-04-11.1 ')).toBe(false)
    expect(renombraDeVerdad('L-04-11.1', '136')).toBe(true)
  })

  const base: SolicitudLote = { id: ID, visto: L04, nuevo: { ...L04, codigo_lote: '136' }, motivo: 'nomenclatura nueva', paso1: true, confirmacion: '136' }

  test('con las dos confirmaciones y motivo pasa', () => {
    expect(validarSolicitudLote(base)).toBeNull()
  })

  test('sin la primera, sin la segunda o con otro codigo NO se escribe (control negativo)', () => {
    expect(validarSolicitudLote({ ...base, paso1: false })).toMatch(/primera/)
    expect(validarSolicitudLote({ ...base, confirmacion: '' })).toMatch(/segunda/)
    expect(validarSolicitudLote({ ...base, confirmacion: 'L-04-11.1' })).toMatch(/segunda/)
    expect(confirmacionLoteCasa(' 136 ', '136')).toBe(true)
  })

  test('motivo, id, datos incompletos y "sin cambio" se rechazan', () => {
    expect(validarSolicitudLote({ ...base, motivo: 'ab' })).toMatch(/motivo/)
    expect(validarSolicitudLote({ ...base, id: 'x' })).toMatch(/inválido/)
    expect(validarSolicitudLote({ ...base, nuevo: { codigo_lote: '136' } as never })).toMatch(/incompletos/)
    expect(validarSolicitudLote({ ...base, nuevo: L04, confirmacion: 'L-04-11.1' })).toMatch(/nada que corregir/)
  })

  test('los rangos los pone validarLote (los mismos topes del bot y la pantalla)', () => {
    const v = (c: Partial<CabeceraLote>) => validarLote({ ...L04, ...c, notas: '', entradas: [], tandas: [] }, '2026-11-18')
    expect(v({}).ok).toBe(true)
    expect(v({ fecha_inicio: '2026-12-01' }).ok).toBe(false)
    expect(v({ brix_final: 120 }).ok).toBe(false)
    expect(v({ codigo_lote: 'x'.repeat(41) }).ok).toBe(false)
  })

  test('los errores de la RPC se vuelven legibles', () => {
    expect(mensajeDeErrorLote('NOMBRE_OCUPADO: L-04-11.1 es un nombre anterior del lote 136. Usa otro codigo.')).toMatch(/^L-04-11.1 es un nombre anterior/)
    expect(mensajeDeErrorLote('CAMBIO_CONCURRENTE: el lote 136 cambio mientras lo revisabas.')).toMatch(/no se escribió nada/)
    expect(mensajeDeErrorLote('SIN_CAMBIO: el lote 136 ya tiene esos datos')).toMatch(/^Sin cambio/)
  })
})

test.describe('lotes · la migracion dice lo que el ensayo probo', () => {
  test('ajustar_lote: SECURITY INVOKER, revalida ADMIN, bloquea, compara y rechaza', () => {
    const rpc = MIGRACION.slice(MIGRACION.indexOf('CREATE OR REPLACE FUNCTION public.ajustar_lote'))
    expect(rpc).toMatch(/SECURITY INVOKER\s+SET search_path = public, pg_catalog/)
    expect(rpc).toMatch(/IF public\.mi_rol\(\) IS DISTINCT FROM 'ADMIN' THEN/)
    expect(rpc).toMatch(/length\(v_motivo\) < 5/)
    expect(rpc).toMatch(/FROM public\.lotes WHERE id = p_id FOR UPDATE/)
    expect(rpc).toMatch(/CAMBIO_CONCURRENTE[\s\S]*ERRCODE = '40001'/)
    expect(rpc).toMatch(/SIN_CAMBIO/)
    expect(rpc).toMatch(/set_config\('app\.motivo_correccion', v_motivo, true\)/)
    expect(MIGRACION).toMatch(/REVOKE ALL ON FUNCTION public\.ajustar_lote\(uuid, jsonb, jsonb, text\) FROM PUBLIC, anon;/)
    expect(MIGRACION).toMatch(/GRANT EXECUTE ON FUNCTION public\.ajustar_lote\(uuid, jsonb, jsonb, text\) TO authenticated;/)
  })

  test('alias: tabla sin escritura de clientes, unicos normalizados y los dos triggers', () => {
    expect(MIGRACION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS lotes_codigo_lote_normalizado_key\s+ON public\.lotes \(upper\(btrim\(codigo_lote\)\)\)/)
    expect(MIGRACION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS lote_alias_normalizado_key\s+ON public\.lote_alias \(upper\(btrim\(alias\)\)\)/)
    expect(MIGRACION).toMatch(/REFERENCES public\.lotes\(id\) ON DELETE CASCADE/)
    expect(MIGRACION).toMatch(/ALTER TABLE public\.lote_alias ENABLE ROW LEVEL SECURITY/)
    expect(MIGRACION).toMatch(/REVOKE ALL ON public\.lote_alias FROM PUBLIC, anon, authenticated, service_role;\s*GRANT SELECT ON public\.lote_alias TO authenticated, service_role;/)
    expect(MIGRACION).toMatch(/BEFORE INSERT OR UPDATE OF codigo_lote ON public\.lotes\s+FOR EACH ROW EXECUTE FUNCTION public\.tg_lote_nombre_libre\(\)/)
    expect(MIGRACION).toMatch(/AFTER UPDATE OF codigo_lote ON public\.lotes\s+FOR EACH ROW EXECUTE FUNCTION public\.tg_lote_alias\(\)/)
    expect(MIGRACION).toMatch(/NOMBRE_OCUPADO/)
    expect(MIGRACION).toMatch(/AFTER INSERT OR UPDATE ON public\.lotes\s+FOR EACH ROW EXECUTE FUNCTION public\.tg_bitacora\(\)/)
  })

  test('resolver_lote y siguiente_codigo_lote: lecturas con GRANT al bot (service_role)', () => {
    expect(MIGRACION).toMatch(/FUNCTION public\.resolver_lote\(p_nombre text\)\s+RETURNS SETOF public\.lotes\s+LANGUAGE sql\s+STABLE\s+SECURITY INVOKER/)
    expect(MIGRACION).toMatch(/GRANT EXECUTE ON FUNCTION public\.resolver_lote\(text\) TO authenticated, service_role;/)
    expect(MIGRACION).toMatch(/FUNCTION public\.siguiente_codigo_lote\(\)\s+RETURNS text\s+LANGUAGE sql\s+STABLE\s+SECURITY INVOKER/)
    expect(MIGRACION).toMatch(/GRANT EXECUTE ON FUNCTION public\.siguiente_codigo_lote\(\) TO authenticated, service_role;/)
    // La misma regla que el espejo TypeScript: solo digitos, como numero, +1, '1' sin ninguno.
    expect(MIGRACION).toMatch(/\(COALESCE\(max\(n\), 0\) \+ 1\)::text/)
    expect((MIGRACION.match(/~ '\^\\d\+\$'/g) ?? []).length).toBe(2)
  })

  test('vacio = recomendado: trigger BEFORE INSERT que corre antes del de nombre libre', () => {
    expect(MIGRACION).toMatch(/IF NEW\.codigo_lote IS NULL OR btrim\(NEW\.codigo_lote\) = '' THEN[\s\S]*NEW\.codigo_lote := public\.siguiente_codigo_lote\(\)/)
    expect(MIGRACION).toMatch(/CREATE TRIGGER trg_lote_codigo_vacio\s+BEFORE INSERT ON public\.lotes/)
    // Postgres dispara los BEFORE ROW en orden alfabetico del nombre.
    expect('trg_lote_codigo_vacio' < 'trg_lote_nombre_libre').toBe(true)
  })

  test('el rollback deshace todo lo que crea la migracion', () => {
    for (const objeto of [
      'DROP FUNCTION IF EXISTS public.ajustar_lote(uuid, jsonb, jsonb, text)',
      'DROP FUNCTION IF EXISTS public.resolver_lote(text)',
      'DROP FUNCTION IF EXISTS public.siguiente_codigo_lote()',
      'DROP TRIGGER IF EXISTS trg_lote_codigo_vacio ON public.lotes',
      'DROP TRIGGER IF EXISTS trg_bitacora_lotes ON public.lotes',
      'DROP TRIGGER IF EXISTS trg_lote_alias ON public.lotes',
      'DROP TRIGGER IF EXISTS trg_lote_nombre_libre ON public.lotes',
      'ALTER TABLE public.auditoria_logs DROP COLUMN IF EXISTS motivo',
      'DROP TABLE IF EXISTS public.lote_alias',
      'DROP INDEX IF EXISTS public.lotes_codigo_lote_normalizado_key'
    ]) {
      expect(ROLLBACK).toContain(objeto)
    }
    expect(ROLLBACK).toMatch(/\(tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues\)\s+VALUES/)
  })
})

test.describe('lotes · el bot busca por nombre actual o alias', () => {
  test('las rutas que buscaban con .ilike usan resolver_lote', () => {
    for (const f of ['app/api/bot/lote/etapa/proponer/route.ts', 'app/api/bot/pregunta/route.ts', 'app/api/bot/consulta/route.ts', 'app/api/bot/lote/confirmar/route.ts']) {
      const fuente = leer(f)
      expect(fuente, f).toMatch(/rpc\('resolver_lote', \{ p_nombre:/)
      expect(fuente, f).not.toMatch(/ilike\('codigo_lote'/)
    }
  })

  test('las listas de codigos tomados y en memoria leen lote_alias', () => {
    for (const f of ['lib/bot-servidor.ts', 'app/api/bot/lote/ciclo/route.ts', 'app/api/bot/lote/proponer/route.ts', 'app/api/bot/consulta/route.ts', 'app/actions/lotes-v2.ts']) {
      expect(leer(f), f).toMatch(/from\('lote_alias'\)\.select\('id_lote, alias'\)/)
    }
    expect(leer('lib/bot-ensayo.ts')).toMatch(/RPC_DE_SOLO_LECTURA = new Set\(\['saldo_cuenta', 'resolver_lote', 'siguiente_codigo_lote'\]\)/)
  })

  test('la server action de correcciones exige ADMIN, valida y usa la RPC (sin service role)', () => {
    const accion = leer('app/actions/ajustes-lotes.ts')
    expect(accion).toMatch(/usuario\.rol !== 'ADMIN'/)
    expect(accion).toMatch(/validarSolicitudLote\(s\)/)
    expect(accion).toMatch(/validarLote\(/)
    expect(accion).toMatch(/rpc\('ajustar_lote'/)
    expect(accion).not.toMatch(/SERVICE_ROLE/)
  })

  test('las 4 regex del codigo de lote son la misma (TS, YAML y los 2 Python)', () => {
    const ts = leer('lib/bot-pregunta-lote.ts').match(/export const CODIGO =\s*\/(.*)\/i/)?.[1]
    expect(ts).toBeTruthy()
    const py = leer('bot/lote_plantilla.py').match(/^PATRON_CODIGO = r"(.*)"$/m)?.[1]
    const gastos = leer('bot/bot_gastos.py').match(/^_CODIGO_LOTE = re\.compile\(r"(.*)"\)$/m)?.[1]
    const yaml = leer('bot/plantillas/lote.yaml').match(/^\s+- '(\\b\(l-\?.*)'$/m)?.[1]
    expect(py).toBe(ts)
    expect(gastos).toBe(ts)
    expect(yaml).toBe(ts)
    expect(leer('bot/lote_ciclo.py')).toMatch(/_CODIGO = re\.compile\(lote_plantilla\.PATRON_CODIGO\)/)
  })
})
