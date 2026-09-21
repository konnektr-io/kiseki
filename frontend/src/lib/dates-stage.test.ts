import { describe, expect, it } from "vitest";
import { displayStage, shouldShowToday } from "./dates";

/** Auto-live display decisions — issue #362.
 *
 *  `todayIso` is injected so the fallback derivation stays deterministic
 *  whatever day the suite runs on.
 */
describe("displayStage", () => {
  it("prefers the server effectiveStage when present", () => {
    expect(displayStage({ stage: "booked", effectiveStage: "live" })).toBe("live");
    expect(displayStage({ stage: "booked", effectiveStage: "booked" })).toBe("booked");
  });

  it("derives live for booked/planned in range on older servers (Albany)", () => {
    const albany = {
      stage: "booked" as const,
      startDate: "2026-09-21",
      endDate: "2026-09-25",
      timezone: "America/New_York",
    };
    // Fallback uses the trip-local "today" with no injectable day, so the
    // date-independent pins below carry the contract; the wide window reads
    // live on any run date, the past window reads stored.
    expect(
      displayStage({ ...albany, startDate: "2020-01-01", endDate: "2030-12-31" }),
    ).toBe("live");
    expect(
      displayStage({ ...albany, startDate: "2020-01-01", endDate: "2020-01-05" }),
    ).toBe("booked");
  });

  it("never derives live for early stages, archive, or undated trips", () => {
    const wide = { startDate: "2020-01-01", endDate: "2030-12-31" };
    expect(displayStage({ stage: "idea", ...wide })).toBe("idea");
    expect(displayStage({ stage: "options", ...wide })).toBe("options");
    expect(displayStage({ stage: "shortlist", ...wide })).toBe("shortlist");
    expect(displayStage({ stage: "archive", ...wide })).toBe("archive");
    expect(displayStage({ stage: "booked" })).toBe("booked");
  });
});

describe("shouldShowToday", () => {
  it("opens the Today surface for an in-range booked trip (server or fallback)", () => {
    const wide = {
      stage: "booked" as const,
      startDate: "2020-01-01",
      endDate: "2030-12-31",
      timezone: "America/New_York",
    };
    expect(shouldShowToday(wide)).toBe(true);
    expect(shouldShowToday({ ...wide, effectiveStage: "live" })).toBe(true);
    // Stored live still opens Today even out of range (pre-#362 behaviour).
    expect(
      shouldShowToday({ stage: "live", startDate: "2020-01-01", endDate: "2020-01-05" }),
    ).toBe(false); // out of range gates, as before
    expect(
      shouldShowToday(
        { stage: "live", startDate: "2020-01-01", endDate: "2030-12-31" },
        "2026-09-21",
      ),
    ).toBe(true);
  });
});
