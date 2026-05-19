'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { registrarSeguimientoAction } from '@/app/actions/distribuidores'

export default function RegistrarSeguimientoButton({ entidadId }: { entidadId: string }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const onClick = () => {
    startTransition(async () => {
      try {
        await registrarSeguimientoAction(entidadId)
        router.refresh()
      } catch (error: any) {
        alert(error?.message || 'No se pudo registrar el seguimiento.')
      }
    })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed"
      title="Registrar toque CRM"
    >
      <span>📞</span>
      <span>{isPending ? 'Guardando...' : 'Dar Seguimiento'}</span>
    </button>
  )
}
