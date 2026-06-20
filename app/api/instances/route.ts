import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'
import { EvolutionAPIClient } from '@/lib/evolution'
import { WhatsappInstance } from '@/types'

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const service = createServiceSupabaseClient()
    const { data, error } = await service
      .from('whatsapp_instances')
      .select('*, vendedor:users!whatsapp_instances_vendedor_id_fkey(id, full_name, avatar_url)')
      .order('instance_name')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json()
    const { instance_name, vendedor_id, api_url, api_key, gemini_api_key, phone_number } = body

    const service = createServiceSupabaseClient()
    const { data, error } = await service
      .from('whatsapp_instances')
      .insert({
        instance_name,
        vendedor_id: vendedor_id || null,
        api_url,
        api_key,
        gemini_api_key: gemini_api_key || null,
        phone_number: phone_number || null,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Registrar webhook automáticamente
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/evolution`
    const client = new EvolutionAPIClient(data as WhatsappInstance)
    await client.registerWebhook(webhookUrl)

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await req.json()
    const { id, ...updates } = body

    // Siempre usar la URL del env var; corrige instancias con URLs incorrectas
    const defaultUrl = process.env.EVOLUTION_API_BASE_URL
    if (defaultUrl) updates.api_url = defaultUrl
    // Limpiar campos vacíos
    if ('vendedor_id' in updates) updates.vendedor_id = updates.vendedor_id || null

    const service = createServiceSupabaseClient()
    const { data, error } = await service
      .from('whatsapp_instances')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden eliminar instancias' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const instanceId = searchParams.get('id')

    if (!instanceId) {
      return NextResponse.json({ error: 'ID de instancia requerido' }, { status: 400 })
    }

    const service = createServiceSupabaseClient()
    const { error } = await service
      .from('whatsapp_instances')
      .delete()
      .eq('id', instanceId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error eliminando instancia:', error)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
