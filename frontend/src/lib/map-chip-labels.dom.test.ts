// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  formatChipLabel,
  makeMapChipLabelElement,
  MAP_LABEL_MAX,
  MAP_LABEL_ZOOM_FLOOR,
  selectChipLabels,
} from "./maps";

/**
 * Day-level activity chip labels (#361 slice 6).
 *
 * The letter chips (A, B, C…) name nothing today; they get labels in the same
 * pill vocabulary as the place labels (makeMapLabelElement /
 * formatMapLabel style, bg-surface/90, heading font), letter-prefixed with the
 * activity title. Same discipline as selectMapLabels: the focused (active)
 * chip's label always wins, the layer stays readable on dense days via a cap
 * and the collision zoom floor. Excursion diamonds stay label-free (no
 * ordinal — the chip path only ever sees activity markers).
 */
describe("day-level chip labels (#361 slice 6)", () => {
  // A dense day: 12 letter chips, more than the layer may show.
  const chips = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"];

  it("caps at about 8 labels in chip order", () => {
    expect(selectChipLabels(chips, null, 11)).toEqual(chips.slice(0, MAP_LABEL_MAX));
    expect(selectChipLabels(chips, null, 11).length).toBeLessThanOrEqual(MAP_LABEL_MAX);
  });

  it("the focused chip always wins, even past the cap", () => {
    expect(selectChipLabels(chips, "c12", 11)[0]).toBe("c12");
    expect(selectChipLabels(chips, "c12", 11)).toHaveLength(MAP_LABEL_MAX);
    expect(selectChipLabels(["c1", "c2"], "c2", 11)).toEqual(["c2", "c1"]);
  });

  it("drops the whole layer below the collision zoom — chips stay, labels go", () => {
    expect(selectChipLabels(chips, null, MAP_LABEL_ZOOM_FLOOR - 0.5)).toEqual([]);
    expect(selectChipLabels(chips, "c1", 1)).toEqual([]);
    expect(selectChipLabels(chips, null, MAP_LABEL_ZOOM_FLOOR)).not.toEqual([]);
  });

  it("dense-day fixture: 12 chips at day zoom label 8 with the focused first", () => {
    const labels = selectChipLabels(chips, "c9", 11);
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe("c9");
  });

  it("letter-prefixes the activity title like the pin numbers its place", () => {
    expect(formatChipLabel("A", "Hotel X")).toBe("A · Hotel X");
  });

  it("builds the same pill as a place label, with the letter prominent", () => {
    const el = makeMapChipLabelElement("A", "Hotel X");
    // Same pill vocabulary — the label layer reads as one layer.
    expect(el.classList.contains("map-place-label")).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    // …but a chip label, not a numbered place label: the square letter badge
    // is the chip's identity (matching the inline badge on its card).
    expect(el.classList.contains("is-chip")).toBe(true);
    const badge = el.querySelector(".map-chip-letter");
    expect(badge?.textContent).toBe("A");
    expect(el.textContent).toContain("Hotel X");
    // Tokens only — no hex colour written in JS, ever.
    expect(el.getAttribute("style") ?? "").not.toContain("#");
  });
});
