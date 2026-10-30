-- ============================================================================
-- v2 LOCAL: ESQUEMA BASE PREVIO A LAS MIGRACIONES
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- Por que existe: las 9 tablas nucleo del ERP (entidades, cuentas, los dos
-- ledgers, tickets, catalogo, precios, recetas) se crearon en produccion desde
-- el editor SQL, ANTES de la primera migracion (20260512210725). Sin este
-- archivo `supabase db reset` revienta en la migracion 1 ("relation
-- finanzas_ledger does not exist").
-- Fuente: el catalogo de produccion (pg_attribute/pg_constraint/pg_index),
-- leido con SELECT el 2026-10-28, MENOS las columnas y constraints que las
-- migraciones posteriores agregan ellas mismas (metodo_pago,
-- es_entrega_efectivo, es_materia_prima, ml_por_unidad, costo_cero_confirmado,
-- los CHECK de status/tipo y entidad_obligatoria). Los indices los crea
-- 20260903043258_indices_llaves_foraneas.
-- Todo es IF NOT EXISTS: en produccion (donde las tablas ya existen) seria un
-- no-op. Aun asi este proyecto NO se liga a produccion.
--
-- pg_cron: produccion lo tiene; la base local no lo trae activado y 11
-- migraciones llaman cron.schedule(). Se crea aqui. Los jobs que esas
-- migraciones programan llaman a Telegram y a edge functions de PRODUCCION
-- con net.http_post. En local pg_net NO se crea (ver el chequeo en
-- seed_local/00_apagar_cron.sql), asi que un job que se dispare falla con
-- net.http_post del cascaron 20261015164936 (no sale a la red); ademas el seed los
-- desprograma al terminar el reset.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS public.entidades (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  nombre character varying(255) NOT NULL,
  rol character varying(50) NOT NULL,
  id_padre uuid,
  zona character varying(50) NOT NULL,
  ubicacion_maps text,
  telefono character varying(50),
  comision_base numeric(5,2) DEFAULT 0.00,
  comision_base_local numeric(5,2) DEFAULT 0.00,
  comision_hijo_local numeric(5,2) DEFAULT 0.00,
  comision_logistica numeric(5,2) DEFAULT 0.00,
  ultimo_seguimiento timestamp with time zone DEFAULT now(),
  auth_id uuid,
  email text,
  fecha_ultimo_seguimiento timestamp with time zone,
  es_distribuidor boolean DEFAULT false,
  id_nodo_padre uuid,
  aplica_redondeo_costo boolean DEFAULT true,
  CONSTRAINT entidades_pkey PRIMARY KEY (id),
  CONSTRAINT entidades_auth_id_key UNIQUE (auth_id),
  CONSTRAINT entidades_email_key UNIQUE (email),
  CONSTRAINT entidades_id_nodo_padre_fkey FOREIGN KEY (id_nodo_padre) REFERENCES public.entidades(id) ON DELETE SET NULL,
  CONSTRAINT entidades_id_padre_fkey FOREIGN KEY (id_padre) REFERENCES public.entidades(id),
  CONSTRAINT entidades_rol_check CHECK (((rol)::text = ANY ((ARRAY['ADMIN'::character varying, 'DST'::character varying, 'LOC'::character varying, 'SOCIO'::character varying])::text[]))),
  CONSTRAINT entidades_zona_check CHECK (((zona)::text = ANY ((ARRAY['Zacatecas'::character varying, 'Foraneo'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS public.cuentas_financieras (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_entidad uuid,
  nombre character varying(100) NOT NULL,
  tipo_fiscalidad character varying(50) NOT NULL,
  CONSTRAINT cuentas_financieras_pkey PRIMARY KEY (id),
  CONSTRAINT cuentas_financieras_id_entidad_fkey FOREIGN KEY (id_entidad) REFERENCES public.entidades(id),
  CONSTRAINT cuentas_financieras_tipo_fiscalidad_check CHECK (((tipo_fiscalidad)::text = ANY ((ARRAY['LIBRE'::character varying, 'IVA_ONLY'::character varying, 'FULL_TAX'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS public.catalogo_productos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku character varying(100) NOT NULL,
  nombre character varying(255) NOT NULL,
  tipo character varying(50) NOT NULL,
  unidad_medida character varying(50) DEFAULT 'PIEZAS'::character varying,
  costo_unitario numeric(12,2) DEFAULT 0.00,
  CONSTRAINT catalogo_productos_pkey PRIMARY KEY (id),
  CONSTRAINT catalogo_productos_sku_key UNIQUE (sku),
  CONSTRAINT catalogo_productos_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['INSUMO'::character varying, 'TERMINADO'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS public.listas_precios (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_producto uuid,
  zona character varying(50) NOT NULL,
  precio_final numeric(12,2) NOT NULL,
  CONSTRAINT listas_precios_pkey PRIMARY KEY (id),
  CONSTRAINT listas_precios_id_producto_fkey FOREIGN KEY (id_producto) REFERENCES public.catalogo_productos(id),
  CONSTRAINT listas_precios_zona_check CHECK (((zona)::text = ANY ((ARRAY['Zacatecas'::character varying, 'Foraneo'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS public.recetas_produccion (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_producto_terminado uuid,
  id_insumo uuid,
  cantidad_requerida numeric(10,4) NOT NULL,
  CONSTRAINT recetas_produccion_pkey PRIMARY KEY (id),
  CONSTRAINT recetas_produccion_id_insumo_fkey FOREIGN KEY (id_insumo) REFERENCES public.catalogo_productos(id),
  CONSTRAINT recetas_produccion_id_producto_terminado_fkey FOREIGN KEY (id_producto_terminado) REFERENCES public.catalogo_productos(id)
);

CREATE TABLE IF NOT EXISTS public.transacciones_tickets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_vendedor uuid,
  id_comprador uuid,
  id_cuenta_destino uuid,
  subtotal_catalogo numeric(12,2) NOT NULL,
  total_cobrado_real numeric(12,2) NOT NULL,
  monto_base_ingreso numeric(12,2) NOT NULL,
  impuesto_iva_calculado numeric(12,2) DEFAULT 0,
  impuesto_ieps_calculado numeric(12,2) DEFAULT 0,
  bonificacion_cascada_generada numeric(12,2) DEFAULT 0,
  fecha_transaccion timestamp with time zone DEFAULT now(),
  usuario_creador text,
  condicion_pago text NOT NULL DEFAULT 'CONTADO'::text,
  status character varying(50) DEFAULT 'ACTIVO'::character varying,
  CONSTRAINT transacciones_tickets_pkey PRIMARY KEY (id),
  CONSTRAINT transacciones_tickets_id_comprador_fkey FOREIGN KEY (id_comprador) REFERENCES public.entidades(id),
  CONSTRAINT transacciones_tickets_id_cuenta_destino_fkey FOREIGN KEY (id_cuenta_destino) REFERENCES public.cuentas_financieras(id),
  CONSTRAINT transacciones_tickets_id_vendedor_fkey FOREIGN KEY (id_vendedor) REFERENCES public.entidades(id),
  CONSTRAINT check_condicion_pago CHECK ((condicion_pago = ANY (ARRAY['CONTADO'::text, 'CONCESION'::text]))),
  CONSTRAINT transacciones_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVO'::character varying, 'ANULADO'::character varying])::text[])))
);

CREATE TABLE IF NOT EXISTS public.ticket_detalles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_ticket uuid,
  id_producto uuid,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  subtotal_linea numeric(12,2) NOT NULL,
  CONSTRAINT ticket_detalles_pkey PRIMARY KEY (id),
  CONSTRAINT ticket_detalles_id_producto_fkey FOREIGN KEY (id_producto) REFERENCES public.catalogo_productos(id),
  CONSTRAINT ticket_detalles_id_ticket_fkey FOREIGN KEY (id_ticket) REFERENCES public.transacciones_tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.finanzas_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_cuenta_origen uuid,
  id_cuenta_destino uuid,
  id_ticket uuid,
  tipo_movimiento character varying(50),
  monto numeric(12,2) NOT NULL,
  categoria character varying(100),
  es_recurrente boolean DEFAULT false,
  fecha_movimiento timestamp with time zone DEFAULT now(),
  id_entidad_relacionada uuid,
  categoria_gasto text,
  status text NOT NULL DEFAULT 'ACTIVO'::text,
  descripcion text,
  subcategoria text,
  usuario_creador text,
  CONSTRAINT finanzas_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT finanzas_ledger_id_cuenta_destino_fkey FOREIGN KEY (id_cuenta_destino) REFERENCES public.cuentas_financieras(id),
  CONSTRAINT finanzas_ledger_id_cuenta_origen_fkey FOREIGN KEY (id_cuenta_origen) REFERENCES public.cuentas_financieras(id),
  CONSTRAINT finanzas_ledger_id_entidad_relacionada_fkey FOREIGN KEY (id_entidad_relacionada) REFERENCES public.entidades(id),
  CONSTRAINT finanzas_ledger_id_ticket_fkey FOREIGN KEY (id_ticket) REFERENCES public.transacciones_tickets(id)
);

CREATE TABLE IF NOT EXISTS public.inventario_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  id_producto uuid NOT NULL,
  id_entidad_origen uuid,
  id_entidad_destino uuid,
  tipo_movimiento character varying(50) NOT NULL,
  cantidad numeric(10,4) NOT NULL,
  costo_unitario_movimiento numeric(12,2) DEFAULT 0.00,
  notas text,
  fecha_movimiento timestamp with time zone DEFAULT now(),
  usuario_creador text,
  cubeta text NOT NULL DEFAULT 'PAGADO'::text,
  status text NOT NULL DEFAULT 'ACTIVO'::text,
  CONSTRAINT inventario_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT inventario_ledger_id_entidad_destino_fkey FOREIGN KEY (id_entidad_destino) REFERENCES public.entidades(id),
  CONSTRAINT inventario_ledger_id_entidad_origen_fkey FOREIGN KEY (id_entidad_origen) REFERENCES public.entidades(id),
  CONSTRAINT inventario_ledger_id_producto_fkey FOREIGN KEY (id_producto) REFERENCES public.catalogo_productos(id),
  CONSTRAINT chk_coherencia_cubeta CHECK (((((tipo_movimiento)::text = 'ENTRADA_CONCESION'::text) AND (cubeta = 'CONSIGNADO'::text)) OR ((tipo_movimiento)::text <> 'ENTRADA_CONCESION'::text))),
  CONSTRAINT inventario_ledger_cubeta_check CHECK ((cubeta = ANY (ARRAY['PAGADO'::text, 'CONSIGNADO'::text])))
);

-- Funcion que existia antes de las migraciones y que 20260903043023 borra.
-- 20260902000944 y 20260902001110 le revocan EXECUTE: necesitan que exista.
-- Aqui es un cascaron vacio (no se puede reconstruir: produccion ya no la tiene).
CREATE OR REPLACE FUNCTION public.registrar_logistica_inversa(uuid, numeric, text, uuid, uuid, numeric, text)
RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
