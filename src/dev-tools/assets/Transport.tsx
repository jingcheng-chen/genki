interface Props {
  animationName: string | null
  playing: boolean
  loop: boolean
  time: number
  duration: number
  canScreenshot: boolean
  onTogglePlaying: () => void
  onToggleLoop: () => void
  onPrev: () => void
  onNext: () => void
  onScrub: (seconds: number) => void
  onScreenshot: () => void
}

export function Transport({
  animationName,
  playing,
  loop,
  time,
  duration,
  canScreenshot,
  onTogglePlaying,
  onToggleLoop,
  onPrev,
  onNext,
  onScrub,
  onScreenshot,
}: Props) {
  const hasAnim = duration > 0
  const pct = hasAnim ? Math.min(100, (time / duration) * 100) : 0

  return (
    <div className="border-t border-[#1f2230] bg-[#0e1119] px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={onPrev}
          title="Previous animation (J)"
          className="px-2 py-1 rounded border border-[#1f2230] hover:bg-[#1a1d2a] text-slate-300"
        >
          ⏮
        </button>
        <button
          type="button"
          onClick={onTogglePlaying}
          title="Play / pause (Space)"
          className="px-3 py-1 rounded border border-[#1f2230] hover:bg-[#1a1d2a] text-slate-100 min-w-[44px]"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          onClick={onNext}
          title="Next animation (K)"
          className="px-2 py-1 rounded border border-[#1f2230] hover:bg-[#1a1d2a] text-slate-300"
        >
          ⏭
        </button>
        <button
          type="button"
          onClick={onToggleLoop}
          title="Toggle loop (L)"
          className={`px-2 py-1 rounded border ${
            loop
              ? 'border-emerald-700 text-emerald-300 bg-emerald-900/30'
              : 'border-[#1f2230] text-slate-300 hover:bg-[#1a1d2a]'
          }`}
        >
          loop
        </button>
        <button
          type="button"
          onClick={onScreenshot}
          disabled={!canScreenshot}
          title="Save current view as transparent PNG (S)"
          className="px-2 py-1 rounded border border-[#1f2230] text-slate-300 hover:bg-[#1a1d2a] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          save PNG
        </button>
        <div className="ml-3 text-slate-400 font-mono text-[11px] min-w-[80px]">
          {formatTime(time)} / {formatTime(duration)}
        </div>
        <div className="ml-auto text-[11px] text-slate-400 font-mono truncate max-w-[40%]" title={animationName ?? ''}>
          {animationName ?? '— no animation —'}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={hasAnim ? duration : 1}
        step={0.01}
        value={hasAnim ? Math.min(time, duration) : 0}
        onChange={(e) => onScrub(parseFloat(e.target.value))}
        disabled={!hasAnim}
        className="w-full accent-emerald-400 disabled:opacity-30"
      />
      <div className="h-0.5 bg-[#1a1d2a] relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500/40"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
