'use client'

import { useCallback, useEffect } from 'react'
import { isWithinAutoAnalysisWindow } from '@/lib/utils'

const AUTO_ANALYSIS_INTERVAL_MS = 2 * 60 * 1000

// Dispara un análisis automático de 1 conversación pendiente sin bloquear la UI.
// Fire-and-forget: no muestra loading ni notificaciones al usuario. Usa el
// proveedor activo (Gemini) y, si la conversación pertenece a una instancia con
// su propia gemini_api_key, esa key (ver lib/ai-analyzer.ts). Depende de que esta
// pestaña del navegador esté abierta — no es un cron de servidor.
//
// Solo corre de 21:00 a 09:00 (hora AR) — el servidor también valida esto
// (ver app/api/analyze/auto/route.ts), acá se chequea antes para no generar
// requests de más durante el horario laboral.
//
// Montar este hook en cada página donde se quiera mantener viva esta cadencia
// (hoy: /conversations y /dashboard).
export function useAutoAnalysis() {
  const trigger = useCallback(() => {
    if (!isWithinAutoAnalysisWindow()) return
    fetch('/api/analyze/auto', { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d.analyzed) console.log('[AutoAnalysis]', d.conversationId) })
      .catch(() => {}) // silencioso ante cualquier error
  }, [])

  useEffect(() => {
    const timer = setTimeout(trigger, 20_000)
    const interval = setInterval(trigger, AUTO_ANALYSIS_INTERVAL_MS)
    return () => { clearTimeout(timer); clearInterval(interval) }
  }, [trigger])
}
