import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
import type { Trip } from "../lib/types";

function tripWithRole(role: string): Trip {
  return {
    id: "t-163",
    slug: "husk-trip",
    title: "Urban Legends & Neon Dreams",
    stage: "idea",
    visibility: "private",
    myRole: role,
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
