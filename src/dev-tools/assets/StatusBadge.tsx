import type { AnimationStatus } from './types'

const STYLE: Record<AnimationStatus, { label: string; className: string; title: string }> = {
  mapped: {
    label: 'mapped',
    className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
    title: 'Registered in this preset and present on disk.',
  },
  excluded: {
    label: 'excluded',
    className: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
    title: 'In the standard animation roster, but this preset opts out (e.g. via exclude:).',
  },
  orphan: {
    label: 'orphan',
    className: 'bg-slate-800 text-slate-400 border-slate-600',
    title: "On disk, but not part of the standard roster — the LLM can't reach it.",
  },
  missing: {
    label: 'missing',
    className: 'bg-rose-900/40 text-rose-300 border-rose-700/50',
    title: 'Preset references this filename, but no file exists on disk.',
  },
}

export function StatusBadge({ status }: { status: AnimationStatus }) {
  const s = STYLE[status]
  return (
    <span
      title={s.title}
      className={`inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider border rounded ${s.className}`}
    >
      {s.label}
    </span>
  )
}
