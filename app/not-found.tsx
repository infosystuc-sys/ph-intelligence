import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg gap-4">
      <h1 className="text-5xl font-bold text-body">404</h1>
      <p className="text-muted">Página no encontrada</p>
      <Link href="/dashboard" className="text-primary font-semibold hover:underline">
        Volver al dashboard
      </Link>
    </div>
  )
}
