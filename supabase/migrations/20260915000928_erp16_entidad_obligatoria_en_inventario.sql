-- ERP-16: toda ENTRADA de inventario dice a quien, toda SALIDA dice de quien.
-- Aplicada el 2026-09-14 con la palabra de Norman en el chat ("va").
-- Medido contra esta misma base justo antes de aplicar: 484 filas, 466 ya
-- cumplian el invariante, 18 no, y las 18 son ENTRADA_COMPRA del 22 al 26 de
-- mayo de 2026. El invariante no se inventa: se escribe la regla que el sistema
-- ya sigue.
-- NOT VALID: vigila todo INSERT y todo UPDATE desde este segundo y NO revisa
-- las filas viejas, para no reescribir historia por la espalda (regla 6).
-- Espejo en TypeScript: lib/inventario-invariante.ts. Las dos listas son las de
-- lib/inventario-types.ts. ELSE FALSE es deliberado: un tipo que no sea ni
-- entrada ni salida no movería stock en ningún tablero y existiría sin que
-- nadie se enterara, que es la misma falla silenciosa de ERP-16 por otra puerta.

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
  'ERP-16 (2026-09-14): toda ENTRADA trae id_entidad_destino y toda SALIDA trae id_entidad_origen. Sin esto un destino nulo lo leen los tableros como la Matriz (app/dashboard/inventario/page.tsx:237) y la mercancia de un local engorda el stock de la matriz en silencio. Espejo en SQL de lib/inventario-invariante.ts. NOT VALID: no revisa las 18 filas de mayo de 2026 que lo violan; vigila todo lo nuevo.';
