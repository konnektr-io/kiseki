// @vitest-environment jsdom
/**
 * Route wiring for the analytics pair (#295).
 *
 * `lib/posthog.test.ts` owns the pairing RULE (one `$pageleave` per `$pageview`,
 * beacon transport, no stray leave). This file owns the WIRING that decides when
 * a page is left, because that is where the defect lived: pageviews were attached
 * to the route, and nothing was attached to the two moments a page actually ends
 * — a navigation away, and leaving the app. Both show up only in a real mounted
 * tree (`renderToString` never runs the effects), so this mounts it in jsdom and
 * drives a real router.
 *
 * The counters are asserted against the ORDER of `capturePageleave` vs
 * `capturePageview` and vs `setAnalyticsTrip`, not just the counts: the leave has
 * to be raised while the ambient trip is still the page being left, otherwise the
 * beacon is tagged with the trip the visitor is arriving at.
 */
import { StrictMode, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ph = vi.hoisted(() => ({
  capturePageview: vi.fn(),
  capturePageleave: vi.fn(),
  setAnalyticsTrip: vi.fn(),
}));

// Only the analytics seam is faked; the router and React are real, so the effect
// ordering under test is the app's real ordering.
vi.mock("../lib/posthog", () => ({
  capturePageview: ph.capturePageview,
  capturePageleave: ph.capturePageleave,
  setAnalyticsTrip: ph.setAnalyticsTrip,
}));

const { AnalyticsPageviews } = await import("./AnalyticsPageviews");

const TRIP = "bf29a027-2ed2-46b3-b869-d9d81bbcf237";
const TRIP_PATH = `/t/${TRIP}/itinerary`;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let navigate: ((to: string) => void) | undefined;

/** Exposes the router's navigate so a test can move the user without a full load. */
function NavProbe() {
  const nav = useNavigate();
  useEffect(() => {
    navigate = nav;
  }, [nav]);
  return null;
}

function mount(initialPath = "/", strict = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree = (
    <MemoryRouter initialEntries={[initialPath]}>
      <AnalyticsPageviews />
      <NavProbe />
    </MemoryRouter>
  );
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

/** Move the user in-app (a pushState-style navigation, not a page load). */
async function go(path: string) {
  await act(async () => {
    navigate?.(path);
  });
}

/** Simulate the browser leaving the page. */
async function pageHide() {
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  navigate = undefined;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("AnalyticsPageviews — the pageleave half (#295)", () => {
  it("opens the pair on mount without leaving a page that was never shown", () => {
    mount("/");
    expect(ph.capturePageview).toHaveBeenCalledTimes(1);
    expect(ph.capturePageview).toHaveBeenCalledWith(undefined);
    expect(ph.capturePageleave).not.toHaveBeenCalled();
  });

  it("closes the page it is leaving before the next one opens", async () => {
    mount("/");
    await go(TRIP_PATH);

    expect(ph.capturePageview).toHaveBeenCalledTimes(2);
    expect(ph.capturePageleave).toHaveBeenCalledTimes(1);

    const leave = ph.capturePageleave.mock.invocationCallOrder[0];
    const arrive = ph.capturePageview.mock.invocationCallOrder[1];
    expect(leave).toBeLessThan(arrive);

    // The ambient trip must still be the OLD one when the leave is raised, so the
    // beacon belongs to the page that was actually left.
    const retag = ph.setAnalyticsTrip.mock.invocationCallOrder[1];
    expect(leave).toBeLessThan(retag);
    expect(ph.capturePageview).toHaveBeenLastCalledWith({ tripId: TRIP });
  });

  it("closes the open page when the visitor leaves the app", async () => {
    mount(TRIP_PATH);
    await pageHide();

    expect(ph.capturePageleave).toHaveBeenCalledTimes(1);
    // Raised with no argument: it closes whatever the ambient trip is, which is
    // how the listener survives every route change without being re-registered.
    expect(ph.capturePageleave).toHaveBeenCalledWith();
  });

  it("keeps one listener and one pageview under StrictMode's double mount", () => {
    // Without the effect cleanup, StrictMode's mount → unmount → mount would
    // register the pagehide listener twice and double-count the pageview.
    mount("/", true);
    expect(ph.capturePageview).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire the leave under StrictMode", async () => {
    mount("/", true);
    await pageHide();
    expect(ph.capturePageleave).toHaveBeenCalledTimes(1);
  });
});
