-- v2 LOCAL, T5 (2026-10-29, Socio ejecutor): montaje de la prueba de flujos. SOLO base local.
-- DST Prueba vende con 20% de comision para que la venta de contado del DST parta en
-- INGRESO_COMISION + DEUDA_A_MATRIZ (con 0% solo saldria DEUDA_A_MATRIZ).
UPDATE entidades SET comision_base = 0.20 WHERE id = 'd5000000-0000-4000-a000-000000000001' RETURNING nombre, comision_base;
