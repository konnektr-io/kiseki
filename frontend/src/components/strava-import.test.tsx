// @vitest-environment jsdom
/**
 * Trip ⋮ → "Import from Strava" (#449).
 *
 * The dialog is where the two things that must not be taken on trust live:
 *
 *  1. **The consent line is a GATE, not a note.** Strava's API policy and the
 *     trip's own visibility both hinge on the human having agreed that this
 *     recording becomes part of the trip — so an unticked box disables the
 *     import, and the request carries `consent: true` only when it was ticked.
 *  2. **A conflict is stated, never resolved silently.** "Already imported" and
 *     "that block already has a track" (a crewmate's recording) are visible
 *     outcomes, and neither one pretends something was written.
 *
 * The defaults are asserted explicitly: both ticks start ON (the defaults-on
 * rule) — a regression that flips them to OFF would make an import silently
 * lossy for photos.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

const h = vi.hoisted(() => ({
  auth: { getAccessTokenSilently: async () => "test-token" },
  fetchStravaActivities: vi.fn(),
  importStravaActivity: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => h.auth }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchStravaActivities: h.fetchStravaActivities,
    importStravaActivity: h.importStravaActivity,
  };
});

const { StravaImportDialog } = await import("./strava-import");
const { TripProvider } = await import("./theme");

const DAY_16 = "day-2027-02-16";
const DAY_17 = "day-2027-02-17";
const BLOCK = "block-sunshine";

function makeTrip(): Trip {
  return {
    id: "trip-449",
    slug: "canada-2027",
    title: "Canada 2027",
    stage: "planned",
    visibility: "private",
    myRole: "editor",
    locations: [],
    sections: [],
    crew: [],
    days: [
      { id: DAY_16, date: "2027-02-16", title: "Sunshine", blocks: [] },
      { id: DAY_17, date: "2027-02-17", title: "Revelstoke", blocks: [] },
    ],
    practical: {},
  } as unknown as Trip;
}

const ACTIVITY = {
  id: 11_111_111,
  name: "Sunshine Village morning",
  sport_type: "Snowboard",
  local_date: "2027-02-16",
  distance_m: 12_800,
  moving_time_s: 9_400,
  elapsed_time_s: 14_200,
  elevation_gain_m: 1_180,
  start_latlng: [51.0789, -115.7867],
  photo_count: 2,
  suggested: { day_id: DAY_16, block_id: BLOCK },
  imported: null,
};

/** The import response: the document PLUS the report, exactly as the API sends it. */
function importedDoc(): Trip {
  const trip = makeTrip();
  trip.days[0].blocks = [
    {
      id: BLOCK,
      kind: "activity",
      title: "Sunshine full day",
      track: `/media/${trip.id}/abc.gpx`,
      images: [],
      links: [{ label: "View on Strava", url: "https://www.strava.com/activities/11111111" }],
    } as unknown as Trip["days"][number]["blocks"][number],
  ];
  return trip;
}

let container: HTMLDivElement;
let root: Root | null = null;
let closed = 0;

function Harness({ onClose }: { onClose: () => void }) {
  const [trip, setTrip] = useState<Trip>(makeTrip());
  return (
    <TripProvider trip={trip} apply={setTrip}>
      <StravaImportDialog onClose={onClose} />
      <output data-testid="block-count">{String(trip.days[0].blocks.length)}</output>
    </TripProvider>
  );
}

async function mount() {
  closed = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness onClose={() => void (closed += 1)} />);
  });
  await act(async () => {}); // flush the activity fetch
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function importButton(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => (b.textContent ?? "").trim() === "Import",
  );
  expect(button, "an Import button renders").not.toBeUndefined();
  return button!;
}

