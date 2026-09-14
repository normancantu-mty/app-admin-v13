-- ===========================================================================
--  ERP-16 · un movimiento de inventario SIEMPRE dice de quien es el stock
-- ===========================================================================
--  Escrito el 2026-09-14 por el Socio.  **ESTA MIGRACION NO ESTA APLICADA.**
--
--  Es restrictiva: pone un candado sobre una tabla con 484 filas vivas. La
--  regla vigente de Norman es que eso se escribe y NO se ejecuta. Quien decide
--  cuando apretarlo es el. Ver `LEEME.md` en esta carpeta para el porque de que
--  el archivo viva aqui y no en `supabase/migrations/`.
--
--  CUANDO SE APLIQUE: con `apply_migration` del MCP de Supabase.
--  **NUNCA con `supabase db push`** (ERP-73).
--
-- ---------------------------------------------------------------------------
--  1. QUE ESTA MAL HOY
-- ---------------------------------------------------------------------------
--  `app/actions/compras.ts` y `app/actions/devoluciones.ts` escribian
--  `ENTRADA_COMPRA` sin `id_entidad_destino`. El codigo ya esta arreglado y
--  tiene su puerta (`lib/inventario-invariante.ts`) y su centinela
--  (`tests/inventario-invariante.spec.ts`). Esto es la tercera capa: el juez
--  que no depende de que nadie se acuerde.
--
--  Y el defecto NO era el que decia el ticket. El ticket suponia que el tablero
--  descartaba las filas sin destino. Es al reves, y es peor
--  -`app/dashboard/inventario/page.tsx:237`-:
--
--      const destinoEsAdmin = !destino || destino.rol === 'ADMIN'
--
--  Un destino NULO se lee **como si fuera la Matriz**. No se descarta: se
--  cuenta mal, y el numero se ve perfectamente normal. Con una sola entidad
--  ADMIN el default acierta por accidente; el dia que un local capture su
--  propia compra, el inventario de la Matriz sube por mercancia que nunca
--  estuvo ahi, sin un error y sin un aviso.
--
-- ---------------------------------------------------------------------------
--  2. LA MEDICION QUE JUSTIFICA EL CANDADO
-- ---------------------------------------------------------------------------
--  Corrida el 2026-09-14 contra la base `gnnqxtsdrbvmlkhfemjw`, con EXACTAMENTE
--  el predicado que esta mas abajo -no con uno parecido-:
--
--      filas totales ......... 484
--      pasan ................. 466
--      violan ................  18   (14 ACTIVO + 4 ANULADO)
--      tipos que violan ......   1   -> ENTRADA_COMPRA, y solo ese
--
--  Las 18 son todas del 22 al 26 de mayo de 2026. Desde entonces no ha nacido
--  ni una. **El invariante no se esta inventando: 466 de 484 filas ya lo
--  cumplen.** Se esta escribiendo la regla que el sistema ya sigue.
--
-- ---------------------------------------------------------------------------
--  3. POR QUE `NOT VALID`, Y POR QUE ESO NO ES UNA CONCESION
-- ---------------------------------------------------------------------------
--  `NOT VALID` en Postgres significa: **se aplica a todo INSERT y a todo UPDATE
--  desde este segundo**, y no se revisan las filas que ya estaban. O sea que
--  cierra el agujero COMPLETO hacia adelante sin tocar historia, que es
--  precisamente la regla 6 de Norman: lo viejo no se borra ni se reescribe por
--  la espalda.
--
--  Las 18 filas viejas siguen ahi, visibles y contables. Que hacer con ellas es
--  una decision de negocio -de Norman, no del agente- y esta en el paso 5.
--
-- ---------------------------------------------------------------------------
--  4. EL CANDADO
-- ---------------------------------------------------------------------------
--  Las dos listas son las mismas de `lib/inventario-types.ts`
--  (TIPOS_MOVIMIENTO_ENTRADA y TIPOS_MOVIMIENTO_SALIDA). **Estan duplicadas en
--  dos idiomas, y eso es una deuda real**, la misma forma del problema que ya
--  mordio en el catalogo de categorias (`lib/catalog-constants.ts` contra
--  `bot/extraer.py`, que ya divergieron). Aqui la divergencia es MENOS cara
--  porque Postgres seria el estricto: si TypeScript agrega un tipo y no lo
--  agrega aqui, el INSERT falla en la cara, ruidosamente. Es el modo de fallo
--  correcto para esta pareja.
--
--  `ELSE FALSE` es deliberado: un tipo que no es ni entrada ni salida no mueve
--  stock en ningun tablero, asi que una fila asi existiria sin hacer nada y sin
--  que nadie se entere. Es la misma falla silenciosa de ERP-16 por otra puerta.
--  Hoy el unico tipo en esa situacion es `LIQUIDACION_INTERNA`, que esta en el
--  enum de TypeScript, en ninguna de las dos listas, y en cero filas de la base.
--  `lib/inventario-invariante.ts` lo rechaza igual: una sola regla, dos jueces.
--  (Si algun dia se quiere permisivo, es cambiar `ELSE FALSE` por `ELSE TRUE`
--  aqui Y quitar la rama equivalente alla. Las dos, o ninguna.)

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_entidad_obligatoria
  CHECK (
    CASE
      WHEN tipo_movimiento IN (
        'ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA',
        'INGRESO_TRASPASO', 'ENTRADA_CONCESION'
      ) THEN id_entidad_destino IS NOT NULL

      WHEN tipo_movimiento IN (
        'SALIDA_VENTA', 'MERMA', 'TRASPASO',
        'EGRESO_TRASPASO', 'SALIDA_CONCESION'
      ) THEN id_entidad_origen IS NOT NULL

      ELSE FALSE
    END
  )
  NOT VALID;

