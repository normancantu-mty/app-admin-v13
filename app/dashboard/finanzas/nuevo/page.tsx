'use client'

import { useState, useTransition } from 'react'
import RecurrenceFields from './RecurrenceFields'
import { bulkDeleteMovements } from '@/app/actions/audit'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { requireClientMutationPermission } from '@/lib/auth-utils.client'
import type { TipoMovimientoFinanciero } from '@/types/database'
import { CATEGORIAS_INGRESOS, CATEGORIAS_EGRESOS } from '@/lib/catalog-constants'
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
