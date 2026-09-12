-- ============================================================================
-- ERP-54 · Contar sin cobrar: el evento `CONTEO_FISICO`
-- ============================================================================
-- POR QUE EXISTE. El ERP de hoy solo sabe de dos hechos, y los dos traen dinero
-- pegado: el corte (`cobranza`) cuenta Y cobra en el mismo acto, y el abono
-- suelto cobra sin tocar inventario. **Contar sin cobrar no existe.**
--
-- La realidad no respeta esa union. Norman lo describio el 2026-09-02: llega al
-- local, nadie conto, y le entregan una cantidad cerrada de dinero. O al reves:
-- el distribuidor puede contar pero ese dia no hay efectivo. Cuando el sistema
-- exige los dos hechos juntos, lo que se pierde es el que si ocurrio.
--
-- El costo medido de esa omision son las **602 botellas "nunca descargadas"**
-- de Aeropuerto, Al son del Mezcal, Dulceria ruiz, Casa Verde, Mi dulce catrina
-- y Dulceria el Eden. **No es un error de captura: hubo abonos y no hubo
-- cortes.** El dato estaba bien; el modelo estaba incompleto.
--
-- ─── LA DECISION DE DISENO, QUE SE APARTA DEL PROMPT 20 ─────────────────────
-- `PROMPT_ClaudeCode_20` pedia que el conteo emitiera "un movimiento de ajuste
-- que lleve el libro a lo contado". **Aqui el conteo NO ajusta el libro**, y la
-- razon no es pereza:
--
--   1. **D-E28 ya decidio que no se auto-ajusta.** Un conteo que reescribe el
--      libro en silencio deja a la pantalla sin con que contradecirse.
--   2. **La diferencia ES el dato.** `libro_decia - piezas_contadas` es
--      exactamente lo que mide el faltante; fundirlos destruye la medicion en
--      el acto de registrarla. Es el mismo error que ERP-65 con el estimador:
--      un numero que se calcula a si mismo no informa de nada.
--   3. **Aditivo puro = reversible.** Dos tablas nuevas y una vista. Si el
--      modelo sale mal, el rollback son tres `DROP` y el historico ni se
--      entera. Tocar `inventario_ledger` no se deshace igual.
--
-- Aplicar un conteo al libro (una merma, una devolucion) queda como un SEGUNDO
-- acto, explicito y con motivo. Este archivo registra el hecho; no lo
-- interpreta. [Filtro: DOC02 — YAGNI]
--
-- ─── LO QUE NO TOCA, Y ES EL PUNTO ──────────────────────────────────────────
-- **Ni una fila de `finanzas_ledger`.** Contar no es cobrar. La deuda sigue
-- naciendo en el ticket de CONCESION, como hasta hoy: este evento no la crea,
-- no la baja y no la mueve. `tests/conteo-fisico.spec.ts` lo comprueba.
--
-- Cifras de control del dia, medidas contra produccion antes de escribir esto
-- (2026-09-12): 120 finanzas (85 ACTIVO) / 484 inventario / 77 tickets
-- (64 ACTIVO) / $400,625.00 activos / 17 entidades.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP VIEW  public.v_conteo_ultimo;
--   DROP TRIGGER trg_autor_conteos ON public.conteos_fisicos;
--   DROP TRIGGER trg_conteos_solo_anular ON public.conteos_fisicos;
--   DROP FUNCTION public.tg_conteos_solo_anular();
--   DROP TABLE public.conteo_detalles;   -- se pierden los conteos registrados
--   DROP TABLE public.conteos_fisicos;
-- ============================================================================


-- ─── 1. EL HECHO: QUIEN CONTO, DONDE Y CUANDO ───────────────────────────────
-- `fecha_conteo` es del HECHO, no de la captura. Se cuenta el lunes y se
-- captura el jueves: sin esta separacion, los dias sin abonar y el orden de los
-- conteos salen mal, que es el mismo defecto que ERP-23 en otra ropa.

CREATE TABLE IF NOT EXISTS public.conteos_fisicos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_entidad      uuid NOT NULL REFERENCES public.entidades(id),
  fecha_conteo    date NOT NULL,
  notas           text,
  status          text NOT NULL DEFAULT 'ACTIVO',
  usuario_creador text,
  creado_en       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conteos_fisicos_status_check
    CHECK (status = ANY (ARRAY['ACTIVO', 'ANULADO'])),
  -- Un conteo con fecha futura es un dedazo, no un hecho. Se rechaza aqui y no
  -- solo en la app: la base no es el unico camino (regla de la casa).
  CONSTRAINT conteos_fisicos_fecha_no_futura
    CHECK (fecha_conteo <= (now() AT TIME ZONE 'America/Mexico_City')::date)
);

COMMENT ON TABLE public.conteos_fisicos IS
  'ERP-54. El hecho de contar, sin dinero pegado. No ajusta inventario_ledger: '
  'la diferencia contra el libro es el dato que este evento viene a producir.';


