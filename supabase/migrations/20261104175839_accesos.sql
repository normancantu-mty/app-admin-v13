CREATE TABLE public.accesos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  etiqueta    text NOT NULL UNIQUE CHECK (etiqueta ~ '^[a-z0-9_-]{2,24}$'),
  rol         text NOT NULL CHECK (rol IN ('ADMIN', 'SOCIO')),
  id_entidad  uuid NOT NULL REFERENCES public.entidades (id),
  auth_id     uuid UNIQUE REFERENCES auth.users (id) ON DELETE SET NULL,
  activo      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accesos IS
  'Login -> rol y entidad desde la que opera. Separa el acceso de la entidad comercial. Solo escribe el rol de servicio.';

ALTER TABLE public.accesos ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mi_entidad_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT id_entidad FROM accesos WHERE auth_id = auth.uid() AND activo),
    (SELECT id FROM entidades WHERE auth_id = auth.uid())
  )
$function$;

CREATE OR REPLACE FUNCTION public.mi_rol()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT rol FROM accesos WHERE auth_id = auth.uid() AND activo),
    (SELECT rol FROM entidades WHERE id = public.mi_entidad_id())
  )
$function$;

CREATE POLICY accesos_lectura ON public.accesos
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid() OR public.mi_rol() IN ('ADMIN', 'SOCIO'));

GRANT SELECT ON public.accesos TO authenticated;
