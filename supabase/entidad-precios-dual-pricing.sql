-- ============================================================================
-- MIGRATION: entidad_precios — Dual Pricing upgrade
-- Run this ONLY if entidad_precios was already created with precio_base_acordado
-- (i.e. the original entidad-precios.sql was applied before this change).
-- Safe to run multiple times (IF EXISTS / IF NOT EXISTS guards throughout).
-- ============================================================================

-- Drop the old single-price column and add the two fiscality-aware columns.
ALTER TABLE public.entidad_precios
  DROP   COLUMN IF EXISTS precio_base_acordado,
  ADD    COLUMN IF NOT EXISTS precio_efectivo  numeric(10,4) NOT NULL DEFAULT 0
           CHECK (precio_efectivo  >= 0),
  ADD    COLUMN IF NOT EXISTS precio_facturado numeric(10,4) NOT NULL DEFAULT 0
           CHECK (precio_facturado >= 0);
