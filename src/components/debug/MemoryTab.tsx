import { MemoryInspector } from '../MemoryInspector'

/**
 * Phase 8 Memory tab. Re-uses the existing MemoryInspector instead of
 * duplicating the fact-browsing UI.
 *
 * The inspector positions itself absolutely; inside the debug panel we
 * want it to flow with the tab content. We wrap it with a container
 * that neutralises the `bottom-4 left-4` and gives it full width.
 */
export function MemoryTab() {
  return (
    <div className="relative h-full overflow-y-auto [&>div]:static [&>div]:w-full">
      <MemoryInspector />
    </div>
  )
}
