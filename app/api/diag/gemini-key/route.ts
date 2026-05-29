import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { GoogleGenAI } from '@google/genai'

export const dynamic = 'force-dynamic'

// Diagnóstico: muestra qué API key de Gemini está cargada en el server
// y la prueba con una llamada mínima. Solo admin.
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Solo admin' }, { status: 403 })
  }

  const key = process.env.GEMINI_API_KEY ?? ''
  const keyInfo = {
    loaded: key.length > 0,
    length: key.length,
    firstChars: key.slice(0, 4),
    lastChars: key.slice(-4),
  }

  // Test mínimo: llamar a la API con un prompt corto
  let testResult: { ok: boolean; error?: string; response?: string } = { ok: false }
  try {
    const client = new GoogleGenAI({ apiKey: key })
    const res = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Responde solo con la palabra OK',
      config: { maxOutputTokens: 10, temperature: 0 },
    })
    testResult = { ok: true, response: (res.text ?? '').slice(0, 50) }
  } catch (e) {
    testResult = { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }
  }

  return NextResponse.json({ key: keyInfo, test: testResult })
}
