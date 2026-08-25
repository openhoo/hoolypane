import { describe, expect, it } from "vitest";
import { MAX_ENCODED_DIMENSION } from "@hoolypane/contracts";
import { alignFrames, assertStateTransition, compositeGeometry, durationFrameCount, timestampSecondsToUs } from "./capture-contract.js";

describe("capture contract", () => {
  it("rounds CDP seconds to integer microseconds and rejects missing values", () => {
    expect(timestampSecondsToUs(1.2345674)).toBe(1234567);
    expect(() => timestampSecondsToUs(undefined)).toThrow();
  });

  it("rejects timestamps beyond the safe integer microsecond range", () => {
    expect(() => timestampSecondsToUs(1e11)).toThrow(/exceeds integer microsecond range/u);
  });

  it("computes exact duration and slot holds", () => {
    expect(durationFrameCount(0, 1000001, 60)).toBe(61);
    const result = alignFrames(
      [
        { offset: 0, length: 1, sequence: 1, width: 10, height: 10, timestampUs: 0 },
        { offset: 1, length: 1, sequence: 2, width: 10, height: 10, timestampUs: 20000 },
      ],
      0,
      3,
      60,
    );
    expect(result.mappings.map((mapping) => mapping.sourceSequence)).toEqual([1, 1, 2]);
    expect(result.heldFrames).toBe(1);
  });

  it("reports the largest selected-source skew across slots", () => {
    const result = alignFrames(
      [
        { offset: 0, length: 1, sequence: 1, width: 10, height: 10, timestampUs: 0 },
        { offset: 1, length: 1, sequence: 2, width: 10, height: 10, timestampUs: 100_000 },
      ],
      0,
      5,
      30,
    );
    // Slot targets are 0/33333/66666/100000/133333 µs; slot 2 holds the 0 µs frame with the
    // largest gap, and slot 3 lands exactly on the 100 ms frame boundary.
    expect(result.maximumSkewUs).toBe(66_666);
    expect(result.mappings[2]).toMatchObject({ sourceSequence: 1, held: true });
  });

  it("rejects reversed recording timelines", () => {
    expect(() => durationFrameCount(1000, 999, 30)).toThrow(/invalid recording timeline/u);
  });

  it("uses square-root grid and even bounded geometry", () => {
    const result = compositeGeometry(
      [
        { id: "a", encodedWidth: 100, encodedHeight: 80 },
        { id: "b", encodedWidth: 120, encodedHeight: 90 },
        { id: "c", encodedWidth: 100, encodedHeight: 80 },
      ],
      { width: 200, height: 200 },
    );
    expect(result.columns).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.outputWidth % 2).toBe(0);
    expect(result.outputHeight % 2).toBe(0);
    expect(result.outputWidth).toBeLessThanOrEqual(200);
  });

  it("clamps grids whose unscaled size exceeds the encoded dimension cap", () => {
    const tiles = Array.from({ length: 6 }, (_unused, index) => ({ id: `tile-${index}`, encodedWidth: 16_382, encodedHeight: 16_382 }));
    const result = compositeGeometry(tiles, { width: MAX_ENCODED_DIMENSION, height: MAX_ENCODED_DIMENSION });
    expect(result.unscaledWidth).toBeGreaterThan(MAX_ENCODED_DIMENSION);
    expect(result.unscaledHeight).toBeGreaterThan(MAX_ENCODED_DIMENSION);
    expect(result.outputWidth % 2).toBe(0);
    expect(result.outputHeight % 2).toBe(0);
    expect(result.outputWidth).toBeLessThanOrEqual(MAX_ENCODED_DIMENSION);
    expect(result.outputHeight).toBeLessThanOrEqual(MAX_ENCODED_DIMENSION);
  });

  it("enforces state transitions", () => {
    expect(() => assertStateTransition("recording", "encoding")).toThrow();
    expect(() => assertStateTransition("recording", "post-roll")).not.toThrow();
  });
});
