// @vitest-environment jsdom
/**
 * Add someone you already follow to the crew (#198 follow-up) — the INTERACTION
 * the SSR suite cannot see.
 *
 * The picker only exists once the owner opens the add panel and clicks a chip,
 * so this mounts the real CrewPage into a DOM (the JoinPage.test.tsx pattern)
 * with `../lib/following` and `../lib/api` stubbed. Gates under test:
 *   - the follow list is fetched ONLY for an owner who opened the panel
 *     (`useFollowing(sub, enabled)` — an editor never triggers a profile read);
 *   - people already on the crew are not offered;
 *   - picking one switches the entry to the ACCOUNT mode: trip label prefilled,
 *     contact gone (it belongs to their profile), and the POST carries `sub`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Person, Trip } from "../lib/types";

const mocks = vi.hoisted(() => ({
  addCrewMember: vi.fn(),
  useFollowing: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { sub: "google-oauth2|me" },
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
    logout: async () => undefined,
  }),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, addCrewMember: mocks.addCrewMember };
});

vi.mock("../lib/following", () => ({ useFollowing: mocks.useFollowing }));

const { CrewPage } = await import("./CrewPage");
const { TripProvider } = await import("../components/theme");

const OWNER: Person = { id: "google-oauth2|me", name: "Niko Owner", role: "owner", claimed: true };
const ON_CREW: Person = {
  id: "google-oauth2|sam",
  name: "Sam On Crew",
  role: "viewer",
  claimed: true,
};
const FOLLOWING = [
  { sub: "google-oauth2|frieda", name: "Frieda Friend" },
  { sub: "google-oauth2|sam", name: "Sam Stranger" },
];

function crewTrip(myRole: string): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test Trip",
    stage: "planned",
    visibility: "private",
    myRole,
    crew: [OWNER, ON_CREW],
    practical: {},
    days: [],
    sections: [],
    locations: [],
  } as unknown as Trip;
}

let container: HTMLDivElement;
let root: Root;

function mount(myRole: string) {
  const trip = crewTrip(myRole);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <TripProvider trip={trip} apply={() => {}}>
        <MemoryRouter>
          <CrewPage />
        </MemoryRouter>
      </TripProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
}

async function openPanel() {
  act(() => {
    button("Add crew member")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.useFollowing.mockReturnValue({ people: FOLLOWING, loading: false });
  mocks.addCrewMember.mockResolvedValue(crewTrip("owner"));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("CrewPage add-from-following (#198 follow-up)", () => {
  it("offers the people the owner follows, minus anyone already on the crew", async () => {
    mount("owner");
    await openPanel();

    expect(mocks.useFollowing).toHaveBeenCalledWith("google-oauth2|me", true);
    expect(container.textContent).toContain("People you follow");
    // the followed account that is already crew is not offered twice
    const chips = Array.from(container.querySelectorAll("button[aria-pressed]"));
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("Frieda Friend");
  });

  it("picking someone adds them AS that account — trip label, no contact, sub in the POST", async () => {
    mount("owner");
    await openPanel();

    act(() => {
      container
        .querySelector("button[aria-pressed]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const nameField = container.querySelector<HTMLInputElement>("#crew-add-name");
    expect(nameField?.value).toBe("Frieda Friend");
    expect(container.textContent).toContain("Name on this trip");
    expect(container.textContent).toContain("adds them straight to the crew");
    // contact belongs to their own profile — never part of an account add
    expect(container.querySelector("#crew-add-contact")).toBeNull();

    act(() => {
      button("Add")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mocks.addCrewMember).toHaveBeenCalledWith(
      "t1",
      { name: "Frieda Friend", role: "viewer", sub: "google-oauth2|frieda" },
      "test-token",
    );
  });

  it("an editor gets the manual form and never loads the follow list", async () => {
    mount("editor");
    await openPanel();

    expect(mocks.useFollowing).toHaveBeenCalledWith("google-oauth2|me", false);
    expect(container.textContent).not.toContain("People you follow");
    expect(container.querySelector("#crew-add-contact")).not.toBeNull();
  });
});
