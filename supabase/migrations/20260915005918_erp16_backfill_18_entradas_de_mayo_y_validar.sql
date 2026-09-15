-- ERP-16, segunda mitad: las 18 ENTRADA_COMPRA de mayo de 2026 dicen a quien,
-- y el candado pasa de NOT VALID a validado.
--
-- Aplicada el 2026-09-14 con la palabra de Norman en el chat ("(a) El backfill,
-- pues si haz esto"). La primera mitad -el CHECK NOT VALID- es
-- 20260915000928_erp16_entidad_obligatoria_en_inventario.
--
-- POR QUE ESTO NO MUEVE NI UNA CIFRA EN PANTALLA. Los tableros ya leian el
-- destino nulo COMO la Matriz (app/dashboard/inventario/page.tsx:237:
-- `const destinoEsAdmin = !destino || destino.rol === 'ADMIN'`). Este UPDATE
-- hace explicito lo que el sistema ya suponia. Hay EXACTAMENTE una entidad con
-- rol ADMIN ("CEO Admin"), medido justo antes de aplicar, asi que no hay
-- eleccion que hacer.
--
-- POR QUE NO SE ANULARON, que era la otra lectura. Norman recordaba que esas
-- filas eran pruebas de cuando construyo el sistema. Se midio y no: para los 13
-- insumos que tocan -botellas, etiquetas, corchos, tapas, lamina de plata, luz
-- LED- las entradas TOTALES de cada producto son exactamente las de estas 18
-- filas. Son la unica compra que esos productos han tenido en la vida del ERP:
-- el inventario inicial de empaque. Anularlas habria mandado los 13 a negativo.
--
-- LA GUARDA. Si el UPDATE no toca exactamente 18 filas, esta migracion se cae
-- entera y no cambia nada. Un backfill que toca de mas es peor que uno que no
-- corre: reescribe historia que nadie reviso.

DO $erp16$
DECLARE
  v_admin   uuid;
  v_tocadas integer;
BEGIN
  SELECT id INTO v_admin FROM public.entidades WHERE rol = 'ADMIN' LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'ERP-16: no hay entidad con rol ADMIN. Nada que rellenar.';
  END IF;

  UPDATE public.inventario_ledger
     SET id_entidad_destino = v_admin
   WHERE tipo_movimiento = 'ENTRADA_COMPRA'
     AND id_entidad_destino IS NULL;

  GET DIAGNOSTICS v_tocadas = ROW_COUNT;

  IF v_tocadas <> 18 THEN
    RAISE EXCEPTION 'ERP-16: esperaba 18 filas y toque %. Se revierte todo.', v_tocadas;
  END IF;

  RAISE NOTICE 'ERP-16: % filas rellenadas con la entidad ADMIN.', v_tocadas;
END
$erp16$;

-- Ahora si: el candado deja de ser "vigila lo nuevo" y pasa a "toda la tabla lo
-- cumple". Si quedara una sola fila en violacion, este VALIDATE falla y el
-- UPDATE de arriba se revierte con el, porque van en la misma transaccion.
ALTER TABLE public.inventario_ledger
  VALIDATE CONSTRAINT inventario_ledger_entidad_obligatoria;
