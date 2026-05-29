'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import Image from 'next/image'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { User } from '@/types'
import { useSyncContext } from '@/contexts/SyncContext'
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Kanban,
  Settings,
  LogOut,
  ChevronRight,
  CreditCard,
  PhoneOff,
  Archive,
  RefreshCw,
  Brain,
} from 'lucide-react'

const navItems = [
  { href: '/dashboard',        label: 'Dashboard',             icon: LayoutDashboard, roles: ['admin', 'supervisor', 'vendedor'] },
  { href: '/conversations',    label: 'Conversaciones',        icon: MessageSquare,   roles: ['admin', 'supervisor', 'vendedor'] },
  { href: '/historico',        label: 'Histórico',             icon: Archive,         roles: ['admin', 'supervisor', 'vendedor'] },
  { href: '/analyses',         label: 'Análisis IA',           icon: Brain,           roles: ['admin', 'supervisor', 'vendedor'] },
  { href: '/vendors',          label: 'Vendedores',            icon: Users,           roles: ['admin', 'supervisor'] },
  { href: '/pipeline',         label: 'Pipeline',              icon: Kanban,          roles: ['admin', 'supervisor'] },
  { href: '/employee-phones',  label: 'Teléfonos Empleados',   icon: PhoneOff,        roles: ['admin', 'supervisor', 'vendedor'] },
  { href: '/base-clientes',    label: 'Base Clientes',         icon: CreditCard,      roles: ['admin'] },
  { href: '/settings',         label: 'Configuración',         icon: Settings,        roles: ['admin'] },
]

const roleLabel: Record<string, string> = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  vendedor: 'Vendedor',
}

export default function Sidebar({ user }: { user: User }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createBrowserSupabaseClient()
  const { isSyncing, syncingInstanceId } = useSyncContext()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const allowedItems = navItems.filter(item => item.roles.includes(user.role))

  return (
    <aside className="w-60 bg-surface border-r border-border flex flex-col h-full shrink-0">
      {/* Logo header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-center min-h-[72px]">
        <Image
          src="https://dcdn-us.mitiendanube.com/stores/001/648/306/themes/common/logo-1418448436-1618323389-81a7d7e1e0314f705db7aea586f27a9d1618323390-640-0.png"
          alt="Punto Hogar"
          width={150}
          height={45}
          className="object-contain"
          unoptimized
        />
      </div>

      {/* Perfil del usuario */}
      <div className="px-4 py-3 border-b border-border bg-bg">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white font-bold text-sm shrink-0">
            {user.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-body truncate">{user.full_name}</p>
            <p className="text-xs text-muted">{roleLabel[user.role] ?? user.role}</p>
          </div>
        </div>
      </div>

      {/* Navegación */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {allowedItems.map(item => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all group ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-body hover:bg-bg hover:text-primary'
              }`}
            >
              <item.icon
                size={18}
                className={isActive ? 'text-primary' : 'text-muted group-hover:text-primary'}
              />
              <span>{item.label}</span>
              {isActive && <ChevronRight size={14} className="ml-auto text-primary" />}
            </Link>
          )
        })}
      </nav>

      {/* Sync indicator */}
      {isSyncing && (
        <div className="mx-3 mb-2 flex items-center gap-2 px-3 py-2 rounded-md bg-primary/5 text-primary text-xs font-medium">
          <RefreshCw size={12} className="animate-spin shrink-0" />
          <span className="truncate">
            Sincronizando{syncingInstanceId ? '…' : ''}
          </span>
        </div>
      )}

      {/* Logout */}
      <div className="px-3 py-4 border-t border-border">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-md text-sm font-medium text-muted hover:bg-red-50 hover:text-red-600 transition-all"
        >
          <LogOut size={18} />
          <span>Cerrar sesión</span>
        </button>
      </div>
    </aside>
  )
}
