import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import Link from 'next/link'
import FinanzaForm from './FinanzaForm'

interface CuentaFinancieraFormOption {
  id: string
  nombre: string
  tipo: string
}

export default async function NuevoMovimientoPage() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll() {
          // Server Component: no writeback required
        },
      },
    }
  )

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user?.email) {
    console.error('🚨 [ERROR AUTH NUEVO MOVIMIENTO]:', authError)
  }

  let activeEntityId: string | null = null
  if (user?.email) {
    const { data: entidadData, error: entidadError } = await supabase
      .from('entidades')
      .select('id')
      .eq('email', user.email)
      .single()

    if (entidadError) {
      console.error('🚨 [ERROR FETCH ENTIDAD ACTIVA]:', JSON.stringify(entidadError, null, 2))
    } else {
      activeEntityId = entidadData.id
    }
  }

  const { data: cuentasData, error: cuentasError } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo:tipo_fiscalidad')
    .eq('id_entidad', activeEntityId ?? '')
    .order('nombre', { ascending: true })

  if (cuentasError) {
    console.error('🚨 [ERROR FETCH CUENTAS]:', JSON.stringify(cuentasError, null, 2))
  }

  const cuentas: CuentaFinancieraFormOption[] = cuentasData ?? []

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
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
          <FinanzaForm cuentas={cuentas} />
        </div>
      </div>
    </div>
  )
}