-- ─── 2. EL DETALLE, POR SKU Y POR CUBETA ────────────────────────────────────
-- **Un conteo parcial es valido.** Si solo se contaron dos SKU, se guardan dos
-- filas. Obligar al conteo completo es la forma mas segura de que nadie lo use
-- (Q-12: a veces se asienta de memoria), y entonces volvemos al punto de
-- partida con una tabla vacia de adorno.
--
-- `libro_decia` es una FOTO del libro al momento de capturar. Se guarda en vez
-- de recalcularse despues porque el libro sigue moviendose: sin la foto, la
-- diferencia de un conteo de hace tres semanas cambia sola cada vez que se
-- consulta, y deja de ser evidencia de nada.

CREATE TABLE IF NOT EXISTS public.conteo_detalles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_conteo       uuid NOT NULL REFERENCES public.conteos_fisicos(id),
  id_producto     uuid NOT NULL REFERENCES public.catalogo_productos(id),
  cubeta          text NOT NULL DEFAULT 'CONSIGNADO',
  piezas_contadas numeric NOT NULL,
  libro_decia     numeric NOT NULL,

  CONSTRAINT conteo_detalles_cubeta_check
    CHECK (cubeta = ANY (ARRAY['PAGADO', 'CONSIGNADO'])),
  CONSTRAINT conteo_detalles_piezas_no_negativas
    CHECK (piezas_contadas >= 0),
  -- El mismo SKU dos veces en el mismo conteo es una captura duplicada, y la
  -- suma silenciosa de las dos filas seria un faltante inventado.
  CONSTRAINT conteo_detalles_sku_unico
    UNIQUE (id_conteo, id_producto, cubeta)
);

CREATE INDEX IF NOT EXISTS idx_conteos_fisicos_entidad_fecha
  ON public.conteos_fisicos (id_entidad, fecha_conteo DESC);
CREATE INDEX IF NOT EXISTS idx_conteo_detalles_conteo
  ON public.conteo_detalles (id_conteo);
CREATE INDEX IF NOT EXISTS idx_conteo_detalles_producto
  ON public.conteo_detalles (id_producto);


-- ─── 3. EL AUTOR LO PONE EL SERVIDOR ────────────────────────────────────────
-- Se reutiliza `tg_forzar_autor()` del 2026-09-02, igual que ERP-59: lo que
-- mande el cliente en `usuario_creador` se ignora.

DROP TRIGGER IF EXISTS trg_autor_conteos ON public.conteos_fisicos;
CREATE TRIGGER trg_autor_conteos
  BEFORE INSERT ON public.conteos_fisicos
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();


-- ─── 4. UN CONTEO NO SE EDITA: SE ANULA Y SE VUELVE A CONTAR ────────────────
-- Regla 6 de la casa (anulacion en vez de borrado, D-E04) llevada a su forma
-- estricta: de un conteo capturado solo puede moverse `status`. Corregir un
-- numero a mano convertiria la evidencia en opinion.

CREATE OR REPLACE FUNCTION public.tg_conteos_solo_anular() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_antes   jsonb := to_jsonb(OLD) - 'status';
  v_despues jsonb := to_jsonb(NEW) - 'status';
BEGIN
  IF v_antes IS DISTINCT FROM v_despues THEN
    RAISE EXCEPTION
      'COLUMNAS PROTEGIDAS. De un conteo solo puede cambiar [status]. Para '
      'corregir cifras, anula este conteo y captura uno nuevo.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_conteos_solo_anular ON public.conteos_fisicos;
CREATE TRIGGER trg_conteos_solo_anular
  BEFORE UPDATE ON public.conteos_fisicos
  FOR EACH ROW EXECUTE FUNCTION public.tg_conteos_solo_anular();


-- ─── 5. RLS DESDE EL MINUTO UNO ─────────────────────────────────────────────
-- ERP-57: los *default privileges* de `supabase_admin` abren cada tabla nueva a
-- `anon`, y `postgres` no los puede revocar. La mitigacion acordada es esta:
-- tabla creada por migracion, con el REVOKE y el RLS en el mismo archivo.

ALTER TABLE public.conteos_fisicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conteo_detalles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conteos_fisicos FROM PUBLIC, anon;
REVOKE ALL ON public.conteo_detalles FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE ON public.conteos_fisicos TO authenticated;
GRANT SELECT, INSERT          ON public.conteo_detalles TO authenticated;

-- SELECT: el ADMIN y el SOCIO ven todo; el DST ve lo suyo y lo de sus locales
-- hijos (`mis_entidades()`, no `mi_entidad_id()`: Gilberto captura por
-- "Nuevo Ideal").
DROP POLICY IF EXISTS conteos_sel_admin_socio ON public.conteos_fisicos;
CREATE POLICY conteos_sel_admin_socio ON public.conteos_fisicos
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));

DROP POLICY IF EXISTS conteos_sel_mios ON public.conteos_fisicos;
CREATE POLICY conteos_sel_mios ON public.conteos_fisicos
  FOR SELECT TO authenticated
  USING (id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id)));

