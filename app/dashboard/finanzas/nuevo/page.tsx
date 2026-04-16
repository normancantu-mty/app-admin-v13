'use client'

import { useState, useTransition } from 'react'
import RecurrenceFields from './RecurrenceFields'
import { bulkDeleteMovements } from '@/app/actions/audit'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { requireClientMutationPermission } from '@/lib/auth-utils.client'
import type { TipoMovimientoFinanciero } from '@/types/database'

// Strict Business Categories - Exhaustive List
const CATEGORIAS_INGRESOS = [
  { value: 'Venta_Directa', label: 'Venta Directa' },
  { value: 'Venta_Red_DST', label: 'Venta Red DST' },
  { value: 'Aportacion_Capital', label: 'Aportación Capital' },
  { value: 'Abono_Deuda', label: 'Abono Deuda' }
]

const CATEGORIAS_EGRESOS = [
  { value: 'Compra_Insumos', label: 'Compra Insumos' },
  { value: 'Nomina_y_Honorarios', label: 'Nómina y Honorarios' },
  { value: 'Logistica_Envios', label: 'Logística Envíos' },
  { value: 'Marketing_y_Relaciones', label: 'Marketing y Relaciones' },
  { value: 'Servicios_Basicos', label: 'Servicios Básicos' },
  { value: 'Fuga_Fiscal_IVA', label: 'Fuga Fiscal IVA' },
  { value: 'Fuga_Fiscal_IEPS', label: 'Fuga Fiscal IEPS' },
  { value: 'Gastos_Personales_Socio', label: 'Gastos Personales Socio' },
  { value: 'Ajuste_Caja', label: 'Ajuste Caja' }
]

import Link from 'next/link'
import FinanzaForm from './FinanzaForm'

export default function NuevoMovimientoPage() {
  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link 
            href="/dashboard/finanzas"
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver a Finanzas
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Nuevo Movimiento Financiero</h1>
        </div>

        {/* Form Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <FinanzaForm />
        </div>
      </div>
    </div>
  )
}
