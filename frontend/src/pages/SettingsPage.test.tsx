// @vitest-environment jsdom
/**
 * Trip settings (#248) — the page the header's trip-level rows moved to.
 *
 * Mounted for real (jsdom + MemoryRouter), because everything worth pinning
 * here is an interaction: the stage/theme/visibility writes and their exact
 * payloads, the arm→confirm delete, the token-gated link copies, the TriCount
 * connect. The role gates are asserted on BOTH sides of every branch (pitfall
 * 16): an editor must not be offered the owner's rows, and a viewer/follower
 * must not be offered any of it — including the controls that only render for
 * an owner.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

const mocks = vi.hoisted(() => ({
  putTrip: vi.fn(),
  deleteTrip: vi.fn(),
  fetchJoinLink: vi.fn(),
  fetchFollowLink: vi.fn(),
  createFollowLink: vi.fn(),
  disableCrewInvite: vi.fn(),
  connectTricount: vi.fn(),
  clearTripCache: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
  }),
}));

// Keep the real TripAccessError (the page discriminates on it) and stub only
// the network functions.
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ...mocks };
});

const { SettingsPage } = await import("./SettingsPage");
const { TripProvider } = await import("../components/theme");
const { TripAccessError } = await import("../lib/api");

function settingsTrip(myRole: string | undefined, over: Partial<Trip> = {}): Trip {
  return {
    id: "t-248",
    slug: "settings-page",
    title: "Urban Legends & Neon Dreams",
    stage: "planned",
    visibility: "private",
    myRole: myRole as Trip["myRole"],
    theme: { preset: "ember" },
    locations: [],
    sections: [],
    crew: [],
    days: [],
    practical: {},
    ...over,
  } as unknown as Trip;
}

let container: HTMLDivElement;
let root: Root | null = null;

/** Echoes patches back like the server's canonical document would, so the
 *  optimistic paint and the applied doc agree. */
function Harness({ initial }: { initial: Trip }) {
  const [trip, setTrip] = useState(initial);
  return (
    <TripProvider trip={trip} apply={setTrip}>
      <MemoryRouter initialEntries={[`/t/${initial.id}/settings`]}>
        <Routes>
          <Route path="/t/:tripId/settings" element={<SettingsPage />} />
          <Route path="/" element={<div>LANDING</div>} />
        </Routes>
      </MemoryRouter>
    </TripProvider>
  );
}

function mount(trip: Trip) {
  mocks.putTrip.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...trip,
    ...patch,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness initial={trip} />);
  });
}

const text = () => container.textContent ?? "";
const $ = <T extends Element>(sel: string) => container.querySelector<T>(sel);

