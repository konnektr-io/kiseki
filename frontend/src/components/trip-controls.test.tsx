// @vitest-environment jsdom
/**
 * The header's overflow menu after #248.
 *
 * The menu is now the thin end of the header: what is per-visit (the booklet
 * PDF, for every role) plus a LINK to the trip settings page for editor+.
 * Everything else it used to hold — stage, theme, sharing, the join/follow
 * links, the TriCount connect, delete — moved to `/t/<id>/settings`, and this
 * file pins that they are gone from here: a regression that re-grows the menu
 * would show up as one of those rows reappearing.
 *
 * The menu renders a router `<Link>`, so these mount into a real DOM inside a
 * MemoryRouter (the closed SSR render cannot show an open menu — pitfall 16's
 * rule, asserted on BOTH role branches).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

const { TripActionsMenu } = await import("./trip-controls");
const { TripProvider } = await import("./theme");

function tripWithRole(role: string | undefined): Trip {
  return {
    id: "t-248",
    slug: "settings-page",
    title: "Urban Legends & Neon Dreams",
    stage: "planned",
    visibility: "private",
    myRole: role as Trip["myRole"],
    locations: [],
    sections: [],
    crew: [],
    days: [],
    practical: {},
  } as unknown as Trip;
}

let container: HTMLDivElement;
let root: Root | null = null;

function mount(role: string | undefined, onDownloadPdf: () => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TripProvider trip={tripWithRole(role)} apply={() => {}}>
        <MemoryRouter>
          <TripActionsMenu onDownloadPdf={onDownloadPdf} />
        </MemoryRouter>
      </TripProvider>,
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

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  vi.clearAllMocks();
});

describe("TripActionsMenu after #248", () => {
  it("closed by default: only the kebab trigger reaches the DOM", () => {
    mount("owner");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.textContent).not.toContain("Download booklet PDF");
    expect(container.textContent).not.toContain("Trip settings");
  });

  it("everyone: the open menu offers the booklet PDF and nothing else", () => {
    for (const role of ["viewer", "follower", undefined]) {
      mount(role);
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
      mount(role);
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
    mount("owner");
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
    mount("owner", onDownloadPdf);
    openMenu();
    const pdf = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Download booklet PDF"),
    );
    expect(pdf).not.toBeUndefined();
    act(() => {
      pdf!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDownloadPdf).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
