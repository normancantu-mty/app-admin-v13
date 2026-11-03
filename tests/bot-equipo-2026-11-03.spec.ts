/**
 * 2026-11-03 — el bot para el equipo: alta de categoria/subcategoria (la regla
 * compartida por la pantalla v2 y el bot) y la consulta "gastos". Escrito por el
 * ejecutor del Socio (bot ERP equipo). Puras: sin red, sin BD.
 */
import { test, expect } from '@playwright/test'
import {
  llaveDeNombre,
  mensajeDeAltaCategoria,
  sellarCategoria,
  selloCategoriaCoincide,
  validarAltaCategoria,
  type FilaCategoria,
  type PayloadAltaCategoria
} from '@/lib/categorias-movimiento'
import { gastosDelMes, textoGastos, type FilaGasto } from '@/lib/bot-consultas'
import { esAprobador, permisoDeAccion, permisoDeConsulta } from '@/lib/bot-permisos'

const EXISTENTES: FilaCategoria[] = [
  { tipo: 'EGRESO', categoria: 'Logística', subcategoria: 'Gasolina', orden: 4 },
  { tipo: 'EGRESO', categoria: 'Logística', subcategoria: 'Casetas', orden: 5 },
  { tipo: 'INGRESO', categoria: 'Ventas', subcategoria: 'Contado', orden: 9 }
]

test.describe('2026-11-03 · alta de categoria (regla unica, pantalla y bot)', () => {
  test('subcategoria nueva en categoria existente: usa el nombre canonico (acentos y mayusculas no duplican)', () => {
    const j = validarAltaCategoria({ categoria: '  logistica ', subcategoria: 'Diesel' }, EXISTENTES)
    expect(j).toEqual({ ok: true, tipo: 'EGRESO', categoria: 'Logística', subcategoria: 'Diesel', categoriaNueva: false, orden: 10 })
  })

  test('categoria nueva: se marca nueva y nace con su subcategoria', () => {
    const j = validarAltaCategoria({ categoria: 'Mantenimiento de planta', subcategoria: 'Soldadura' }, EXISTENTES)
    expect(j).toMatchObject({ ok: true, categoria: 'Mantenimiento de planta', categoriaNueva: true })
  })

  test('repetida (sin importar acentos/mayusculas) -> no', () => {
    const j = validarAltaCategoria({ categoria: 'LOGISTICA', subcategoria: 'gasolína' }, EXISTENTES)
    expect(j.ok).toBe(false)
    if (!j.ok) expect(j.motivo).toContain('ya existe: Logística / Gasolina')
  })

  test('CONTROL: la misma pareja en el OTRO tipo no es repetida', () => {
    const j = validarAltaCategoria({ tipo: 'INGRESO', categoria: 'Logística', subcategoria: 'Gasolina' }, EXISTENTES)
    expect(j).toMatchObject({ ok: true, tipo: 'INGRESO', categoriaNueva: true })
  })

  test('falta la subcategoria -> no (la tabla no acepta categoria sola)', () => {
    expect(validarAltaCategoria({ categoria: 'Logística', subcategoria: '  ' }, EXISTENTES).ok).toBe(false)
    expect(validarAltaCategoria({ categoria: '', subcategoria: 'X' }, EXISTENTES).ok).toBe(false)
  })

  test('una categoria NUEVA con nombre que dispara el pasivo fiscal -> no', () => {
    const j = validarAltaCategoria({ categoria: 'Pago IVA', subcategoria: 'Octubre' }, EXISTENTES)
    expect(j.ok).toBe(false)
    expect(validarAltaCategoria({ categoria: 'FUGA_FISCAL_IEPS', subcategoria: 'x' }, EXISTENTES).ok).toBe(false)
  })

  test('tipo raro, nombre largo o caracteres de codigo -> no', () => {
    expect(validarAltaCategoria({ tipo: 'TRANSFERENCIA', categoria: 'A', subcategoria: 'B' }, EXISTENTES).ok).toBe(false)
    expect(validarAltaCategoria({ categoria: 'A'.repeat(61), subcategoria: 'B' }, EXISTENTES).ok).toBe(false)
    expect(validarAltaCategoria({ categoria: 'A<script>', subcategoria: 'B' }, EXISTENTES).ok).toBe(false)
  })

  test('llaveDeNombre quita acentos, mayusculas y espacios de mas', () => {
    expect(llaveDeNombre('  Logística   y Envíos ')).toBe('logistica y envios')
  })

  test('el sello ata los cinco campos: cambiar la subcategoria lo rompe', () => {
    const p: PayloadAltaCategoria = { tipo: 'EGRESO', categoria: 'Logística', subcategoria: 'Diesel', orden: 10, creado_por: 'telegram:norman' }
    const s = sellarCategoria(p)
    expect(selloCategoriaCoincide(p, s)).toBe(true)
    expect(selloCategoriaCoincide({ ...p, subcategoria: 'Diésel 2' }, s)).toBe(false)
    expect(selloCategoriaCoincide({ ...p, creado_por: 'telegram:kevin' }, s)).toBe(false)
  })

  test('el mensaje dice si la categoria es nueva', () => {
    expect(mensajeDeAltaCategoria({ tipo: 'EGRESO', categoria: 'A', subcategoria: 'B', categoriaNueva: true })).toContain('NUEVA')
    expect(mensajeDeAltaCategoria({ tipo: 'EGRESO', categoria: 'A', subcategoria: 'B', categoriaNueva: false })).toContain('ya existe')
  })
})

