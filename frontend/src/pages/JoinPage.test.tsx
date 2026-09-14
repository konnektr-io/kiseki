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
  fetchTripByFollow: vi.fn(),
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
    fetchTripByFollow: mocks.fetchTripByFollow,
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
  // Default: the link is a join link, so the follow-link fallback (#197) is
  // never consulted. Follow-link tests override both halves.
  mocks.fetchTripByFollow.mockRejectedValue(new Error("Unknown follow link"));
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

describe("JoinPage follow link (#197)", () => {
  it("renders a follow-only page — no crew list, no 'This is me'", async () => {
    mocks.fetchTripByClaim.mockRejectedValue(new Error("Unknown join link"));
    mocks.fetchTripByFollow.mockResolvedValue(TRIP);
    mount();
    await flush();

    expect(container.textContent).toContain("Follow this trip");
    expect(container.textContent).not.toContain("You're invited");
    // The credential held is read+follow only — claiming must not be offered.
    expect(container.textContent).not.toContain("This is me");
    expect(container.textContent).not.toContain("Niko Claimed");
  });

  it("follows with the follow token, not the claim token", async () => {
    mocks.fetchTripByClaim.mockRejectedValue(new Error("Unknown join link"));
    mocks.fetchTripByFollow.mockResolvedValue(TRIP);
    mocks.followTrip.mockResolvedValue(TRIP);
    mount();
    await flush();

    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Follow this trip",
    );
    expect(button).toBeTruthy();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The third argument is the whole point: the same URL param is sent as a
    // followToken, which the server can never treat as a claim.
    expect(mocks.followTrip).toHaveBeenCalledWith("claim-123", "test-token", "follow");
  });
});
