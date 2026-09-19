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
 *   - the panel renders below the title row at full width, never inside it;
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
  useReusablePlaceholders: vi.fn(),
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

vi.mock("../lib/crew-placeholders", () => ({
  useReusablePlaceholders: mocks.useReusablePlaceholders,
}));

const { CrewPage } = await import("./CrewPage");
const { TripProvider } = await import("../components/theme");
const { EditModeProvider } = await import("../components/edit-mode");

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
        {/* The add interaction lives behind edit mode — opt in like the menu toggle does. */}
        <EditModeProvider tripId={trip.id} initial={true}>
          <MemoryRouter>
            <CrewPage />
          </MemoryRouter>
        </EditModeProvider>
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
  mocks.useReusablePlaceholders.mockReturnValue({ placeholders: [], loading: false });
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
    // the panel is a full-width block BELOW the title row — not squeezed into
    // the header next to "Copy invite link"
    const panel = container.querySelector("[data-crew-add-panel]");
    const header = container.querySelector("h1")?.parentElement;
    expect(panel).not.toBeNull();
    expect(header?.contains(panel!)).toBe(false);
    expect(header?.nextElementSibling).toBe(panel);
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

  it("a long follow list is searched, capped, and keeps the picked person visible", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      sub: `google-oauth2|p${i}`,
      name: `Person ${i}`,
    }));
    mocks.useFollowing.mockReturnValue({ people: many, loading: false });
    mount("owner");
    await openPanel();

    // capped at 8 with the rest behind the search box
    const chips = () => Array.from(container.querySelectorAll("button[aria-pressed]"));
    expect(chips()).toHaveLength(8);
    expect(container.textContent).toContain("4 more — search to narrow the list");

    const search = container.querySelector<HTMLInputElement>("#crew-add-search");
    expect(search).not.toBeNull();
    const type = async (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, "value",
      )!.set!;
      act(() => {
        setter.call(search, value);
        search!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
    };

    // pick "Person 3" first, then search for someone else: the picked chip
    // must survive the filter (it is what the Add button will submit)
    const person3 = chips().find((c) => c.textContent?.includes("Person 3"))!;
    act(() => {
      person3.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    await type("person 11");
    const afterSearch = chips();
    expect(afterSearch).toHaveLength(2);
    expect(afterSearch.map((c) => c.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Person 3"),
        expect.stringContaining("Person 11"),
      ]),
    );
    expect(afterSearch.find((c) => c.textContent?.includes("Person 3"))?.getAttribute("aria-pressed")).toBe("true");

    await type("nobody");
    expect(container.textContent).toContain("No one you follow matches");
    // …and still only the pinned selection is offered
    expect(chips()).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>("#crew-add-name")?.value).toBe("Person 3");
  });
});

describe("CrewPage link-a-shared-placeholder (#322)", () => {
  const REUSABLE = [
    {
      personId: "bbbb1111-2222-4333-8444-555566667777",
      name: "Nick Geelen",
      trips: [{ id: "t2", title: "Iceland 2026", role: "viewer" as const }],
    },
  ];

  it("links the placeholder already on another trip — id in the POST, no contact", async () => {
    mocks.useReusablePlaceholders.mockReturnValue({ placeholders: REUSABLE, loading: false });
    mount("owner");
    await openPanel();

    // the read is gated exactly like the follow list: owner + open panel
    expect(mocks.useReusablePlaceholders).toHaveBeenCalledWith("t1", true);

    const chip = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Nick Geelen"))!;
    expect(chip).toBeDefined();
    expect(chip.textContent).toContain("Iceland 2026"); // where they already are
    act(() => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // the label is prefilled and editable — it is THIS trip's own name
    expect(container.querySelector<HTMLInputElement>("#crew-add-name")?.value).toBe("Nick Geelen");
    expect(container.textContent).toContain("Name on this trip");
    expect(container.textContent).toContain("covers every trip they are already on");
    // the twin is shared, so its contact is not this trip's to set
    expect(container.querySelector("#crew-add-contact")).toBeNull();

    act(() => {
      button("Add")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mocks.addCrewMember).toHaveBeenCalledWith(
      "t1",
      { name: "Nick Geelen", role: "viewer", personId: "bbbb1111-2222-4333-8444-555566667777" },
      "test-token",
    );
  });

  it("an editor never loads the reuse list", async () => {
    mount("editor");
    await openPanel();

    expect(mocks.useReusablePlaceholders).toHaveBeenCalledWith("t1", false);
    expect(container.textContent).not.toContain("Already in one of your trips");
    expect(container.querySelector("#crew-add-contact")).not.toBeNull();
  });

  it("picking a followed account clears the linked placeholder (they are exclusive)", async () => {
    mocks.useReusablePlaceholders.mockReturnValue({ placeholders: REUSABLE, loading: false });
    mount("owner");
    await openPanel();

    const chip = (text: string) =>
      Array.from(container.querySelectorAll("button[aria-pressed]"))
        .find((b) => b.textContent?.includes(text))!;

    act(() => {
      chip("Nick Geelen").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    act(() => {
      chip("Frieda Friend").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    act(() => {
      button("Add")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // the account wins, and `personId` is gone — the server 422s on both
    expect(mocks.addCrewMember).toHaveBeenCalledWith(
      "t1",
      { name: "Frieda Friend", role: "viewer", sub: "google-oauth2|frieda" },
      "test-token",
    );
  });
});