function selectValue(sel: string, value: string) {
  const select = $(sel) as HTMLSelectElement | null;
  expect(select, `${sel} renders`).not.toBeNull();
  act(() => {
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(el: Element | null, what: string) {
  expect(el, `${what} renders`).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function byText(sel: string, needle: string) {
  return Array.from(container.querySelectorAll(sel)).find((el) =>
    el.textContent?.includes(needle),
  );
}

/** Case-insensitive variant — the copy buttons flip their label once copied
 *  ("Copy follow link" → "Follow link copied"), so the second click has to
 *  find the same button by its stable stem. */
function byTextCI(sel: string, needle: string) {
  const want = needle.toLowerCase();
  return Array.from(container.querySelectorAll(sel)).find((el) =>
    el.textContent?.toLowerCase().includes(want),
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(mocks) as Array<ReturnType<typeof vi.fn>>) fn.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  vi.clearAllMocks();
});

describe("SettingsPage — role gating", () => {
  it("owner: every group renders", () => {
    mount(settingsTrip("owner"));
    for (const group of [
      "Trip identity",
      "Sharing",
      "Crew & invite",
      "Integrations",
      "Danger zone",
    ]) {
      expect(text(), group).toContain(group);
    }
    expect($("#settings-stage")).not.toBeNull();
    expect($("#settings-theme")).not.toBeNull();
    expect($("#settings-discoverable")).not.toBeNull();
  });

  it("editor: identity + crew, but none of the owner-only groups", () => {
    mount(settingsTrip("editor"));
    expect(text()).toContain("Trip identity");
    // The crew page is editor-reachable, so the section (and its link) stays…
    expect(text()).toContain("Crew & invite");
    expect($('a[href="/t/t-248/crew"]')).not.toBeNull();
    // …while every owner-only row is absent: no sharing, no invite links, no
    // integrations, no delete.
    expect(text()).not.toContain("Sharing");
    expect(text()).not.toContain("Copy crew join link");
    expect(text()).not.toContain("Disable crew invite");
    expect(text()).not.toContain("Copy follow link");
    expect(text()).not.toContain("Integrations");
    expect(text()).not.toContain("Danger zone");
    expect($("#settings-discoverable")).toBeNull();
  });

  it("viewer/follower/anonymous: the page renders nothing to act on", () => {
    for (const role of ["viewer", "follower", undefined]) {
      mount(settingsTrip(role));
      expect(text(), `role ${String(role)}`).toContain(
        "Trip settings are for this trip's editors.",
      );
      // No control of any kind reaches the DOM for them.
      expect(container.querySelectorAll("select, input, button")).toHaveLength(0);
      expect(text()).not.toContain("Danger zone");
      expect($('a[href="/t/t-248"]'), "a way back to the trip").not.toBeNull();
      if (root) {
        act(() => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });
});

describe("SettingsPage — trip identity writes", () => {
  it("stage: PUT carries exactly { stage } and the local doc follows", async () => {
    mount(settingsTrip("owner"));
    selectValue("#settings-stage", "live");
    await flush();
    expect(mocks.putTrip).toHaveBeenCalledTimes(1);
    const [id, patch, token] = mocks.putTrip.mock.calls[0];
    expect(id).toBe("t-248");
    expect(patch).toEqual({ stage: "live" });
    expect(token).toBe("test-token");
    expect(($("#settings-stage") as HTMLSelectElement).value).toBe("live");
  });

  it("stage: an editor is not offered a backward move (the server's rule, mirrored)", () => {
    mount(settingsTrip("editor"));
    const select = $("#settings-stage") as HTMLSelectElement;
    const disabled = Array.from(select.querySelectorAll("option"))
      .filter((o) => o.disabled)
      .map((o) => o.value);
    // planned → nothing behind it, and archive is the owner's alone.
    expect(disabled).toEqual(expect.arrayContaining(["idea", "options", "shortlist", "planned", "archive"]));
    expect(disabled).not.toContain("booked");
  });

  it("theme: PUT carries exactly { theme: { preset } } and the blurb follows", async () => {
    mount(settingsTrip("owner"));
    selectValue("#settings-theme", "sakura");
    await flush();
    const [, patch] = mocks.putTrip.mock.calls[0];
    expect(patch).toEqual({ theme: { preset: "sakura" } });
    expect(Object.keys(patch)).toEqual(["theme"]);
    expect((($("#settings-theme") as HTMLSelectElement).value)).toBe("sakura");
  });
});

describe("SettingsPage — sharing (owner only)", () => {
  it("visibility: PUT carries exactly { visibility }", async () => {
    mount(settingsTrip("owner"));
    const group = $('[role="group"][aria-label="Trip visibility"]');
    click(byText("button", "Public") ?? null, "the Public button");
    expect(group).not.toBeNull();
    await flush();
    expect(mocks.putTrip.mock.calls[0][1]).toEqual({ visibility: "public" });
  });

  it("discoverable: the checkbox writes the boolean the document carries", async () => {
    mount(settingsTrip("owner"));
    const box = $("#settings-discoverable") as HTMLInputElement;
    expect(box.checked).toBe(false);
    act(() => {
      box.click();
    });
    await flush();
    expect(mocks.putTrip.mock.calls[0][1]).toEqual({ discoverable: true });
    expect(($("#settings-discoverable") as HTMLInputElement).checked).toBe(true);
  });

  it("a rejected write surfaces the server's refusal and rolls the doc back", async () => {
    mount(settingsTrip("owner"));
    mocks.putTrip.mockRejectedValue(new TripAccessError(403, "forbidden"));
    click(byText("button", "Public") ?? null, "the Public button");
    await flush();
    expect(text()).toContain("Your role on this trip doesn't allow that change.");
    const group = $('[role="group"][aria-label="Trip visibility"]')!;
    const priv = Array.from(group.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Private"),
    )!;
    expect(priv.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("SettingsPage — crew & invite links", () => {
  it("copy join link puts the absolute URL on the clipboard", async () => {
    mount(settingsTrip("owner"));
    mocks.fetchJoinLink.mockResolvedValue("/join/claim-abc");
    click(byText("button", "Copy crew join link") ?? null, "the join-link button");
    await flush();
    expect(mocks.fetchJoinLink).toHaveBeenCalledWith("t-248", "test-token");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/join/claim-abc`,
    );
    expect(text()).toContain("Join link copied");
  });

  it("follow link: mints only when there is none yet, and never rotates one", async () => {
    mount(settingsTrip("owner"));
    mocks.fetchFollowLink.mockResolvedValue("/f/existing");
    click(byTextCI("button", "follow link") ?? null, "the follow-link button");
    await flush();
    expect(mocks.createFollowLink).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/f/existing`,
    );

    mocks.fetchFollowLink.mockResolvedValue(null);
    mocks.createFollowLink.mockResolvedValue("/f/fresh");
    click(byTextCI("button", "follow link") ?? null, "the follow-link button");
    await flush();
    expect(mocks.createFollowLink).toHaveBeenCalledWith("t-248", "test-token");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      `${window.location.origin}/f/fresh`,
    );
  });

  it("disable crew invite calls the owner-only route and reports it", async () => {
    mount(settingsTrip("owner"));
    mocks.disableCrewInvite.mockResolvedValue(undefined);
    click(byText("button", "Disable crew invite") ?? null, "the disable-invite button");
    await flush();
    expect(mocks.disableCrewInvite).toHaveBeenCalledWith("t-248", "test-token");
    expect(text()).toContain("Crew invite disabled");
  });
});

describe("SettingsPage — integrations", () => {
  it("unlinked: the owner gets the connect field, and submitting links it", async () => {
    const trip = settingsTrip("owner");
    mount(trip);
    mocks.connectTricount.mockImplementation(async (_id: string, key: string) => ({
      ...trip,
      practical: { tricount: { registryKey: key } },
    }));
    const input = $("#settings-tricount") as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "https://tricount.com/tAbC123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(byText("button", "Link TriCount") ?? null, "the Link TriCount button");
    await flush();
    expect(mocks.connectTricount).toHaveBeenCalledWith(
      "t-248",
      "https://tricount.com/tAbC123",
      "test-token",
    );
    // The canonical doc landed in the context: the field is gone for good.
    expect($("#settings-tricount")).toBeNull();
    expect(text()).toContain("TriCount · connected");
  });

  it("a refused link says so, next to the field", async () => {
    mount(settingsTrip("owner"));
    mocks.connectTricount.mockRejectedValue(new TripAccessError(403, "forbidden"));
    const input = $("#settings-tricount") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "tAbC123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(byText("button", "Link TriCount") ?? null, "the Link TriCount button");
    await flush();
    expect(text()).toContain("Only the trip owner can link a Tricount.");
    expect($("#settings-tricount")).not.toBeNull();
  });

  it("already linked: no field, and the balances stay on the practical page", () => {
    mount(
      settingsTrip("owner", {
        practical: { tricount: { registryKey: "t123" } } as Trip["practical"],
      }),
    );
    expect($("#settings-tricount")).toBeNull();
    expect(text()).toContain("TriCount · connected");
    expect($('a[href="/t/t-248/practical"]')).not.toBeNull();
  });
});

describe("SettingsPage — danger zone", () => {
  it("delete is arm → confirm: one click never fires the DELETE", async () => {
    mount(settingsTrip("owner"));
    const arm = byText("button", "Delete trip…");
    click(arm ?? null, "the arm button");
    expect(mocks.deleteTrip).not.toHaveBeenCalled();
    expect(text()).toContain("This cannot be undone.");
    // The armed panel carries the confirm + its own cancel.
    expect(byText("button", "Cancel")).not.toBeUndefined();
  });

  it("confirming deletes, clears the session cache and leaves for the landing", async () => {
    mount(settingsTrip("owner"));
    mocks.deleteTrip.mockResolvedValue(undefined);
    click(byText("button", "Delete trip…") ?? null, "the arm button");
    click(byText("button", "Delete trip") ?? null, "the confirm button");
    await flush();
    expect(mocks.deleteTrip).toHaveBeenCalledWith("t-248", "test-token");
    expect(mocks.clearTripCache).toHaveBeenCalled();
    expect(text()).toContain("LANDING");
  });

  it("a non-owner (the role moved under them) is told why, and stays", async () => {
    mount(settingsTrip("owner"));
    mocks.deleteTrip.mockRejectedValue(new TripAccessError(403, "forbidden"));
    click(byText("button", "Delete trip…") ?? null, "the arm button");
    click(byText("button", "Delete trip") ?? null, "the confirm button");
    await flush();
    expect(text()).toContain("Only the trip owner can delete this trip.");
    expect(text()).not.toContain("LANDING");
  });
});
