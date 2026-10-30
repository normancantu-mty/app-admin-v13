import { RUTA_BASE } from '@/lib/v2/rutas'
import { redirect } from 'next/navigation'

export default function Home() {
  redirect(RUTA_BASE)
}
