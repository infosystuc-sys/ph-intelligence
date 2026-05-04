'use client'

import { createContext, useContext, useState, ReactNode } from 'react'

interface SyncResult {
  instanceId: string
  synced: number
  errors: number
  skipped: number
  chatsFound: number
  errorLog: string[]
}

interface SyncState {
  isSyncing: boolean
  syncingInstanceId: string | null
  lastResult: SyncResult | null
  startSync: (instanceId: string) => Promise<void>
}

const SyncContext = createContext<SyncState | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncingInstanceId, setSyncingInstanceId] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<SyncResult | null>(null)

  const startSync = async (instanceId: string) => {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncingInstanceId(instanceId)
    try {
      const res = await fetch('/api/sync/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      })
      const data = await res.json()
      setLastResult({
        instanceId,
        synced: data.synced ?? 0,
        errors: data.errors ?? 0,
        skipped: data.skipped ?? 0,
        chatsFound: data.chatsFound ?? 0,
        errorLog: data.errorLog ?? [],
      })
    } catch {
      setLastResult({
        instanceId,
        synced: 0,
        errors: 1,
        skipped: 0,
        chatsFound: 0,
        errorLog: ['Error de red al sincronizar'],
      })
    } finally {
      setIsSyncing(false)
      setSyncingInstanceId(null)
    }
  }

  return (
    <SyncContext.Provider value={{ isSyncing, syncingInstanceId, lastResult, startSync }}>
      {children}
    </SyncContext.Provider>
  )
}

export function useSyncContext() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error('useSyncContext must be used inside SyncProvider')
  return ctx
}
