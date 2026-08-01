import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { generateVendorGlobalAnalysis, getVendorGlobalAnalysisHistory } from '@/lib/vendor-global-analysis'

export const maxDuration = 60

// Admin: acceso a cualquier vendedor. Supervisor: solo a los vendedores donde
// users.supervisor_id === su propio id. Vendedor: sin acceso (ni ver ni generar
// su propio análisis global — decisión explícita del alcance de este feature).
async function authorizeVendorAccess(vendorId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!profile || !['admin', 'supervisor'].includes(profile.role)) {
    return { error: NextResponse.json({ error: 'Sin permisos' }, { status: 403 }) }
  }

  if (profile.role === 'supervisor') {
    const service = createServiceSupabaseClient()
    const { data: vendor } = await service.from('users').select('supervisor_id').eq('id', vendorId).single()
    if (!vendor || vendor.supervisor_id !== user.id) {
      return { error: NextResponse.json({ error: 'Sin permisos sobre este vendedor' }, { status: 403 }) }
    }
  }

  return { error: null, userId: user.id }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const vendorId = searchParams.get('vendorId')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '14'), 60)

  if (!vendorId) return NextResponse.json({ error: 'vendorId requerido' }, { status: 400 })

  const { error } = await authorizeVendorAccess(vendorId)
  if (error) return error

  const service = createServiceSupabaseClient()
  try {
    const history = await getVendorGlobalAnalysisHistory(service, vendorId, limit)
    return NextResponse.json({ history })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Error interno' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { vendorId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Body inválido' }, { status: 400 })
  }

  const vendorId = body.vendorId
  if (!vendorId) return NextResponse.json({ ok: false, error: 'vendorId requerido' }, { status: 400 })

  const { error, userId } = await authorizeVendorAccess(vendorId)
  if (error) return error

  const service = createServiceSupabaseClient()
  const result = await generateVendorGlobalAnalysis(service, vendorId, userId!)
  return NextResponse.json(result)
}
