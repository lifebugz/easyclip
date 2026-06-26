import { describe, expect, test } from 'bun:test';
import { applyProcessingEvent, baselineProcessingState } from './processing-state';
import type { ProcessingEvent } from '../types';

const ev = (over: Partial<ProcessingEvent> = {}): ProcessingEvent => ({
  stage: 'segment',
  segmentIndex: 1,
  segmentCount: 2,
  fraction: 0.25,
  etaSeconds: 3,
  ...over
});

describe('baselineProcessingState', () => {
  test('is the documented clean slate (S12)', () => {
    expect(baselineProcessingState()).toEqual({
      stage: 'single',
      segmentIndex: 1,
      segmentCount: 1,
      fraction: 0,
      etaSeconds: null,
      cancelRequested: false,
      result: null
    });
  });
});

describe('applyProcessingEvent', () => {
  test('copies stage/segment/eta and keeps fraction monotonic', () => {
    const s = baselineProcessingState();
    applyProcessingEvent(s, ev({ fraction: 0.5 }));
    expect(s.fraction).toBe(0.5);
    expect(s.stage).toBe('segment');
    // A late/duplicate lower-fraction event must not regress the ring:
    applyProcessingEvent(s, ev({ fraction: 0.3, etaSeconds: 1 }));
    expect(s.fraction).toBe(0.5);
    expect(s.etaSeconds).toBe(1);
  });
});
