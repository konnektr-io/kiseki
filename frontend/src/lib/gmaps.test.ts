import { describe, expect, it } from "vitest";
import { gmapsDirectionsUrl, gmapsSearchUrl } from "./gmaps";

function params(url: string): Record<string, string> {
  expect(url.startsWith("https://www.google.com/maps/search/?")).toBe(true);
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(url).searchParams) out[k] = v;
  return out;
}

describe("gmapsSearchUrl", () => {
  it("falls back to the bare name", () => {
    expect(params(gmapsSearchUrl("Niseko, Japan"))).toEqual({
      api: "1",
      query: "Niseko, Japan",
    });
  });

  // #220 P2: the free-text venue-query override (Block.mapsQuery) is gone —
  // a venue is named by its place_id, so the bare name is the only fallback.

  it("uses the place_id deep-link form when present", () => {
    const p = params(
      gmapsSearchUrl("Niseko", { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" }),
    );
    expect(p.query).toBe("Niseko");
    expect(p.query_place_id).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  });
});

function dirParams(url: string): Record<string, string> {
  expect(url.startsWith("https://www.google.com/maps/dir/?")).toBe(true);
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(url).searchParams) out[k] = v;
  return out;
}

describe("gmapsDirectionsUrl", () => {
  it("builds a plain origin/destination link defaulting to driving", () => {
    const p = dirParams(gmapsDirectionsUrl("Banff", "Lake Louise"));
    expect(p).toEqual({
      api: "1",
      origin: "Banff",
      destination: "Lake Louise",
      travelmode: "driving",
    });
  });

  it("sends place ids alongside the queries when both ends resolve", () => {
    const p = dirParams(
      gmapsDirectionsUrl("Banff", "Lake Louise", {
        originPlaceId: "ORIGIN-ID",
        destinationPlaceId: "DEST-ID",
      }),
    );
    expect(p.origin).toBe("Banff");
    expect(p.destination).toBe("Lake Louise");
    expect(p.origin_place_id).toBe("ORIGIN-ID");
    expect(p.destination_place_id).toBe("DEST-ID");
    expect(p.travelmode).toBe("driving");
  });

  it("sends only the resolving end's id (mixed)", () => {
    const p = dirParams(
      gmapsDirectionsUrl("Banff", "Nowhereville", { originPlaceId: "ORIGIN-ID" }),
    );
    expect(p.origin_place_id).toBe("ORIGIN-ID");
    expect(p.destination_place_id).toBeUndefined();
  });
});
