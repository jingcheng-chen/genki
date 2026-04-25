import type { CharacterSummary } from './types'
import { formatBytes } from './status'

interface Props {
  characters: CharacterSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function CharacterList({ characters, selectedId, onSelect }: Props) {
  return (
    <aside className="border-r border-[#1f2230] flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-[#1f2230] text-xs uppercase tracking-wider text-slate-400">
        Characters ({characters.length})
      </div>
      <ul className="flex-1 overflow-y-auto">
        {characters.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={`w-full text-left px-3 py-2 flex gap-3 items-center hover:bg-[#1a1d2a] ${
                selectedId === c.id ? 'bg-[#1f2335]' : ''
              }`}
            >
              {c.previewUrl ? (
                <img
                  src={c.previewUrl}
                  alt=""
                  className="w-10 h-10 object-cover rounded border border-[#1f2230] bg-[#0b0d12]"
                />
              ) : (
                <div className="w-10 h-10 rounded border border-[#1f2230] bg-[#0b0d12]" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm">{c.id}</div>
                <div className="text-[11px] text-slate-400">
                  {c.modelCount} models · {c.animationCount} anims
                </div>
                <div className="text-[10px] text-slate-500">{formatBytes(c.totalBytes)}</div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
