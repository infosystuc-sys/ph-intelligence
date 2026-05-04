import { redirect } from 'next/navigation'
import { getServerUserProfile } from '@/lib/supabase-server'
import DashboardShell from '@/components/dashboard/DashboardShell'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await getServerUserProfile()

  if (!profile) {
    redirect('/login')
  }

  return <DashboardShell user={profile}>{children}</DashboardShell>
}
