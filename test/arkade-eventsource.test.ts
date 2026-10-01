import { afterEach, describe, expect, it } from 'vitest'
import { ensureEventSource, EVENT_SOURCE_MISSING_REASON } from '../src/lib/arkade-eventsource'

const scope = globalThis as { EventSource?: unknown }

describe('ensureEventSource', () => {
  const original = scope.EventSource

  afterEach(() => {
    if (original === undefined) delete scope.EventSource
    else scope.EventSource = original
  })

  it('reports true and installs nothing when the runtime already has one', () => {
    const native = class Native {}
    scope.EventSource = native
    const injected = class Injected {}

    expect(ensureEventSource(injected)).toBe(true)
    // Never clobber the runtime's own — a browser's is the real one.
    expect(scope.EventSource).toBe(native)
  })

  it('installs an injected implementation when the runtime has none', () => {
    delete scope.EventSource
    const injected = class Injected {}

    expect(ensureEventSource(injected)).toBe(true)
    expect(scope.EventSource).toBe(injected)
  })

  it('reports false when there is nothing to use', () => {
    delete scope.EventSource

    expect(ensureEventSource()).toBe(false)
    expect(scope.EventSource).toBeUndefined()
  })

  it('ignores a non-constructor, which would break the SDK worse than absence', () => {
    delete scope.EventSource

    expect(ensureEventSource({ notAConstructor: true })).toBe(false)
    expect(scope.EventSource).toBeUndefined()
  })

  it('names both remedies, since a host cannot set a Node flag from library code', () => {
    expect(EVENT_SOURCE_MISSING_REASON).toContain('--experimental-eventsource')
    expect(EVENT_SOURCE_MISSING_REASON).toContain('ArkadeConfig.eventSource')
    // The consequence is the point: a silent stop is what made this cost funds.
    expect(EVENT_SOURCE_MISSING_REASON).toContain('swept')
  })
})
