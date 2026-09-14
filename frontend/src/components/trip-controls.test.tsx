// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The #163 UI contract: the trip delete affordance lives in the top-right
 * TripActionsMenu, owner-only, and is a two-step arm→confirm — the plain
 * "Delete trip…" row must NEVER render the destructive confirm button by
 * itself (a single stray click must not fire an irreversible delete).
 *
 * We render the REAL TripActionsMenu with renderToString (no DOM needed for
 * the static contract — the open/closed + armed/unarmed render branches),
 * mocking the Auth0 hook (useTripWrite's context requirement; writes never
 * fire in a server render). Pitfall 16 discipline: assert the OWNER branch
 * AND the non-owner branch with the same expectations. */

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

import { TripActionsMenu } from "./trip-controls";
import { TripProvider } from "./theme";
import { TripAccessError } from "../lib/api";
import { DEFAULT_PRESET_ID, PRESET_IDS, presetById } from "../lib/theme-presets";
import type { Trip } from "../lib/types";

const apiMocks = vi.hoisted(() => ({ putTrip: vi.fn(), connectTricount: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, putTrip: apiMocks.putTrip, connectTricount: apiMocks.connectTricount };
});

function tripWithRole(role: string): Trip {
  return {
    id: "t-163",
    slug: "husk-trip",
    title: "Urban Legends & Neon Dreams",
    stage: "idea",
    visibility: "private",
    myRole: role as Trip["myRole"],
    locations: [],
    sections: [],
    crew: [],
    days: [],
    practical: {},
  } as unknown as Trip;
}

function renderMenu(role: string, opts: { onDeleted?: () => void } = {}): string {
  return renderToString(
    createElement(TripProvider, {
      trip: tripWithRole(role),
      apply: () => {},
      children: createElement(TripActionsMenu, {
        onDownloadPdf: () => {},
        ...(opts.onDeleted ? { onDeleted: opts.onDeleted } : {}),
      }),
    }),
  );
}

describe("TripActionsMenu delete affordance (#163)", () => {
  it("owner with onDeleted: menu is closed by default — the delete row is not reachable without opening it", () => {
    const html = renderMenu("owner", { onDeleted: () => {} });
    // The menu panel only renders when open; SSR renders the closed state.
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("Delete trip");
    // The trigger (kebab) is present in the header.
    expect(html).toContain('aria-label="Trip actions"');
  });

  it("viewer without onDeleted: no delete wiring reaches the DOM at all", () => {
    const html = renderMenu("viewer");
    expect(html).not.toContain("Delete trip");
    expect(html).not.toContain("Permanently delete");
  });

  it("owner WITHOUT onDeleted (caller opted out): delete row is absent", () => {
    // onDeleted is the caller's contract that delete navigation is wired;
    // without it the menu must not offer a delete that strands the user on
    // a dead route.
    const html = renderMenu("owner");
    expect(html).not.toContain("Permanently delete");
  });

  it("open menu (owner): shows the ARMED-state copy only as a warning, gated behind the arm step", () => {
    // Simulate the armed state by rendering with the internal state forced
    // open+armed is not possible via SSR props — instead assert the static
    // contract: the closed render carries no destructive confirm button,
    // so the ONLY path to it is open → arm → confirm (two clicks).
    const html = renderMenu("owner", { onDeleted: () => {} });
    expect(html).not.toContain("Permanently delete");
    expect(html).not.toContain("bg-destructive");
    expect(html).not.toContain("This cannot be undone");
  });
});

/* The #200 contract: the trip theme picker lives in the same overflow menu,
 * editor-gated like the Stage select. SSR only renders the CLOSED menu, so
 * these mount for real (jsdom) and open the menu with a click — the pattern
 * TripLayout.test.tsx established for anything the closed render can't show.
 *
 * Writes never leave the mock: putTrip is stubbed and the assertions pin its
 * exact payload (preset-only, never a retired field riding along). */
