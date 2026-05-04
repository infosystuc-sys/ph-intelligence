'use client'

export default function GlobalError({
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: '#111827', marginBottom: 16 }}>
            Ocurrió un error inesperado
          </h2>
          <button
            onClick={unstable_retry}
            style={{ background: '#e85d2f', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
          >
            Reintentar
          </button>
        </div>
      </body>
    </html>
  )
}
