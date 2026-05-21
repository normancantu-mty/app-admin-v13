'use client'

import { useState, useEffect } from 'react'
import { fetchAuditFeed, calcularTiempoTranscurrido, getColorClasses, type AuditEvent } from '@/lib/feed-utils'

export default function AuditFeed() {
  const [eventos, setEventos] = useState<AuditEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const LIMIT = 10

  // Initial load
  useEffect(() => {
    loadInitialFeed()
  }, [])

  const loadInitialFeed = async () => {
    setIsLoading(true)
    try {
      const data = await fetchAuditFeed(LIMIT, 0)
      setEventos(data)
      setOffset(LIMIT)
      setHasMore(data.length === LIMIT)
    } catch (error) {
      console.error('Error loading initial feed:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const loadMore = async () => {
    setIsLoading(true)
    try {
      const data = await fetchAuditFeed(LIMIT, offset)
      setEventos(prev => [...prev, ...data])
      setOffset(prev => prev + LIMIT)
      setHasMore(data.length === LIMIT)
    } catch (error) {
      console.error('Error loading more feed:', error)
    } finally {
      setIsLoading(false)
    }
  }

  if (eventos.length === 0 && !isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">📋 Auditoría de Actividad</h2>
        <div className="text-center py-8 text-gray-500">
          <p>No hay actividad registrada</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">📋 Auditoría de Actividad</h2>
      
      {/* Timeline */}
      <div className="space-y-4">
        {eventos.map((evento) => {
          const colors = getColorClasses(evento.color)
          
          return (
            <div key={evento.id} className="relative pl-8">
              {/* Timeline dot */}
              <div className={`absolute left-0 top-1.5 w-3 h-3 rounded-full ${colors.dot}`}></div>
              
              {/* Event card */}
              <div className={`border-l-4 ${colors.border} ${colors.bg} rounded-r-lg p-3`}>
                <p className={`text-sm font-medium ${colors.text}`}>
                  {evento.descripcion}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {calcularTiempoTranscurrido(evento.timestamp)}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Load More Button */}
      {hasMore && (
        <div className="mt-6 pt-4 border-t border-gray-200">
          <button
            onClick={loadMore}
            disabled={isLoading}
            className="w-full text-sm text-blue-600 hover:text-blue-800 font-medium py-2 hover:bg-blue-50 rounded-lg transition-colors disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Cargando...' : 'Cargar Más'}
          </button>
        </div>
      )}
    </div>
  )
}
