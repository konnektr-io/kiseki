import { describe, expect, it } from "vitest";
import { gmapsSearchUrl } from "./gmaps";

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

  it("prefers an explicit venue query over the name", () => {
    const p = params(gmapsSearchUrl("Niseko", { query: "Park Hyatt Niseko Hanazono" }));
    expect(p.query).toBe("Park Hyatt Niseko Hanazono");
    expect(p.query_place_id).toBeUndefined();
  });

  it("uses the place_id deep-link form when present", () => {
    const p = params(
      gmapsSearchUrl("Niseko", {
        query: "Park Hyatt Niseko",
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      }),
    );
    expect(p.query).toBe("Niseko");
    expect(p.query_place_id).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  });
});
