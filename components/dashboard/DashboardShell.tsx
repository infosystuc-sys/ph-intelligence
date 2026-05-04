'use client'

import { SyncProvider } from '@/contexts/SyncContext'
import Sidebar from '@/components/dashboard/Sidebar'
import { User } from '@/types'

export default function DashboardShell({ user, children }: { user: User; children: React.ReactNode }) {
  return (
    <SyncProvider>
      <div className="flex h-screen bg-bg overflow-hidden">
        <Sidebar user={user} />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </SyncProvider>
  )
}