describe("TripActionsMenu theme picker (#200)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiMocks.putTrip.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    vi.clearAllMocks();
  });

  function StatefulHarness({ initial }: { initial: Trip }) {
    const [trip, setTrip] = useState(initial);
    return createElement(TripProvider, {
      trip,
      apply: setTrip,
      children: createElement(TripActionsMenu, { onDownloadPdf: () => {} }),
    });
  }

  function mountMenu(trip: Trip) {
    // Echo the patch like the server's canonical document would.
    apiMocks.putTrip.mockImplementation(async (_id: string, patch: unknown) => ({ ...trip, ...(patch as object) }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(StatefulHarness, { initial: trip }));
    });
  }

  function openMenu() {
    const trigger = container.querySelector('button[aria-label="Trip actions"]');
    expect(trigger, "menu trigger renders").not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function themeSelect(): HTMLSelectElement | null {
    return container.querySelector('select[aria-label="Trip theme"]');
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("editor: the open menu offers a Theme select listing all 12 presets in order", () => {
    mountMenu({ ...tripWithRole("editor"), theme: { preset: "ember" } });
    openMenu();
    const select = themeSelect();
    expect(select, "editor sees the theme picker").not.toBeNull();
    expect(select!.value).toBe("ember");
    const options = Array.from(select!.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(PRESET_IDS);
    expect(PRESET_IDS).toHaveLength(12);
    // Labels are the capitalised preset ids — no `name` field on the preset.
    expect(options.map((o) => o.textContent)).toEqual(
      PRESET_IDS.map((id) => id.charAt(0).toUpperCase() + id.slice(1)),
    );
    // The selected preset's blurb reads below the select.
    expect(container.textContent).toContain(presetById("ember").blurb);
  });

  it("editor without a theme: the picker falls back to the default preset, never blank", () => {
    const trip = tripWithRole("editor");
    delete (trip as { theme?: unknown }).theme;
    mountMenu(trip);
    openMenu();
    const select = themeSelect();
    expect(select, "editor sees the theme picker").not.toBeNull();
    expect(select!.value).toBe(DEFAULT_PRESET_ID);
    expect(container.textContent).toContain(presetById(DEFAULT_PRESET_ID).blurb);
  });

  it("viewer and anonymous: no Theme row in the open menu", () => {
    for (const role of ["viewer", undefined]) {
      const trip = tripWithRole("viewer");
      trip.myRole = role as Trip["myRole"];
      mountMenu(trip);
      openMenu();
      expect(themeSelect(), `role ${String(role)} sees no theme picker`).toBeNull();
      if (root) {
        act(() => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });

  it("choosing a preset calls putTrip with exactly { theme: { preset } }", async () => {
    const trip = { ...tripWithRole("editor"), theme: { preset: "alpine" } };
    mountMenu(trip);
    openMenu();
    const select = themeSelect();
    expect(select).not.toBeNull();
    act(() => {
      select!.value = "sakura";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(apiMocks.putTrip).toHaveBeenCalledTimes(1);
    const [id, patch, token] = apiMocks.putTrip.mock.calls[0];
    expect(id).toBe(trip.id);
    expect(patch).toEqual({ theme: { preset: "sakura" } });
    expect(Object.keys(patch as object)).toEqual(["theme"]);
    expect(Object.keys((patch as { theme: object }).theme)).toEqual(["preset"]);
    expect(token).toBe("test-token");
    // The optimistic paint follows: the blurb tracks the new selection.
    expect(container.textContent).toContain(presetById("sakura").blurb);
  });
});

/* The #231 contract: an unlinked trip shows NO TriCount card on the practical
 * page (that is the issue — "for trips that aren't using tricount (yet), this
 * is too prominent and irrelevant"), so the connect affordance moves into the
 * trip actions menu, owner-gated like the connect route itself (#111) and only
 * while nothing is linked. Same jsdom-open pattern as #200: the closed render
 * cannot show any of it. Every gate is asserted on BOTH sides (owner vs
 * editor/viewer/anonymous) per pitfall 16. */
describe("TripActionsMenu TriCount integration (#231)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiMocks.connectTricount.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    vi.clearAllMocks();
  });

  function StatefulHarness({ initial }: { initial: Trip }) {
    const [trip, setTrip] = useState(initial);
    return createElement(TripProvider, {
      trip,
      apply: setTrip,
      children: createElement(TripActionsMenu, { onDownloadPdf: () => {} }),
    });
  }

  function mountMenu(trip: Trip) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(StatefulHarness, { initial: trip }));
    });
  }

  function openMenu() {
    const trigger = container.querySelector('button[aria-label="Trip actions"]');
    expect(trigger, "menu trigger renders").not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function keyInput(): HTMLInputElement | null {
    return container.querySelector('input[aria-label="Tricount sharing link or key"]');
  }

  function typeKey(value: string) {
    const input = keyInput();
    expect(input, "the TriCount field is there to type into").not.toBeNull();
    act(() => {
      // React owns the value; go through the native setter so onChange fires.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input!, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function submitForm() {
    const form = container.querySelector("form");
    expect(form, "the TriCount form renders").not.toBeNull();
    act(() => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("owner, nothing linked: the open menu offers the TriCount field in an Integrations group", () => {
    mountMenu(tripWithRole("owner"));
    openMenu();
    expect(keyInput(), "owner sees the TriCount field").not.toBeNull();
    expect(container.textContent).toContain("Integrations");
    // It sits in the settings group, below a separator — not loose at the top.
    expect(container.querySelectorAll('[role="separator"]').length).toBeGreaterThan(0);
  });

  it("owner, already linked: no field here — the connected panel owns the trip's TriCount", () => {
    const trip = tripWithRole("owner");
    trip.practical = { tricount: { registryKey: "t123" } } as Trip["practical"];
    mountMenu(trip);
    openMenu();
    expect(container.querySelector('[role="menu"]'), "the menu really is open").not.toBeNull();
    expect(keyInput()).toBeNull();
  });

  it("editor/viewer/anonymous, nothing linked: never offered the field", () => {
    for (const role of ["editor", "viewer", undefined]) {
      const trip = tripWithRole("editor");
      trip.myRole = role as Trip["myRole"];
      mountMenu(trip);
      openMenu();
      expect(container.querySelector('[role="menu"]'), "the menu really is open").not.toBeNull();
      expect(keyInput(), `role ${String(role)} sees no TriCount field`).toBeNull();
      expect(container.textContent, `role ${String(role)} sees no Integrations group`).not.toContain(
        "Integrations",
      );
      if (root) {
        act(() => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });

  it("submitting a key links it — exact API args, menu closes, the trip becomes connected", async () => {
    const trip = tripWithRole("owner");
    apiMocks.connectTricount.mockImplementation(async (_id: string, key: string) => ({
      ...trip,
      practical: { ...trip.practical, tricount: { registryKey: key } },
    }));
    mountMenu(trip);
    openMenu();
    typeKey("https://tricount.com/tAbC123");
    submitForm();
    await flush();
    expect(apiMocks.connectTricount).toHaveBeenCalledTimes(1);
    const [id, key, token] = apiMocks.connectTricount.mock.calls[0];
    expect(id).toBe(trip.id);
    // The whole pasted link is handed over — the server normalises it.
    expect(key).toBe("https://tricount.com/tAbC123");
    expect(token).toBe("test-token");
    // Success closes the menu...
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // ...and the canonical doc landed in the trip context: reopening now shows
    // a CONNECTED trip, so the link field is gone for good.
    openMenu();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(keyInput()).toBeNull();
  });

  it("a rejected link says why, next to the field, and leaves the menu open", async () => {
    mountMenu(tripWithRole("owner"));
    openMenu();
    apiMocks.connectTricount.mockRejectedValue(new TripAccessError(403, "forbidden"));
    typeKey("tAbC123");
    submitForm();
    await flush();
    expect(container.querySelector('[role="menu"]'), "menu stays open").not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Only the trip owner can link a Tricount.",
    );
  });
});
