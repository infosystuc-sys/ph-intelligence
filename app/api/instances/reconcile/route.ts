import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { findReconcileDiscrepancies, applyReconcileFix, undoReconcileFix } from '@/lib/instance-reconcile'

export const maxDuration = 30

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: NextResponse.json({ error: 'Sin permisos' }, { status: 403 }) }

  return { error: null }
}

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const service = createServiceSupabaseClient()
  const { data: instances, error: dbError } = await service
    .from('whatsapp_instances')
    .select('id, instance_name, api_key, api_url, phone_number')

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  const findings = await findReconcileDiscrepancies(instances ?? [])
  return NextResponse.json({ findings })
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin()
  if (error) return error

  const body = await req.json()
  const { action, id } = body as { action: 'apply' | 'undo'; id: string }

  if (!id || (action !== 'apply' && action !== 'undo')) {
    return NextResponse.json({ ok: false, error: 'Parámetros inválidos' }, { status: 400 })
  }

  const service = createServiceSupabaseClient()
  const result = action === 'apply'
    ? await applyReconcileFix(service, id)
    : await undoReconcileFix(service, id)

  return NextResponse.json(result)
}
