/**
 * Paginas v2 — `/panel/catalogo`: el catalogo COMPLETO con todos sus detalles.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * El modal `/panel/m/precios` es la vista rapida desde el panel; aqui va todo:
 * el waterfall de precios con su selector Distribuidor/Local (el mismo
 * `PreciosVista`), y para la matriz los productos con sus datos, la lista de
 * precios por zona y las recetas de produccion.
 *
 * Roles: ADMIN y SOCIO ven todo (solo lectura: esta pagina no escribe). El DST y
 * el LOC ven solo sus precios (lo mismo que su modal «Precios para mí»); los
 * costos de insumos y las recetas son de la matriz. SUB-ADMIN no tiene catalogo.
 *
 * FALLA CERRADA: si una lectura falla se dice, no se pinta una tabla vacia.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { getServerSupabaseClient } from '@/lib/server-session'
import { mxn, num } from '@/lib/v2/formato'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { PreciosVista, rolDePrecios, type SpPrecios } from '@/components/v2/precios/PreciosVista'

export const dynamic = 'force-dynamic'

type Producto = {
  id: string
  sku: string
  nombre: string
  tipo: string
  unidad_medida: string | null
  costo_unitario: number | null
  ml_por_unidad: number | null
  es_materia_prima: boolean
}
type Precio = { id_producto: string | null; zona: string; precio_final: number }
type Receta = { id: string; id_producto_terminado: string | null; id_insumo: string | null; cantidad_requerida: number }

export default async function CatalogoV2({ searchParams }: { searchParams: Promise<SpPrecios> }) {
  const usuario = await exigirSesionV2()
  if (usuario.rol === 'SUB-ADMIN') notFound()
  const sp = await searchParams
  const mando = rolDePrecios(usuario.rol) === 'ADMIN'

  let productos: Producto[] = []
  let precios: Precio[] = []
  let recetas: Receta[] = []
  let errorLectura: string | null = null
  if (mando) {
    const supabase = await getServerSupabaseClient()
    const [p, l, r] = await Promise.all([
      supabase.from('catalogo_productos').select('id, sku, nombre, tipo, unidad_medida, costo_unitario, ml_por_unidad, es_materia_prima').order('tipo', { ascending: false }).order('nombre', { ascending: true }),
      supabase.from('listas_precios').select('id_producto, zona, precio_final'),
      supabase.from('recetas_produccion').select('id, id_producto_terminado, id_insumo, cantidad_requerida')
    ])
    errorLectura = p.error?.message ?? l.error?.message ?? r.error?.message ?? null
    productos = (p.data ?? []) as Producto[]
    precios = (l.data ?? []) as Precio[]
    recetas = (r.data ?? []) as Receta[]
  }

  const porId = new Map(productos.map((p) => [p.id, p]))
  const zonas = [...new Set(precios.map((x) => x.zona))].sort((a, b) => a.localeCompare(b, 'es'))
  const precio = new Map(precios.map((x) => [`${x.id_producto}|${x.zona}`, Number(x.precio_final)]))
  const terminados = productos.filter((p) => p.tipo === 'TERMINADO')
  const recetasPorProducto = new Map<string, Receta[]>()
  for (const r of recetas) {
    if (!r.id_producto_terminado) continue
    recetasPorProducto.set(r.id_producto_terminado, [...(recetasPorProducto.get(r.id_producto_terminado) ?? []), r])
  }

  return (
    <>
      <EncabezadoPagina
        titulo={mando ? 'Catálogo' : 'Mis precios'}
        sub={mando ? 'Productos, precios por zona, waterfall y recetas' : 'Waterfall de precio: público, impuestos, tu costo y lo que ganas'}
      />

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Precios por canal</h2>
            <div className="sub">Waterfall: público, impuestos, tu costo y lo que ganas. {mando ? 'Elige Distribuidor o Local y una entidad para simular su precio.' : ''}</div>
          </div>
        </div>
        <PreciosVista usuario={usuario} sp={sp} ruta={`${RUTA_BASE}/catalogo`} />
        <div className="fuente">catalogo_productos (TERMINADO) · listas_precios · calculateWaterfall</div>
      </section>

      {mando && errorLectura && <div className="msg mal">No se pudo leer el catálogo completo: {errorLectura}</div>}

      {mando && !errorLectura && (
        <>
          <section className="card" style={{ marginBottom: 16 }} data-testid="catalogo-zonas">
            <div className="hd">
              <div>
                <h2>Lista de precios por zona</h2>
                <div className="sub">Precio final al público de cada producto terminado en cada zona. «—» = sin precio en esa zona.</div>
              </div>
            </div>
            {zonas.length === 0 ? (
              <div className="vacio">
                <b>Sin precios cargados</b>
              </div>
            ) : (
              <div className="tabla-w">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      {zonas.map((z) => (
                        <th key={z} className="r">
                          {z}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {terminados.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <b>{p.nombre}</b>
                        </td>
                        {zonas.map((z) => {
                          const v = precio.get(`${p.id}|${z}`)
                          return (
                            <td key={z} className="r">
                              {v === undefined ? '—' : mxn(v)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="fuente">listas_precios · {precios.length} filas · {zonas.length} zonas</div>
          </section>

          <section className="card" style={{ marginBottom: 16 }} data-testid="catalogo-productos">
            <div className="hd">
              <div>
                <h2>Productos</h2>
                <div className="sub">Terminados e insumos con su unidad y su costo unitario.</div>
              </div>
            </div>
            <div className="tabla-w">
              <table className="t">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Producto</th>
                    <th>Tipo</th>
                    <th>Unidad</th>
                    <th className="r">ml por unidad</th>
                    <th className="r">Costo unitario</th>
                  </tr>
                </thead>
                <tbody>
                  {productos.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.sku}</td>
                      <td>
                        <b>{p.nombre}</b>
                      </td>
                      <td>
                        <span className={`chip ${p.tipo === 'TERMINADO' ? 'chile' : ''}`}>{p.tipo === 'TERMINADO' ? 'Terminado' : p.es_materia_prima ? 'Materia prima' : 'Insumo'}</span>
                      </td>
                      <td>{p.unidad_medida ?? '—'}</td>
                      <td className="r">{p.ml_por_unidad === null ? '—' : num(Number(p.ml_por_unidad))}</td>
                      <td className="r">{p.costo_unitario === null ? 'Sin dato' : mxn(Number(p.costo_unitario))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fuente">catalogo_productos · {productos.length} productos</div>
          </section>

          <section className="card" data-testid="catalogo-recetas">
            <div className="hd">
              <div>
                <h2>Recetas de producción</h2>
                <div className="sub">Insumos que consume cada producto terminado al envasar.</div>
              </div>
            </div>
            {recetasPorProducto.size === 0 ? (
              <div className="vacio">
                <b>Sin recetas registradas</b>
                recetas_produccion no tiene filas.
              </div>
            ) : (
              <div className="grid g2" style={{ marginBottom: 0 }}>
                {[...recetasPorProducto.entries()].map(([idTerm, filas]) => (
                  <div key={idTerm} className="card">
                    <h3>{porId.get(idTerm)?.nombre ?? 'Producto sin dato'}</h3>
                    {filas.map((r) => {
                      const ins = r.id_insumo ? porId.get(r.id_insumo) : undefined
                      return (
                        <div key={r.id} className="subl" style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
                          <span>{ins?.nombre ?? 'Insumo sin dato'}</span>
                          <span className="mono">
                            {num(Number(r.cantidad_requerida))} {ins?.unidad_medida ?? ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            <div className="fuente">recetas_produccion · {recetas.length} filas</div>
          </section>
        </>
      )}
    </>
  )
}
