'use client'

import { createContext, useContext, useState } from 'react'

export type DateRange = 'HOY' | 'ESTE_MES' | 'TRIMESTRE' | 'PERSONALIZADO'

interface DateFilterContextType {
  dateRange: DateRange
  setDateRange: (range: DateRange) => void
}

const DateFilterContext = createContext<DateFilterContextType>({
  dateRange: 'ESTE_MES',
  setDateRange: () => {},
})

export function DateFilterProvider({ children }: { children: React.ReactNode }) {
  const [dateRange, setDateRange] = useState<DateRange>('ESTE_MES')

  return (
    <DateFilterContext.Provider value={{ dateRange, setDateRange }}>
      {children}
    </DateFilterContext.Provider>
  )
}

export function useDateFilter() {
  const context = useContext(DateFilterContext)
  if (!context) {
    throw new Error('useDateFilter must be used within a DateFilterProvider')
  }
  return context
}
