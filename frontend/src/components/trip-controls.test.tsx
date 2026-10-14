// @vitest-environment jsdom
/**
 * The header's overflow menu after #248, and its account rows after #423.
 *
 * The menu is the thin end of the header: what is per-visit (the account rows
 * and the booklet PDF) and the per-trip Edit mode toggle for editor+, plus a
 * LINK to the trip settings page for editor+. Everything it used to hold —
 * stage, theme, sharing, the join/follow links, the TriCount connect, delete —
 * moved to `/t/<id>/settings`, and this file pins that they are gone from here:
 * a regression that re-grows the menu would show up as one of those rows
 * reappearing.
 *
 * #423 shipped three rules the trip page had no affordance for at all:
 *   1. the booklet PDF is offered to SIGNED-IN readers only (presentation —
 *      `/booklet.pdf` keeps its own visibility gate);
 *   2. `Follow this trip` — the #197 endpoint's second caller — for a signed-in
 *      reader on a PUBLIC trip they have no role on, greyed while signed out;
 *   3. `Sign in`, returning to the trip (`appState.returnTo`).
 *
 * The menu renders a router `<Link>`, so these mount into a real DOM inside a
 * MemoryRouter (the closed SSR render cannot show an open menu — pitfall 16's
 * rule, asserted on BOTH role branches). The follow case is mounted through a
 * stateful harness, because `apply()` is what makes the followed document (and
 * with it `myRole: follower`) reach the menu — a stub `apply` would prove the
 * click fires and nothing about the row disappearing.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

const h = vi.hoisted(() => ({
  auth: {
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: vi.fn(async () => undefined),
  },
  /** `isAuthConfigured()` — false is the secret-link, no-Auth0 deployment. */
  authConfigured: true,
  followPublicTrip: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => h.auth }));

vi.mock("../lib/auth", () => ({ isAuthConfigured: () => h.authConfigured }));

// Keep the real module (TripAccessError, the other endpoints) and stub only the
// one call the account rows make.
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, followPublicTrip: h.followPublicTrip };
});

const { TripAccessError } = await import("../lib/api");
const { TripActionsMenu } = await import("./trip-controls");
const { TripProvider } = await import("./theme");
const { EditModeProvider } = await import("./edit-mode");

/** The menu's trip, with the two fields the account rows read. */
function tripWith({
  role,
  visibility = "private",
}: {
  role?: string;
  visibility?: "public" | "private";
}): Trip {
  return {
    id: "t-248",
    slug: "settings-page",
    title: "Urban Legends & Neon Dreams",
    stage: "planned",
    visibility,
    myRole: role as Trip["myRole"],
    locations: [],
    sections: [],
    crew: [],
    days: [],
    practical: {},
  } as unknown as Trip;
}

/** TripLayout's own wiring: `apply` replaces the document in place, so the
 *  menu re-renders against whatever the API just returned. */
function Harness({
  initial,
  onDownloadPdf,
  editMode,
}: {
  initial: Trip;
  onDownloadPdf: () => void;
  editMode?: boolean;
}) {
  const [trip, setTrip] = useState(initial);
  return (
    <TripProvider trip={trip} apply={setTrip}>
      <EditModeProvider tripId={trip.id} initial={editMode}>
        <MemoryRouter>
          <TripActionsMenu onDownloadPdf={onDownloadPdf} />
        </MemoryRouter>
      </EditModeProvider>
    </TripProvider>
  );
}

let container: HTMLDivElement;
let root: Root | null = null;

function mount({
  role,
  visibility,
  signedOut = false,
  onDownloadPdf = () => {},
  editMode,
}: {
  role?: string;
  visibility?: "public" | "private";
  signedOut?: boolean;
  onDownloadPdf?: () => void;
  editMode?: boolean;
} = {}) {
  h.auth.isAuthenticated = !signedOut;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Harness
        initial={tripWith({ role, visibility })}
        onDownloadPdf={onDownloadPdf}
        editMode={editMode}
      />,
    );
  });
}

function openMenu() {
  const trigger = container.querySelector('button[aria-label="Trip actions"]');
  expect(trigger, "menu trigger renders").not.toBeNull();
  act(() => {
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The row whose visible text starts with `label`, trigger excluded. */
function row(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) =>
      b.getAttribute("aria-label") !== "Trip actions" &&
      (b.textContent ?? "").trim().startsWith(label),
  );
}

/** A menu row by its visible text; null when it is not rendered. */
function hasText(text: string): boolean {
  return (container.textContent ?? "").includes(text);
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.authConfigured = true;
  h.auth.isAuthenticated = true;
  h.auth.loginWithRedirect.mockClear();
  h.followPublicTrip.mockReset();
  // jsdom here has no localStorage (opaque origin) — the edit-mode toggle
  // persists per trip, so give it a Map-backed store per test.
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  });
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  window.localStorage?.clear();
  vi.clearAllMocks();
});

