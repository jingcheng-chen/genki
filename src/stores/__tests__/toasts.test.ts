import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { pushToast, useToastsStore } from '../toasts'

/**
 * Phase 10 — toast store tests.
 *
 * Uses fake timers to verify auto-dismiss without real waits. We reset
 * the store between each `it` to avoid inter-test bleed.
 *
 * @example
 *   useToastsStore.getState().push({ kind: 'info', message: 'Hi' })
 */
describe('useToastsStore', () => {
  beforeEach(() => {
    useToastsStore.getState().clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts empty', () => {
    expect(useToastsStore.getState().items).toEqual([])
  })

  it('push returns an id and appends a new toast', () => {
    const id = useToastsStore.getState().push({
      kind: 'info',
      message: 'Hello there',
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const { items } = useToastsStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(id)
    expect(items[0].kind).toBe('info')
    expect(items[0].message).toBe('Hello there')
  })

  it('push assigns distinct ids to distinct toasts', () => {
    const a = useToastsStore.getState().push({ kind: 'info', message: 'a' })
    const b = useToastsStore.getState().push({ kind: 'info', message: 'b' })
    const c = useToastsStore.getState().push({ kind: 'info', message: 'c' })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('uses kind-specific default TTL when none is provided', () => {
    const { push } = useToastsStore.getState()
    const infoId = push({ kind: 'info', message: 'i' })
    const warnId = push({ kind: 'warn', message: 'w' })
    const errId = push({ kind: 'error', message: 'e' })
    const items = useToastsStore.getState().items
    const info = items.find((t) => t.id === infoId)!
    const warn = items.find((t) => t.id === warnId)!
    const err = items.find((t) => t.id === errId)!
    expect(info.ttlMs).toBe(4000)
    expect(warn.ttlMs).toBe(6000)
    expect(err.ttlMs).toBe(8000)
  })

  it('honours an explicit ttlMs override', () => {
    const id = useToastsStore.getState().push({
      kind: 'info',
      message: 'hi',
      ttlMs: 1234,
    })
    const t = useToastsStore.getState().items.find((x) => x.id === id)!
    expect(t.ttlMs).toBe(1234)
  })

  it('dismiss removes the toast by id', () => {
    const id = useToastsStore.getState().push({ kind: 'error', message: 'oops' })
    expect(useToastsStore.getState().items).toHaveLength(1)

    useToastsStore.getState().dismiss(id)
    expect(useToastsStore.getState().items).toHaveLength(0)
  })

  it('dismiss is a no-op when the id is unknown', () => {
    useToastsStore.getState().push({ kind: 'info', message: 'live' })
    const before = useToastsStore.getState().items.slice()
    useToastsStore.getState().dismiss('no-such-id')
    const after = useToastsStore.getState().items
    expect(after).toEqual(before)
  })

  it('auto-dismisses after ttlMs elapses', () => {
    useToastsStore.getState().push({
      kind: 'info',
      message: 'disappearing',
      ttlMs: 1000,
    })
    expect(useToastsStore.getState().items).toHaveLength(1)

    // Not yet.
    vi.advanceTimersByTime(999)
    expect(useToastsStore.getState().items).toHaveLength(1)

    // Fire the auto-dismiss.
    vi.advanceTimersByTime(2)
    expect(useToastsStore.getState().items).toHaveLength(0)
  })

  it('auto-dismiss does not fire for already-dismissed toasts', () => {
    const id = useToastsStore.getState().push({
      kind: 'info',
      message: 'disappearing',
      ttlMs: 1000,
    })
    useToastsStore.getState().dismiss(id)
    expect(useToastsStore.getState().items).toHaveLength(0)

    // Advance past TTL; nothing should error or re-trigger.
    vi.advanceTimersByTime(2000)
    expect(useToastsStore.getState().items).toHaveLength(0)
  })

  it('multiple toasts dismiss independently at their own TTLs', () => {
    useToastsStore.getState().push({ kind: 'info', message: 'short', ttlMs: 500 })
    useToastsStore.getState().push({ kind: 'error', message: 'long', ttlMs: 5000 })
    expect(useToastsStore.getState().items).toHaveLength(2)

    vi.advanceTimersByTime(600)
    const after = useToastsStore.getState().items
    expect(after).toHaveLength(1)
    expect(after[0].message).toBe('long')

    vi.advanceTimersByTime(5000)
    expect(useToastsStore.getState().items).toHaveLength(0)
  })

  it('clear drops all toasts immediately', () => {
    useToastsStore.getState().push({ kind: 'info', message: 'a' })
    useToastsStore.getState().push({ kind: 'error', message: 'b' })
    expect(useToastsStore.getState().items).toHaveLength(2)

    useToastsStore.getState().clear()
    expect(useToastsStore.getState().items).toEqual([])
  })

  it('pushToast helper forwards to the store', () => {
    const id = pushToast({ kind: 'warn', message: 'helper path' })
    const t = useToastsStore.getState().items.find((x) => x.id === id)!
    expect(t.kind).toBe('warn')
    expect(t.message).toBe('helper path')
  })
})