test.describe('2026-11-03 · quien aprueba y quien agrega categorias', () => {
  const norman = { rol: 'ADMIN', requiereAprobacion: false }
  const kevin = { rol: 'ADMIN', requiereAprobacion: true }
  const dst = { rol: 'DST', requiereAprobacion: false }

  test('solo Norman es aprobador', () => {
    expect(esAprobador(norman)).toBe(true)
    expect(esAprobador(kevin)).toBe(false)
    expect(esAprobador(dst)).toBe(false)
  })

  test('categoria: Norman si, el equipo con marca espera aprobacion, DST no', () => {
    expect(permisoDeAccion(norman, 'categoria')).toBe('si')
    expect(permisoDeAccion(kevin, 'categoria')).toBe('aprobacion')
    expect(permisoDeAccion(dst, 'categoria')).toBe('no')
  })

  test('consulta gastos: la matriz la lee (por privado en grupo); un DST no', () => {
    expect(permisoDeConsulta(norman, 'gastos')).toMatchObject({ ok: true })
    expect(permisoDeConsulta(dst, 'gastos')).toMatchObject({ ok: false })
  })
})

test.describe('2026-11-03 · consulta "cuanto llevamos gastado"', () => {
  const f = (p: Partial<FilaGasto>): FilaGasto => ({
    tipo_movimiento: 'GASTO_OPERATIVO', monto: 100, categoria: 'Logística', subcategoria: 'Gasolina',
    status: 'ACTIVO', fecha_movimiento: '2026-11-02T18:00:00Z', descripcion: 'gas', ...p
  })
  const mesDe = (iso: string) => iso.slice(0, 7)

  test('solo gastos vivos del mes: fuera ANULADO, fuera otro mes, fuera ingresos', () => {
    const filas = [
      f({}),
      f({ monto: 50, tipo_movimiento: 'COMPRA_INSUMOS', categoria: 'Insumos', subcategoria: null }),
      f({ status: 'ANULADO' }),
      f({ fecha_movimiento: '2026-10-31T18:00:00Z' }),
      f({ tipo_movimiento: 'INGRESO_VENTA' })
    ]
    const vivos = gastosDelMes(filas, '2026-11', mesDe)
    expect(vivos).toHaveLength(2)
    const t = textoGastos(vivos, 'noviembre de 2026')
    expect(t).toContain('150.00')
    expect(t).toContain('Logística / Gasolina')
    expect(t).toContain('Insumos')
  })

  test('sin gastos: lo dice, no inventa un cero con desglose', () => {
    expect(textoGastos([], 'noviembre de 2026')).toBe('No hay gastos registrados en noviembre de 2026.')
  })

  test('con filtro: solo lo que casa', () => {
    const t = textoGastos([f({}), f({ categoria: 'Renta', subcategoria: null, descripcion: 'local', monto: 900 })], 'noviembre', 'renta')
    expect(t).toContain('900.00')
    expect(t).not.toContain('Gasolina')
  })
})
