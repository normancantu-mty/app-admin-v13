ALTER POLICY detalles_conteo_ins ON public.conteo_detalles
  WITH CHECK (
    COALESCE(public.mi_rol(), '') <> 'SOCIO'
    AND EXISTS (SELECT 1 FROM public.conteos_fisicos c WHERE c.id = conteo_detalles.id_conteo)
  );
