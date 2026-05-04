import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { analyzeConversation } from '@/lib/ai-analyzer'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const body = await req.json()
    const { conversationId } = body

    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId es requerido' }, { status: 400 })
    }

    // Verificar que el usuario tiene acceso a esta conversación
    const { data: conversation } = await supabase
      .from('conversations')
      .select('vendedor_id')
      .eq('id', conversationId)
      .single()

    if (!conversation) {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 })
    }

    const result = await analyzeConversation(conversationId, 'manual')

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      analysisId: result.analysisId,
    })
  } catch (error) {
    console.error('Error en análisis:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
