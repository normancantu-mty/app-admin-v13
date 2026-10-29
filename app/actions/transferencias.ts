'use server'

/**
 * v2: conversion de la cuenta Transferencias a Efectivo.
 *
 * Toda la aritmetica vive en SQL (`public.convertir_transferencias`, migracion
 * 20261028120300): comision = round(M * pct / 100, 2), neto = M - comision, tres
 * filas de finanzas_ledger y una de conversiones_transferencia en la misma
 * transaccion. Aqui solo se valida la sesion y se pasa el monto.
 */
import { revalidatePath } from 'next/cache'
import { getServerSupabaseClient, resolverSesionOperador } from '@/lib/server-session'

export type ConversionResult =
  | { success: true; id: string; monto: number; comision: number; neto: number; pct: number }
  | { success: false; error: string }

export async function convertirTransferenciasAction(monto: number, nota?: string): Promise<ConversionResult> {
  try {
    const supabase = await getServerSupabaseClient()
    const resultado = await resolverSesionOperador(supabase)
    if (!resultado.ok) return { success: false, error: resultado.error }
    if (resultado.sesion.rol !== 'ADMIN') return { success: false, error: 'Solo el ADMIN convierte transferencias.' }

    const valor = Number(monto)
    if (!Number.isFinite(valor) || valor <= 0) return { success: false, error: 'Monto invalido.' }

    const { data, error } = await supabase.rpc('convertir_transferencias', {
      p_monto: Math.round(valor * 100) / 100,
      p_nota: nota?.trim() || undefined
    })
    if (error) return { success: false, error: error.message }

    const r = data as { id: string; monto: number; comision: number; neto: number; pct: number }
    revalidatePath('/dashboard/general')
    revalidatePath('/dashboard/finanzas')
    return {
      success: true,
      id: r.id,
      monto: Number(r.monto),
      comision: Number(r.comision),
      neto: Number(r.neto),
      pct: Number(r.pct)
    }
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : 'Error inesperado' }
  }
}