COMMENT ON CONSTRAINT inventario_ledger_entidad_obligatoria ON public.inventario_ledger IS
  'ERP-16 (2026-09-14): toda ENTRADA trae id_entidad_destino y toda SALIDA trae '
  'id_entidad_origen. Sin esto, un destino nulo lo leen los tableros como la Matriz '
  '(app/dashboard/inventario/page.tsx) y la mercancia de un local engorda el stock de '
  'la matriz en silencio. Espejo en SQL de lib/inventario-invariante.ts. NOT VALID: no '
  'revisa las 18 filas de mayo de 2026 que lo violan; vigila todo lo nuevo.';

-- ---------------------------------------------------------------------------
--  5. COMPROBACION, PARA CORRER JUSTO DESPUES DE APLICAR
-- ---------------------------------------------------------------------------
--  (a) El candado existe y esta sin validar -lo esperado-:
--
--      SELECT conname, convalidated
--      FROM pg_constraint
--      WHERE conname = 'inventario_ledger_entidad_obligatoria';
--      -- convalidated = false  <- correcto
--
--  (b) CONTROL POSITIVO. Tiene que FALLAR con 23514 (check_violation). Si esto
--      pasa, el candado no esta haciendo nada y todo lo de arriba es decorado:
--
--      BEGIN;
--        INSERT INTO public.inventario_ledger (id_producto, tipo_movimiento, cantidad, usuario_creador)
--        SELECT id, 'ENTRADA_COMPRA', 1, 'prueba-erp16'
--        FROM public.catalogo_productos LIMIT 1;
--      ROLLBACK;
--
--  (c) CONTROL NEGATIVO. La misma fila CON destino tiene que entrar. Sin este,
--      un candado que rechazara todo daria el mismo "PASA" en (b):
--
--      BEGIN;
--        INSERT INTO public.inventario_ledger (id_producto, tipo_movimiento, cantidad, usuario_creador, id_entidad_destino)
--        SELECT p.id, 'ENTRADA_COMPRA', 1, 'prueba-erp16', e.id
--        FROM public.catalogo_productos p, public.entidades e
--        WHERE e.rol = 'ADMIN' LIMIT 1;
--      ROLLBACK;
--
--  (d) Que las 18 viejas sigan intactas: 484 filas, 18 en violacion.
--
-- ---------------------------------------------------------------------------
--  6. LAS 18 FILAS VIEJAS — DECISION DE NORMAN, NO DEL SOCIO
-- ---------------------------------------------------------------------------
--  Todas son `ENTRADA_COMPRA` del 22 al 26 de mayo de 2026: 14 ACTIVO y 4
--  ANULADO. Hoy los tableros ya las cuentan como Matriz por el default nulo, asi
--  que ponerles el destino de la entidad ADMIN **no mueve ni una cifra en
--  pantalla**: solo hace explicito lo que ya se estaba suponiendo.
--
--  Hay exactamente una entidad ADMIN ("CEO Admin"), asi que no hay ambiguedad
--  sobre cual seria. Aun asi es reescribir historia, y eso no lo decide el
--  agente. **NADA DE ESTO SE EJECUTA SIN QUE NORMAN LO DIGA.**
--
--      -- UPDATE public.inventario_ledger AS il
--      -- SET    id_entidad_destino = (SELECT id FROM public.entidades WHERE rol = 'ADMIN' LIMIT 1)
--      -- WHERE  il.tipo_movimiento = 'ENTRADA_COMPRA'
--      --   AND  il.id_entidad_destino IS NULL;
--      -- -- esperado: UPDATE 18
--
--  Solo DESPUES de ese backfill tiene sentido cerrar el circulo:
--
--      -- ALTER TABLE public.inventario_ledger
--      --   VALIDATE CONSTRAINT inventario_ledger_entidad_obligatoria;
--
--  Mientras no se valide, el candado protege todo lo nuevo igual. No hay prisa.
