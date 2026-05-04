'use client'

import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Conversation } from '@/types'
import ConversationCard from './ConversationCard'
import { Loader2, Users, ChevronDown } from 'lucide-react'

interface ConvListProps {
  loading: boolean
  individualConvs: Conversation[]
  groupConvs: Conversation[]
  selected: Conversation | null
  selectionMode: boolean
  selectedIds: Set<string>
  groupsExpanded: boolean
  setGroupsExpanded: (fn: boolean | ((prev: boolean) => boolean)) => void
  getBaseMatch: (conv: Conversation) => { cod_cliente: string | null; source: string } | null
  handleSaveName: (conversationId: string, displayName: string | null) => Promise<void>
  selectConversation: (conv: Conversation) => void
  toggleSelection: (id: string) => void
}

export default function ConvList({
  loading,
  individualConvs,
  groupConvs,
  selected,
  selectionMode,
  selectedIds,
  groupsExpanded,
  setGroupsExpanded,
  getBaseMatch,
  handleSaveName,
  selectConversation,
  toggleSelection,
}: ConvListProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: individualConvs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 8,
  })

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      {individualConvs.length === 0 ? (
        <div className="py-10 text-center text-xs text-gray-400">Sin conversaciones</div>
      ) : (
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map(virtualItem => {
            const conv = individualConvs[virtualItem.index]
            const match = getBaseMatch(conv)
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <ConversationCard
                  conversation={conv}
                  onClick={() => selectConversation(conv)}
                  selected={selected?.id === conv.id}
                  onSaveName={handleSaveName}
                  codCliente={match?.cod_cliente ?? null}
                  baseSource={match?.source ?? null}
                  checkable={selectionMode}
                  checked={selectedIds.has(conv.id)}
                  onCheck={() => toggleSelection(conv.id)}
                />
              </div>
            )
          })}
        </div>
      )}

      {groupConvs.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={() => setGroupsExpanded(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-muted hover:bg-bg transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <Users size={12} /> Grupos internos ({groupConvs.length})
            </span>
            <ChevronDown
              size={12}
              className={`transition-transform ${groupsExpanded ? 'rotate-180' : ''}`}
            />
          </button>
          {groupsExpanded && groupConvs.map(c => (
            <ConversationCard
              key={c.id}
              conversation={c}
              onClick={() => selectConversation(c)}
              selected={selected?.id === c.id}
              onSaveName={handleSaveName}
            />
          ))}
        </div>
      )}
    </div>
  )
}
