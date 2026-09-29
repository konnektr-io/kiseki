import { describe, expect, it } from "vitest";
import { displayStage, isPastTrip, shouldShowToday } from "./dates";

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
    // live on any run date, the past window now reads `archive` (#396) — the
    // whole point of the change, and the assertion that used to say "booked".
    expect(
      displayStage({ ...albany, startDate: "2020-01-01", endDate: "2030-12-31" }),
    ).toBe("live");
    expect(
      displayStage({ ...albany, startDate: "2020-01-01", endDate: "2020-01-05" }),
    ).toBe("archive");
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

/** Auto-archive (#396) — the read-side mirror, with `todayIso` injected so
 *  the contract is date-independent. */
describe("displayStage auto-archive", () => {
  const albany = { startDate: "2026-09-21", endDate: "2026-09-25" };

  it("retires a trip whose end date has passed", () => {
    expect(displayStage({ stage: "live", ...albany }, "2026-09-26")).toBe("archive");
    expect(displayStage({ stage: "live", ...albany }, "2026-10-01")).toBe("archive");
    // A `booked`/`planned` trip that ended must not keep presenting as an
    // upcoming plan — the exact hole #362 left.
    expect(displayStage({ stage: "booked", ...albany }, "2026-09-26")).toBe("archive");
    expect(displayStage({ stage: "planned", ...albany }, "2026-09-26")).toBe("archive");
  });

  it("treats the end date as inclusive — the last day is still live", () => {
    expect(displayStage({ stage: "booked", ...albany }, "2026-09-25")).toBe("live");
    expect(displayStage({ stage: "live", ...albany }, "2026-09-25")).toBe("live");
    expect(displayStage({ stage: "booked", ...albany }, "2026-09-26")).toBe("archive");
  });

  it("never archives a future-dated trip someone marked live early", () => {
    expect(
      displayStage({ stage: "live", startDate: "2027-02-15", endDate: "2027-03-02" }, "2026-09-29"),
    ).toBe("live");
    expect(
      displayStage({ stage: "live", startDate: "2027-02-15", endDate: "2027-03-02" }, "2027-03-03"),
    ).toBe("archive");
  });

  it("never archives early stages, archives, or undated trips", () => {
    const past = "2026-10-01";
    expect(displayStage({ stage: "idea", ...albany }, past)).toBe("idea");
    expect(displayStage({ stage: "options", ...albany }, past)).toBe("options");
    expect(displayStage({ stage: "shortlist", ...albany }, past)).toBe("shortlist");
    expect(displayStage({ stage: "archive", ...albany }, past)).toBe("archive");
    expect(displayStage({ stage: "live" }, past)).toBe("live");
    expect(displayStage({ stage: "live", startDate: "2020-01-01" }, past)).toBe("live");
  });

  it("defers to the server's effectiveStage when it carries one", () => {
    // A server that still derives only auto-live (#362, no #396) reports
    // `live`; the client must render that, not second-guess it — otherwise
    // rolling the backend out before the frontend would be a regression.
    expect(displayStage({ stage: "live", effectiveStage: "live", ...albany }, "2026-10-01")).toBe("live");
  });
});

describe("isPastTrip", () => {
  it("is true only after the end date, and false without one", () => {
    const t = { startDate: "2026-09-21", endDate: "2026-09-25" };
    expect(isPastTrip(t, "2026-09-25")).toBe(false);
    expect(isPastTrip(t, "2026-09-26")).toBe(true);
    expect(isPastTrip({ startDate: "2026-09-21" }, "2026-10-01")).toBe(false);
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
