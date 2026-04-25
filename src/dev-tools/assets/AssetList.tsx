import { useMemo, useState } from 'react'
import type { AnimationView, AssetEntry } from './types'
import { StatusBadge } from './StatusBadge'
import { formatBytes } from './status'

const KIND_FILTERS: Array<{
  id: 'all' | 'idle' | 'emotion' | 'gesture' | 'talking' | 'unmapped'
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'idle', label: 'Idle' },
  { id: 'emotion', label: 'Emotion' },
  { id: 'gesture', label: 'Gesture' },
  { id: 'talking', label: 'Talking' },
  { id: 'unmapped', label: 'Unmapped' },
]

interface Props {
  models: AssetEntry[]
  animations: AnimationView[]
  selectedModelUrl: string | null
  selectedAnimationUrl: string | null
  onSelectModel: (url: string) => void
  onSelectAnimation: (url: string) => void
  onDelete: (url: string) => void
}

export function AssetList({
  models,
  animations,
  selectedModelUrl,
  selectedAnimationUrl,
  onSelectModel,
  onSelectAnimation,
  onDelete,
}: Props) {
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]['id']>('all')

  const filteredAnimations = useMemo(() => {
    if (filter === 'all') return animations
    if (filter === 'unmapped') {
      return animations.filter((a) => a.status === 'orphan' || a.status === 'missing')
    }
    if (filter === 'idle') {
      return animations.filter((a) => a.kind === 'idle' || a.kind === 'idle_variant')
    }
    return animations.filter((a) => a.kind === filter)
  }, [animations, filter])

  return (
    <aside className="border-l border-[#1f2230] flex flex-col overflow-hidden">
      <Section title={`Models · Outfits (${models.length})`}>
        {models.length === 0 ? (
          <Empty>No .vrm models in /models/</Empty>
        ) : (
          models.map((m) => (
            <Row
              key={m.url}
              selected={selectedModelUrl === m.url}
              onClick={() => onSelectModel(m.url)}
              onDelete={() => onDelete(m.url)}
            >
              <span className="font-mono text-xs truncate" title={m.name}>{m.name}</span>
              <span className="text-[10px] text-slate-500 ml-auto shrink-0">{formatBytes(m.sizeBytes)}</span>
            </Row>
          ))
        )}
      </Section>

      <Section title={`Animations (${animations.length})`}>
        <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-[#1f2230]">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`px-2 py-0.5 text-[11px] rounded border ${
                filter === f.id
                  ? 'bg-[#2a2e44] border-[#3a3f5a] text-slate-100'
                  : 'border-[#1f2230] text-slate-400 hover:text-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredAnimations.length === 0 ? (
            <Empty>Nothing matches this filter.</Empty>
          ) : (
            filteredAnimations.map((a) => {
              const disabled = a.status === 'missing'
              return (
                <Row
                  key={a.url}
                  selected={selectedAnimationUrl === a.url}
                  disabled={disabled}
                  onClick={() => !disabled && onSelectAnimation(a.url)}
                  onDelete={!disabled ? () => onDelete(a.url) : undefined}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs truncate" title={a.name}>
                      {a.name}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <StatusBadge status={a.status} />
                      {a.templateId && a.templateId !== a.name.replace(/\.[^.]+$/, '') ? (
                        <span className="text-[10px] text-slate-500">id: {a.templateId}</span>
                      ) : null}
                      {a.emotion ? (
                        <span className="text-[10px] text-slate-400">→{a.emotion}</span>
                      ) : null}
                    </div>
                  </div>
                  {!disabled ? (
                    <span className="text-[10px] text-slate-500 ml-auto shrink-0">
                      {formatBytes(a.sizeBytes)}
                    </span>
                  ) : null}
                </Row>
              )
            })
          )}
        </div>
      </Section>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-0 first:border-b first:border-[#1f2230] flex-1">
      <div className="px-3 py-2 border-b border-[#1f2230] text-xs uppercase tracking-wider text-slate-400">
        {title}
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col">{children}</div>
    </div>
  )
}

function Row({
  children,
  selected,
  disabled,
  onClick,
  onDelete,
}: {
  children: React.ReactNode
  selected: boolean
  disabled?: boolean
  onClick?: () => void
  onDelete?: () => void
}) {
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 border-b border-[#11131c] ${
        disabled
          ? 'opacity-60 cursor-not-allowed'
          : 'cursor-pointer hover:bg-[#1a1d2a]'
      } ${selected ? 'bg-[#1f2335]' : ''}`}
      onClick={onClick}
    >
      {children}
      {onDelete ? (
        <button
          type="button"
          title="Delete file"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 text-rose-400 hover:text-rose-200 text-xs px-1"
        >
          delete
        </button>
      ) : null}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-xs text-slate-500">{children}</div>
}
