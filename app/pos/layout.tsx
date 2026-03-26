'use client'

import { ReactNode } from 'react'
import ProtectedRoute from '@/components/ProtectedRoute'

export default function POSLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <ProtectedRoute>
      {children}
    </ProtectedRoute>
  )
}