function daySelect(): HTMLSelectElement {
  return document.body.querySelector<HTMLSelectElement>("select")!;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.fetchStravaActivities.mockReset();
  h.importStravaActivity.mockReset();
  h.fetchStravaActivities.mockResolvedValue({ activities: [ACTIVITY], scopes: "read activity:read_all" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe("Strava import dialog", () => {
  it("lists the trip's activities with the suggested day preselected", async () => {
    await mount();
    // The dialog is PORTALLED to <body>: the trip header carries a
    // backdrop-filter, which makes it the containing block for position:fixed
    // descendants — in place, the overlay was clipped to the header's 60 px
    // box (measured 430×60, panel at y = -545).
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Sunshine Village morning");
    expect(document.body.textContent).toContain("2027-02-16");
    expect(document.body.textContent).toContain("12.8 km");
    expect(document.body.textContent).toContain("1180 m up");
    expect(daySelect().value).toBe(DAY_16);
  });

  it("starts with both ticks ON — consent and photos", async () => {
    await mount();
    const [consent, photos] = checkboxes();
    expect(consent.checked).toBe(true);
    expect(photos.checked).toBe(true);
    expect(importButton().disabled).toBe(false);
  });

  it("refuses to import without the consent tick", async () => {
    await mount();
    const [consent] = checkboxes();
    await act(async () => {
      consent.click();
    });
    expect(importButton().disabled).toBe(true);
    expect(importButton().title).toContain("consent");
    expect(h.importStravaActivity).not.toHaveBeenCalled();
  });

  it("posts the chosen day, the suggestion's block and both ticks", async () => {
    h.importStravaActivity.mockResolvedValue({
      doc: importedDoc(),
      result: {
        written: true,
        conflict: null,
        day_id: DAY_16,
        block_id: BLOCK,
        track: "abc.gpx",
        photos: { written: 2, failed: 0, total: 2 },
        consent: true,
      },
    });
    await mount();
    await act(async () => {
      importButton().click();
    });

    expect(h.importStravaActivity).toHaveBeenCalledTimes(1);
    const [tripId, token, body] = h.importStravaActivity.mock.calls[0];
    expect(tripId).toBe("trip-449");
    expect(token).toBe("test-token");
    expect(body).toEqual({
      activity_id: ACTIVITY.id,
      day_id: DAY_16,
      block_id: BLOCK,
      include_photos: true,
      consent: true,
    });
    // The returned document is applied to the trip (the block count moved).
    expect(container.querySelector('[data-testid="block-count"]')!.textContent).toBe("1");
    expect(document.body.textContent).toContain("Track added to the day · 2 photos");
  });

  it("imports onto a day the human picks instead", async () => {
    h.importStravaActivity.mockResolvedValue({
      doc: importedDoc(),
      result: {
        written: true,
        conflict: null,
        day_id: DAY_17,
        block_id: null,
        track: "abc.gpx",
        photos: { written: 0, failed: 0, total: 0 },
        consent: true,
      },
    });
    await mount();
    const select = daySelect();
    await act(async () => {
      select.value = DAY_17;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      importButton().click();
    });
    expect(h.importStravaActivity.mock.calls[0][2]).toMatchObject({ day_id: DAY_17 });
  });

  it("respects an unticked photo box", async () => {
    h.importStravaActivity.mockResolvedValue({
      doc: importedDoc(),
      result: {
        written: true,
        conflict: null,
        day_id: DAY_16,
        block_id: BLOCK,
        track: "abc.gpx",
        photos: { written: 0, failed: 0, total: 0 },
        consent: true,
      },
    });
    await mount();
    const [, photos] = checkboxes();
    await act(async () => {
      photos.click();
    });
    await act(async () => {
      importButton().click();
    });
    expect(h.importStravaActivity.mock.calls[0][2]).toMatchObject({ include_photos: false });
  });

  it("states a track_exists conflict instead of claiming a write", async () => {
    h.importStravaActivity.mockResolvedValue({
      doc: makeTrip(),
      result: {
        written: false,
        conflict: "track_exists",
        day_id: DAY_16,
        block_id: BLOCK,
        track: "existing.gpx",
        photos: { written: 0, failed: 0, total: 0 },
        consent: true,
      },
    });
    await mount();
    await act(async () => {
      importButton().click();
    });
    expect(document.body.textContent).toContain("already has a track");
    expect(container.querySelector('[data-testid="block-count"]')!.textContent).toBe("0");
  });

  it("shows a reconnect message when Strava refuses the connection", async () => {
    const { TripAccessError } = await import("../lib/api");
    h.fetchStravaActivities.mockRejectedValue(new TripAccessError(401, "not connected"));
    await mount();
    expect(document.body.textContent).toContain("Strava is not connected in this browser");
  });

  it("says so when no activity falls on a day of the trip", async () => {
    h.fetchStravaActivities.mockResolvedValue({ activities: [], scopes: "read activity:read_all" });
    await mount();
    expect(document.body.textContent).toContain("No Strava activity falls on a day of this trip");
  });

  it("closes on Escape", async () => {
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
  });
});