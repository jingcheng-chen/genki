import { describe, expect, it, vi } from 'vitest'
import { createTracer } from '../tracer'

describe('createTracer', () => {
  /**
   * @example
   *   const t = createTracer(3)
   *   t.emit({ category: 'fps', data: { fps: 60, frameMs: 16.6 } })
   *   t.getSnapshot().length === 1
   */
  it('stores events in insertion order', () => {
    const t = createTracer(10)
    t.emit({ category: 'llm.raw-delta', data: { delta: 'a' } })
    t.emit({ category: 'llm.raw-delta', data: { delta: 'b' } })
    t.emit({ category: 'llm.raw-delta', data: { delta: 'c' } })

    const snap = t.getSnapshot()
    expect(snap.length).toBe(3)
    expect((snap[0].data as { delta: string }).delta).toBe('a')
    expect((snap[1].data as { delta: string }).delta).toBe('b')
    expect((snap[2].data as { delta: string }).delta).toBe('c')
  })

  /**
   * @example
   *   capacity=3 with 5 inserts → snapshot returns the last 3 in order.
   */
  it('wraps at capacity — keeps the newest N events in order', () => {
    const t = createTracer(3)
    for (let i = 0; i < 5; i++) {
      t.emit({ category: 'llm.raw-delta', data: { delta: String(i) } })
    }
    const snap = t.getSnapshot()
    expect(snap.length).toBe(3)
    expect((snap[0].data as { delta: string }).delta).toBe('2')
    expect((snap[1].data as { delta: string }).delta).toBe('3')
    expect((snap[2].data as { delta: string }).delta).toBe('4')
    // Seq numbers are monotonic even after wrap.
    expect(snap[0].seq).toBe(2)
    expect(snap[1].seq).toBe(3)
    expect(snap[2].seq).toBe(4)
  })

  /**
   * @example
   *   subscribe fires for each emit, with events in order.
   */
  it('subscribe fires for each emit, in order', () => {
    const t = createTracer(10)
    const listener = vi.fn()
    t.subscribe(listener)

    t.emit({ category: 'turn.start', data: { userText: 'hi' }, turnId: 't1' })
    t.emit({ category: 'turn.end', data: { totalMs: 100 }, turnId: 't1' })

    expect(listener).toHaveBeenCalledTimes(2)
    const first = listener.mock.calls[0][0]
    const second = listener.mock.calls[1][0]
    expect(first.category).toBe('turn.start')
    expect(first.turnId).toBe('t1')
    expect(second.category).toBe('turn.end')
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  /**
   * @example
   *   unsubscribe stops further fires.
   */
  it('unsubscribe stops further fires', () => {
    const t = createTracer(10)
    const listener = vi.fn()
    const unsub = t.subscribe(listener)

    t.emit({ category: 'fps', data: { fps: 60, frameMs: 16 } })
    expect(listener).toHaveBeenCalledTimes(1)

    unsub()
    t.emit({ category: 'fps', data: { fps: 59, frameMs: 17 } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   *   a throwing subscriber doesn't break the emit chain for the next one.
   */
  it('isolates subscriber exceptions', () => {
    const t = createTracer(10)
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    // Silence the console.error the tracer writes for this test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    t.subscribe(bad)
    t.subscribe(good)

    t.emit({ category: 'fps', data: { fps: 60, frameMs: 16 } })

    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)

    errSpy.mockRestore()
  })

  /**
   * @example
   *   clear empties the snapshot but preserves seq monotonicity.
   */
  it('clear empties the ring; subsequent emits keep increasing seq', () => {
    const t = createTracer(5)
    t.emit({ category: 'fps', data: { fps: 60, frameMs: 16 } })
    t.emit({ category: 'fps', data: { fps: 59, frameMs: 17 } })
    expect(t.getSnapshot().length).toBe(2)

    const lastSeq = t.getSnapshot()[1].seq

    t.clear()
    expect(t.getSnapshot().length).toBe(0)

    t.emit({ category: 'fps', data: { fps: 58, frameMs: 18 } })
    const after = t.getSnapshot()
    expect(after.length).toBe(1)
    expect(after[0].seq).toBeGreaterThan(lastSeq)
  })

  /**
   * @example
   *   emit returns a timestamped event exposed on the snapshot.
   */
  it('assigns seq + ts to every event', () => {
    const t = createTracer(10)
    const before = Date.now()
    t.emit({ category: 'fps', data: { fps: 60, frameMs: 16 } })
    const after = Date.now()

    const [ev] = t.getSnapshot()
    expect(ev.seq).toBe(0)
    expect(ev.ts).toBeGreaterThanOrEqual(before)
    expect(ev.ts).toBeLessThanOrEqual(after)
    expect(ev.turnId).toBeNull()
  })

  /**
   * @example
   *   invalid capacities throw — we don't silently degrade to default.
   */
  it('rejects non-positive capacities', () => {
    expect(() => createTracer(0)).toThrow(/positive/)
    expect(() => createTracer(-5)).toThrow(/positive/)
  })
})
