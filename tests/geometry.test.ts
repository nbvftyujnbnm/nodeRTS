import { describe, expect, it } from 'vitest';
import {
  distance,
  pointSegmentDistance,
  segmentIntersection,
} from '../src/game/geometry';

describe('segmentIntersection', () => {
  it('finds a proper crossing', () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 });
    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(5);
    expect(hit?.point.y).toBeCloseTo(0);
    expect(hit?.t).toBeCloseTo(0.5);
    expect(hit?.u).toBeCloseTo(0.5);
  });

  it('returns null for parallel segments', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 }),
    ).toBeNull();
  });

  it('returns null for collinear overlapping segments', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 }),
    ).toBeNull();
  });

  it('does not treat a shared endpoint as an intersection', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }),
    ).toBeNull();
  });

  it('does not treat a T-touch at an endpoint as an intersection', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 9 }),
    ).toBeNull();
  });

  it('rejects segments that would cross only if extended', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: -5 }, { x: 8, y: 5 }),
    ).toBeNull();
  });

  it('measures distances', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(pointSegmentDistance({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });
});
