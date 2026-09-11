// @vitest-environment jsdom
/**
 * Join page claimed state (issue #198).
 *
 * A crew row whose identity is already linked to an account
 * (`person.claimed === true`) must not offer a working claim: it renders a
 * DISABLED "Already joined" button, while unclaimed rows keep the enabled
 * "This is me". The server-side 409 stays as the backstop for the genuine
 * race (kept untouched in handleClaim) — this test pins the pre-submit hint.
 *
 * JoinPage fetches its trip in an effect, so (like TripLayout.test.tsx) this
 * mounts the REAL component into a DOM instead of renderToString.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

const mocks = vi.hoisted(() => ({
  fetchTripByClaim: vi.fn(),
  claimIdentity: vi.fn(),
  followTrip: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
    logout: async () => undefined,
  }),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchTripByClaim: mocks.fetchTripByClaim,
    claimIdentity: mocks.claimIdentity,
    followTrip: mocks.followTrip,
  };
});

const { JoinPage } = await import("./JoinPage");

const TRIP = {
  id: "b16680e7-a338-4c76-9cd7-fa13d45be594",
  slug: "canada-2027",
  title: "Canada 2027",
  stage: "planned",
  visibility: "private",
  crew: [
    { id: "p-claimed", name: "Niko Claimed", role: "owner", claimed: true },
    { id: "p-open", name: "Alex Open", role: "viewer", claimed: false },
  ],
  practical: {},
  days: [],
  sections: [],
  locations: [],
} as unknown as Trip;

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/join/claim-123"]}>
        <Routes>
          <Route path="/join/:claimToken" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Flush pending microtasks + effects inside act(). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.fetchTripByClaim.mockResolvedValue(TRIP);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("JoinPage claimed rows are taken (#198)", () => {
  it("renders exactly one enabled 'This is me' — the claimed row gets a disabled 'Already joined'", async () => {
    mount();
    await flush();

    const buttons = Array.from(container.querySelectorAll("button"));
    const claimButtons = buttons.filter((b) => b.textContent === "This is me");
    expect(claimButtons).toHaveLength(1);
    expect(claimButtons[0].disabled).toBe(false);

    const joinedButtons = buttons.filter((b) => b.textContent === "Already joined");
    expect(joinedButtons).toHaveLength(1);
    expect(joinedButtons[0].disabled).toBe(true);
    expect(joinedButtons[0].getAttribute("aria-label")).toContain("linked to an account");
    expect(joinedButtons[0].getAttribute("aria-label")).toContain("Niko Claimed");
  });

  it("marks the taken button disabled in the rendered html", async () => {
    mount();
    await flush();

    // A real `disabled` button, not a visually-muted one.
    expect(container.innerHTML).toContain("disabled=\"\"");
    expect(container.innerHTML).toContain("Already joined");
  });
});
