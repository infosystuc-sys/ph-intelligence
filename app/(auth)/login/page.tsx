'use client'

export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import Image from 'next/image'

export default function LoginPage() {
  const [email, setEmail] = useState('admin@puntohogar.com.ar')
  const [password, setPassword] = useState('Admin123!')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetMode, setResetMode] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const router = useRouter()
  const supabase = createBrowserSupabaseClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError('Email o contraseña incorrectos. Verificá tus datos e intentá de nuevo.')
      setLoading(false)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
    })

    if (error) {
      setError('No se pudo enviar el email de recuperación. Verificá la dirección ingresada.')
      setLoading(false)
      return
    }

    setResetSent(true)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-4">
      {/* Card principal */}
      <div className="bg-surface rounded-lg shadow-lg w-full max-w-md overflow-hidden">
        {/* Header violeta */}
        <div className="bg-primary px-8 py-8 flex flex-col items-center">
          <Image
            src="https://dcdn-us.mitiendanube.com/stores/001/648/306/themes/common/logo-1418448436-1618323389-81a7d7e1e0314f705db7aea586f27a9d1618323390-640-0.png"
            alt="Punto Hogar"
            width={200}
            height={60}
            className="object-contain"
            unoptimized
          />
          <p className="text-white/80 text-sm mt-3 font-medium tracking-wide">
            INTELIGENCIA CONVERSACIONAL
          </p>
        </div>

        {/* Formulario */}
        <div className="px-8 py-8">
          {!resetMode ? (
            <>
              <h2 className="text-xl font-semibold text-body mb-6">
                Iniciá sesión
              </h2>

              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-body mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    placeholder="vendedor@puntohogar.com.ar"
                    className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-body mb-1">
                    Contraseña
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-primary hover:bg-primary-dark text-white font-semibold py-2.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {loading ? 'Ingresando...' : 'Ingresar'}
                </button>
              </form>

              <button
                onClick={() => { setResetMode(true); setError(null) }}
                className="mt-4 text-sm text-primary hover:text-primary-dark underline w-full text-center transition-colors"
              >
                ¿Olvidaste tu contraseña?
              </button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-body mb-2">
                Recuperar contraseña
              </h2>
              <p className="text-sm text-muted mb-6">
                Te enviamos un link para restablecer tu contraseña.
              </p>

              {resetSent ? (
                <div className="p-4 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
                  ✅ Email enviado. Revisá tu bandeja de entrada y seguí el link.
                </div>
              ) : (
                <>
                  {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                      {error}
                    </div>
                  )}

                  <form onSubmit={handleReset} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-body mb-1">
                        Email
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        placeholder="tu@email.com"
                        className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full bg-primary hover:bg-primary-dark text-white font-semibold py-2.5 rounded-md transition-colors disabled:opacity-50 text-sm"
                    >
                      {loading ? 'Enviando...' : 'Enviar link de recuperación'}
                    </button>
                  </form>
                </>
              )}

              <button
                onClick={() => { setResetMode(false); setError(null); setResetSent(false) }}
                className="mt-4 text-sm text-muted hover:text-body underline w-full text-center"
              >
                ← Volver al login
              </button>
            </>
          )}
        </div>
      </div>

      <p className="mt-6 text-xs text-muted text-center">
        PH-Intelligence · Punto Hogar Tucumán
      </p>
    </div>
  )
}