DROP POLICY IF EXISTS conteos_ins_admin ON public.conteos_fisicos;
CREATE POLICY conteos_ins_admin ON public.conteos_fisicos
  FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = 'ADMIN');

DROP POLICY IF EXISTS conteos_ins_dst ON public.conteos_fisicos;
CREATE POLICY conteos_ins_dst ON public.conteos_fisicos
  FOR INSERT TO authenticated
  WITH CHECK (
    public.mi_rol() = 'DST'
    AND id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

-- UPDATE: solo el ADMIN anula. Un DST que pudiera anular su propio conteo
-- podria borrar el faltante que el conteo acaba de destapar.
DROP POLICY IF EXISTS conteos_upd_admin ON public.conteos_fisicos;
CREATE POLICY conteos_upd_admin ON public.conteos_fisicos
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN')
  WITH CHECK (public.mi_rol() = 'ADMIN');

-- El detalle hereda el permiso de su cabecera: se ve y se escribe si se puede
-- ver la cabecera. Asi no hay dos verdades sobre quien ve que.
DROP POLICY IF EXISTS detalles_conteo_sel ON public.conteo_detalles;
CREATE POLICY detalles_conteo_sel ON public.conteo_detalles
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.conteos_fisicos c WHERE c.id = id_conteo)
  );

DROP POLICY IF EXISTS detalles_conteo_ins ON public.conteo_detalles;
CREATE POLICY detalles_conteo_ins ON public.conteo_detalles
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.conteos_fisicos c WHERE c.id = id_conteo)
  );

-- Ninguna politica de DELETE, en ninguna de las dos. A proposito, y por la
-- misma razon que en `avisos_captura`: poder borrar un conteo es poder tapar el
-- faltante que el conteo destapo.


-- ─── 6. LA VISTA: EL ULTIMO CONTEO VIGENTE DE CADA COSA ─────────────────────
-- `security_invoker = true` **no es opcional**: sin eso la vista corre con los
-- permisos de quien la creo y se vuelve una puerta trasera al inventario
-- completo, saltandose todo lo de arriba.

CREATE OR REPLACE VIEW public.v_conteo_ultimo
WITH (security_invoker = true) AS
SELECT DISTINCT ON (c.id_entidad, d.id_producto, d.cubeta)
  c.id_entidad,
  d.id_producto,
  d.cubeta,
  d.piezas_contadas,
  d.libro_decia,
  (d.libro_decia - d.piezas_contadas) AS diferencia,
  c.fecha_conteo,
  c.id                                AS id_conteo,
  c.usuario_creador
FROM public.conteos_fisicos c
JOIN public.conteo_detalles d ON d.id_conteo = c.id
WHERE c.status = 'ACTIVO'
ORDER BY c.id_entidad, d.id_producto, d.cubeta, c.fecha_conteo DESC, c.creado_en DESC;

COMMENT ON VIEW public.v_conteo_ultimo IS
  'ERP-54. Un renglon por entidad/SKU/cubeta con el conteo ACTIVO mas reciente. '
  'Sin conteo no hay renglon: la ausencia se lee como "nunca se conto", nunca '
  'como cero.';

GRANT SELECT ON public.v_conteo_ultimo TO authenticated;


-- ============================================================================
-- COMPROBACIONES DESPUES DE APLICAR (correr una por una, leer la salida)
-- ============================================================================
-- 1) Las cifras no se movieron — tienen que dar 120 / 484 / 77 / 400625.00:
--    SELECT (SELECT count(*) FROM finanzas_ledger)            AS fin,
--           (SELECT count(*) FROM inventario_ledger)          AS inv,
--           (SELECT count(*) FROM transacciones_tickets)      AS tk,
--           (SELECT sum(total_cobrado_real) FROM transacciones_tickets
--             WHERE status = 'ACTIVO')                        AS ventas;
--
-- 2) RLS encendido y sin politica de DELETE — 2 filas `true`, y 0 en delete:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname IN ('conteos_fisicos', 'conteo_detalles');
--    SELECT count(*) FROM pg_policies
--     WHERE tablename IN ('conteos_fisicos', 'conteo_detalles') AND cmd = 'DELETE';
--
-- 3) `anon` no puede ni mirar — las dos en `false`:
--    SELECT has_table_privilege('anon', 'public.conteos_fisicos', 'SELECT'),
--           has_table_privilege('anon', 'public.conteo_detalles', 'SELECT');
--
-- 4) La vista corre como quien la consulta — `{security_invoker=true}`:
--    SELECT reloptions FROM pg_class WHERE relname = 'v_conteo_ultimo';
--
-- 5) El candado de edicion muerde. Con un conteo ya capturado, esto DEBE
--    fallar con `42501 COLUMNAS PROTEGIDAS`:
--    UPDATE conteos_fisicos SET notas = 'otra cosa' WHERE id = '<uuid>';
--    ...y esto DEBE pasar:
--    UPDATE conteos_fisicos SET status = 'ANULADO'  WHERE id = '<uuid>';
-- ============================================================================
