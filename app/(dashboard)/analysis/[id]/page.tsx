import { createServerSupabaseClient, getServerUserProfile } from '@/lib/supabase-server'
import { notFound, redirect } from 'next/navigation'
import AnalysisReport from '@/components/analysis/AnalysisReport'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const profile = await getServerUserProfile()
  if (!profile) redirect('/login')

  const supabase = await createServerSupabaseClient()

  const { data: analysis } = await supabase
    .from('ai_analyses')
    .select('*')
    .eq('id', id)
    .single()

  if (!analysis) notFound()

  const [convRes, vendorRes, historyRes] = await Promise.all([
    supabase
      .from('conversations')
      .select('client_name, client_phone, created_at, message_count')
      .eq('id', analysis.conversation_id)
      .single(),
    supabase
      .from('users')
      .select('*')
      .eq('id', analysis.vendedor_id)
      .single(),
    supabase
      .from('ai_analyses')
      .select('id, quality_score, analyzed_at')
      .eq('conversation_id', analysis.conversation_id)
      .order('analyzed_at', { ascending: true }),
  ])

  if (!convRes.data || !vendorRes.data) notFound()

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/conversations"
          className="flex items-center gap-1 text-sm text-muted hover:text-primary transition-colors"
        >
          <ArrowLeft size={16} /> Volver a conversaciones
        </Link>
        <span className="text-gray-300">|</span>
        <h1 className="text-xl font-bold text-body">Informe de Análisis IA</h1>
      </div>

      <AnalysisReport
        analysis={analysis}
        conversation={convRes.data}
        vendor={vendorRes.data}
        userRole={profile.role}
        userId={profile.id}
        allAnalyses={historyRes.data ?? []}
      />
    </div>
  )
}
