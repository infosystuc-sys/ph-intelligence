import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'

// Diagnóstico: revisa si los análisis recientes están linkeados a sus conversaciones
// y si la query del listado de conversaciones los devuelve.
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Solo admin' }, { status: 403 })
  }

  const service = createServiceSupabaseClient()

  // 1) Contar análisis totales y traer los 5 más recientes
  const { count: totalAnalyses } = await service
    .from('ai_analyses')
    .select('id', { count: 'exact', head: true })

  const { data: recent } = await service
    .from('ai_analyses')
    .select('id, conversation_id, quality_score, analyzed_at, model_used')
    .order('analyzed_at', { ascending: false })
    .limit(5)

  // 2) Para cada uno, traer la conversación + su join ai_analyses
  type AnaRow = { id: string; conversation_id: string; quality_score: number; analyzed_at: string; model_used: string | null }
  type Detail = {
    analysisId: string
    conversationId: string
    qualityScore: number
    analyzedAt: string
    conversationFound: boolean
    conversationStatus: string | null
    joinReturnsAnalysis: boolean
    joinedAnalysesCount: number
  }
  const details: Detail[] = []
  for (const a of (recent ?? []) as AnaRow[]) {
    const { data: conv } = await service
      .from('conversations')
      .select('id, status, ai_analysis:ai_analyses(id, quality_score, analyzed_at)')
      .eq('id', a.conversation_id)
      .maybeSingle()

    const joinedArr = (conv?.ai_analysis as Array<{ id: string }> | null) ?? []
    details.push({
      analysisId: a.id,
      conversationId: a.conversation_id,
      qualityScore: a.quality_score,
      analyzedAt: a.analyzed_at,
      conversationFound: !!conv,
      conversationStatus: conv?.status ?? null,
      joinReturnsAnalysis: joinedArr.some(x => x.id === a.id),
      joinedAnalysesCount: joinedArr.length,
    })
  }

  return NextResponse.json({ totalAnalyses, recent: details })
}
