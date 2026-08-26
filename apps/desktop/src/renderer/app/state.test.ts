import { describe, expect, it } from "vitest";
import { chromeReducer, customViewport, initialChromeState } from "./state.js";

describe("chromeReducer", () => {
  it("pins error messages onto the current state without disturbing other fields", () => {
    const state = initialChromeState();
    const next = chromeReducer(state, { type: "error", message: "boom" });
    expect(next.lastError).toBe("boom");
    expect(next.panes).toEqual(state.panes);
    expect(state.lastError).toBeNull();
  });

  it("adopts replacement state wholesale on state actions", () => {
    const state = initialChromeState();
    const replacement = { ...state, recording: true };
    expect(chromeReducer(state, { type: "state", state: replacement })).toBe(replacement);
  });
});

describe("customViewport", () => {
  it("clamps dimensions to positive integers and encodes them in id and name", () => {
    expect(customViewport(480.6, 0)).toEqual({
      id: "custom-481x1",
      name: "Custom 481×1",
      width: 481,
      height: 1,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
  });
});
