// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  estimateHomeLabelWidthPx,
  HOME_LABEL_EDGE_PX,
  HOME_LABEL_MAX_WIDTH_PX,
  placeHomeLabels,
  type HomeMapPin,
} from "./home-geo";
import { makeMapLabelElement } from "./maps";

/**
 * Pill geometry for the home title labels (#375).
 *
 * The display rule (cap, selected-first, clusters quiet) cannot see the
 * screen: long titles clip at the map edge and near neighbours overlap on a
 * phone. The geometry pass caps the width, clamps pills inside the box
 * (flipping above the pin at the bottom), and drops pills that would overlap
 * — the pin always stays. Phone box in these tests is 390×844, the live
 * report's viewport.
 */

function pin(over: Partial<HomeMapPin> & { dtId: string }): HomeMapPin {
  return {
    title: `Trip ${over.dtId}`,
    stage: "booked",
    lat: 0,
    lng: 0,
    name: "Somewhere",
    origin: "mine",
    ...over,
  };
}

const PHONE_W = 390;
const PHONE_H = 844;

describe("estimateHomeLabelWidthPx", () => {
  it("caps the 42-char live title at the stated max", () => {
    expect(estimateHomeLabelWidthPx("Georgia 2028 — Cat-Ski the Lesser Caucasus")).toBe(
      HOME_LABEL_MAX_WIDTH_PX,
    );
    expect(HOME_LABEL_MAX_WIDTH_PX).toBe(160);
  });

  it("leaves short titles smaller than the cap", () => {
    const w = estimateHomeLabelWidthPx("Ski Week");
    expect(w).toBeLessThan(HOME_LABEL_MAX_WIDTH_PX);
    expect(w).toBeGreaterThan(0);
  });

  it("grows with the title — a longer name claims more room", () => {
    expect(estimateHomeLabelWidthPx("Albany")).toBeLessThan(
      estimateHomeLabelWidthPx("Little Switzerland by Van"),
    );
  });
});

describe("makeMapLabelElement home pills", () => {
  it("marks home pills is-home and keeps the full title on title", () => {
    const el = makeMapLabelElement("Georgia 2028 — Cat-Ski the Lesser Caucasus", { home: true });
    expect(el.classList.contains("map-place-label")).toBe(true);
    expect(el.classList.contains("is-home")).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.title).toBe("Georgia 2028 — Cat-Ski the Lesser Caucasus");
    expect(el.textContent).toBe("Georgia 2028 — Cat-Ski the Lesser Caucasus");
  });

  it("leaves trip-surface pills uncapped but still titled", () => {
    const el = makeMapLabelElement("Healesville");
    expect(el.classList.contains("is-home")).toBe(false);
    expect(el.title).toBe("Healesville");
  });
});

describe("placeHomeLabels", () => {
  it("labels nothing when there is nothing, and needs no box to keep defaults", () => {
    expect(placeHomeLabels([], new Map(), PHONE_W, PHONE_H)).toEqual([]);
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(placeHomeLabels(pins, new Map(), 0, 0)).toEqual([
      { dtId: "a", anchor: "top", offsetX: 0 },
      { dtId: "b", anchor: "top", offsetX: 0 },
    ]);
  });

  it("leaves a centred pill alone — below its pin, no shift", () => {
    const pins = [pin({ dtId: "a", title: "Ski Week" })];
    const [placed] = placeHomeLabels(pins, new Map([["a", { x: 195, y: 400 }]]), PHONE_W, PHONE_H);
    expect(placed).toEqual({ dtId: "a", anchor: "top", offsetX: 0 });
  });

  it("shifts a left-edge pill right so it stays inside the box", () => {
    // The live report: `Chile + Peru — zomer 2027` cut off by the left edge.
    const pins = [pin({ dtId: "a", title: "Chile + Peru — zomer 2027" })];
    const [placed] = placeHomeLabels(pins, new Map([["a", { x: 10, y: 400 }]]), PHONE_W, PHONE_H);
    expect(placed.anchor).toBe("top");
    expect(placed.offsetX).toBeGreaterThan(0);
    const w = estimateHomeLabelWidthPx(pins[0].title);
    const left = 10 + placed.offsetX - w / 2;
    expect(left).toBeGreaterThanOrEqual(HOME_LABEL_EDGE_PX);
  });

  it("shifts a right-edge pill left so it stays inside the box", () => {
    const pins = [pin({ dtId: "a", title: "Georgia 2028 — Cat-Ski the Lesser Caucasus" })];
    const [placed] = placeHomeLabels(
      pins,
      new Map([["a", { x: 385, y: 400 }]]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed.offsetX).toBeLessThan(0);
    const w = estimateHomeLabelWidthPx(pins[0].title);
    const right = 385 + placed.offsetX + w / 2;
    expect(right).toBeLessThanOrEqual(PHONE_W - HOME_LABEL_EDGE_PX);
  });

  it("flips a bottom pill above its pin instead of running past the box", () => {
    const pins = [pin({ dtId: "a", title: "Ski Week" })];
    const [placed] = placeHomeLabels(
      pins,
      new Map([["a", { x: 195, y: 830 }]]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed.anchor).toBe("bottom");
    expect(placed.offsetX).toBe(0);
  });

  it("drops the second of two overlapping pills — the pin stays, the paint goes", () => {
    // The live report: `Little Switzerland by Van` over
    // `Georgia 2028 — Cat-Ski the Lesser Caucasus`. Short titles here so the
    // test pins the rule, not the estimate.
    const pins = [pin({ dtId: "a", title: "Ab" }), pin({ dtId: "b", title: "Cd" })];
    const placed = placeHomeLabels(
      pins,
      new Map([
        ["a", { x: 100, y: 400 }],
        ["b", { x: 130, y: 400 }],
      ]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed.map((p) => p.dtId)).toEqual(["a"]);
  });

  it("keeps neighbours with room — the cap is not a cull", () => {
    const pins = [pin({ dtId: "a", title: "Ab" }), pin({ dtId: "b", title: "Cd" })];
    const placed = placeHomeLabels(
      pins,
      new Map([
        ["a", { x: 100, y: 400 }],
        ["b", { x: 300, y: 400 }],
      ]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed.map((p) => p.dtId)).toEqual(["a", "b"]);
  });

  it("never re-sorts: input order (selected first) is placement priority", () => {
    const pins = [pin({ dtId: "sel", title: "Ab" }), pin({ dtId: "other", title: "Cd" })];
    const placed = placeHomeLabels(
      pins,
      new Map([
        ["sel", { x: 100, y: 400 }],
        ["other", { x: 130, y: 400 }],
      ]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed.map((p) => p.dtId)).toEqual(["sel"]);
  });

  it("leaves off-screen pins at their default placement — no lie for an invisible pin", () => {
    const pins = [pin({ dtId: "a", title: "Ski Week" }), pin({ dtId: "b", title: "Dolomites" })];
    const placed = placeHomeLabels(
      pins,
      new Map([
        ["a", { x: -1181, y: 200 }],
        ["b", { x: 118, y: 200 }],
      ]),
      PHONE_W,
      PHONE_H,
    );
    expect(placed).toEqual([
      { dtId: "a", anchor: "top", offsetX: 0 },
      { dtId: "b", anchor: "top", offsetX: 0 },
    ]);
  });

  it("keeps a label with no projection rather than dropping it", () => {
    const pins = [pin({ dtId: "a" })];
    expect(placeHomeLabels(pins, new Map(), PHONE_W, PHONE_H)).toEqual([
      { dtId: "a", anchor: "top", offsetX: 0 },
    ]);
  });
});