describe("TripActionsMenu after #248", () => {
  it("closed by default: only the kebab trigger reaches the DOM", () => {
    mount({ role: "owner" });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.textContent).not.toContain("Download booklet PDF");
    expect(container.textContent).not.toContain("Trip settings");
  });

  it("everyone: the open menu offers the booklet PDF and nothing else", () => {
    for (const role of ["viewer", "follower", undefined]) {
      mount({ role });
      openMenu();
      expect(container.querySelector('[role="menu"]'), "the menu really is open").not.toBeNull();
      expect(container.textContent).toContain("Download booklet PDF");
      expect(container.textContent, `role ${String(role)} gets no settings entry`).not.toContain(
        "Trip settings",
      );
      if (root) {
        act(() => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });

  it("editor+: the menu links to /t/<id>/settings", () => {
    for (const role of ["editor", "owner"]) {
      mount({ role });
      openMenu();
      const link = container.querySelector('a[href="/t/t-248/settings"]');
      expect(link, `role ${role} sees the settings link`).not.toBeNull();
      expect(link!.textContent).toContain("Trip settings");
      expect(link!.getAttribute("role")).toBe("menuitem");
      if (root) {
        act(() => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });

  it("the moved trip-level rows are GONE from the owner's menu (#248)", () => {
    mount({ role: "owner" });
    openMenu();
    const text = container.textContent ?? "";
    for (const moved of [
      "Delete trip",
      "Stage",
      "Theme",
      "Sharing",
      "Integrations",
      "Copy crew join link",
      "Copy follow link",
      "Disable crew invite",
    ]) {
      expect(text, `"${moved}" belongs on the settings page, not the menu`).not.toContain(moved);
    }
    // ...and no stray text inputs / selects are left behind either.
    expect(container.querySelectorAll("select, input")).toHaveLength(0);
  });

  it("the PDF row downloads and closes the menu", () => {
    const onDownloadPdf = vi.fn();
    mount({ role: "owner", onDownloadPdf });
    openMenu();
    const pdf = row("Download booklet PDF");
    expect(pdf).not.toBeUndefined();
    act(() => {
      pdf!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDownloadPdf).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("editor+: the menu offers the Edit mode toggle, off until opted in", () => {
    mount({ role: "owner", editMode: false });
    openMenu();
    const toggle = container.querySelector('button[role="menuitemcheckbox"]');
    expect(toggle, "the Edit mode row renders").not.toBeNull();
    expect(toggle!.textContent).toContain("Edit mode");
    expect(toggle!.textContent).toContain("Off");
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
  });

  it("toggling edit mode flips the switch and persists it per trip", () => {
    mount({ role: "owner", editMode: false });
    openMenu();
    const toggle = container.querySelector('button[role="menuitemcheckbox"]') as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toContain("On");
    expect(window.localStorage.getItem("kiseki:edit-mode:t-248")).toBe("1");
  });

  it("viewer: no Edit mode row in the menu", () => {
    mount({ role: "viewer" });
    openMenu();
    expect(container.querySelector('button[role="menuitemcheckbox"]')).toBeNull();
    expect(container.textContent).not.toContain("Edit mode");
  });
});

describe("TripActionsMenu account rows (#423)", () => {
  it("signed out on a public trip: Sign in + a greyed Follow, and NO booklet row", () => {
    mount({ signedOut: true, visibility: "public" });
    openMenu();

    expect(hasText("Sign in")).toBe(true);
    const follow = row("Follow this trip");
    expect(follow, "the follow row is offered").not.toBeUndefined();
    expect(follow!.disabled, "but it is not actionable without a session").toBe(true);
    expect(hasText("Download booklet PDF"), "the booklet is a member feature now").toBe(false);

    // The sign-in row is the whole point of the (1)-row: it comes BACK here.
    act(() => {
      row("Sign in")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(h.auth.loginWithRedirect).toHaveBeenCalledWith({
      appState: { returnTo: window.location.pathname },
    });
  });

  it("signed in on a public trip with no role: Follow is live, no Sign in row", () => {
    mount({ visibility: "public" });
    openMenu();
    expect(row("Follow this trip")!.disabled).toBe(false);
    expect(hasText("Sign in")).toBe(false);
    expect(hasText("Download booklet PDF")).toBe(true);
  });

  it("a follower is already on the trip: no follow row", () => {
    mount({ role: "follower", visibility: "public" });
    openMenu();
    expect(hasText("Follow this trip")).toBe(false);
    expect(hasText("Download booklet PDF")).toBe(true);
  });

  it("a private trip is invite-only on the by-id path: no follow row", () => {
    mount({ visibility: "private" });
    openMenu();
    expect(hasText("Follow this trip")).toBe(false);
    expect(hasText("Download booklet PDF")).toBe(true);
  });

  it("following applies the canonical document, so the row becomes the booklet", async () => {
    h.followPublicTrip.mockResolvedValue(tripWith({ role: "follower", visibility: "public" }));
    mount({ visibility: "public" });
    openMenu();

    await act(async () => {
      row("Follow this trip")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(h.followPublicTrip).toHaveBeenCalledWith("t-248", "test-token");
    expect(hasText("Follow this trip"), "the role is on the trip now").toBe(false);
    expect(hasText("Download booklet PDF")).toBe(true);
    // ...and the menu stayed open across it (the reader watches the change).
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("a refused follow is one line where the button is — never swallowed", async () => {
    // A private trip 403s ("can only be followed with an invite link"); the app
    // says so in place instead of a silent dead click.
    h.followPublicTrip.mockRejectedValue(
      new TripAccessError(403, "A private trip can only be followed with an invite link"),
    );
    mount({ visibility: "public" });
    openMenu();

    await act(async () => {
      row("Follow this trip")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("can only be followed with an invite link");
    expect(hasText("Follow this trip"), "the row stays to retry").toBe(true);
  });

  it("no Auth0 configured (secret-link mode): no account rows, so no menu at all", () => {
    h.authConfigured = false;
    mount({ signedOut: true, visibility: "public" });
    expect(container.querySelector('button[aria-label="Trip actions"]')).toBeNull();
    expect(hasText("Sign in")).toBe(false);
    expect(hasText("Follow this trip")).toBe(false);
  });

  it("no Auth0 configured, but signed in: the booklet is the menu", () => {
    h.authConfigured = false;
    mount({ role: "owner" });
    openMenu();
    expect(hasText("Download booklet PDF")).toBe(true);
    expect(hasText("Sign in")).toBe(false);
    expect(hasText("Follow this trip")).toBe(false);
  });
});
