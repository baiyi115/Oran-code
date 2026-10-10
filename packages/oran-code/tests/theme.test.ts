import { describe, expect, it } from "vitest";
import { resolveColorMode } from "../src/tui/theme.js";

describe("resolveColorMode", () => {
  it("defaults to dark when no hints are present", () => {
    expect(resolveColorMode({})).toBe("dark");
  });

  it("honors NO_COLOR regardless of other hints", () => {
    expect(resolveColorMode({ NO_COLOR: "1" })).toBe("mono");
    expect(resolveColorMode({ NO_COLOR: "1", ORAN_THEME: "light" })).toBe("mono");
  });

  it("honors the ORAN_THEME override", () => {
    expect(resolveColorMode({ ORAN_THEME: "light" })).toBe("light");
    expect(resolveColorMode({ ORAN_THEME: " DARK " })).toBe("dark");
    expect(resolveColorMode({ ORAN_THEME: "mono" })).toBe("mono");
    // Unrecognized values fall back to detection
    expect(resolveColorMode({ ORAN_THEME: "solarized", COLORFGBG: "0;15" })).toBe("light");
  });

  it("detects light backgrounds from COLORFGBG", () => {
    // rxvt convention: fg;bg; in the 16-color palette a background of 8-15 is light
    expect(resolveColorMode({ COLORFGBG: "0;15" })).toBe("light");
    expect(resolveColorMode({ COLORFGBG: "15;0" })).toBe("dark");
    expect(resolveColorMode({ COLORFGBG: "default;default" })).toBe("dark");
  });
});
