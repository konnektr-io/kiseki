// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/* The #231 contract on the page that owns the grey area: the practical page
 * renders the TriCount card ONLY for a trip that actually has a connection.
 * An unlinked trip used to carry the owner's whole setup card at the top of
 * this page — for a trip that may never use TriCount, that was the wrong
 * prominence (the connect affordance now lives in the trip actions menu, see
 * `components/trip-controls.test.tsx`).
 *
 * SSR is enough here: both branches are plain render conditionals, and a
 * server render runs no effects, so the connected panel paints its
 * pre-fetch state deterministically. Every assertion is paired with a
 * positive one, so a page that rendered nothing at all cannot pass. */

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchTricountSnapshot: vi.fn() };
});

import { PracticalsPage } from "./PracticalsPage";
import { TripProvider } from "../components/theme";
import type { Trip } from "../lib/types";

function tripWith(practical: Trip["practical"], role = "owner"): Trip {
  return {
    id: "t-231",
    slug: "tricount-trip",
    title: "Tricount trip",
    stage: "planned",
    visibility: "private",
    myRole: role as Trip["myRole"],
    locations: [],
    sections: [],
    crew: [],
    days: [],
    // A todo keeps the page's own content on screen: the regression guard is
    // "the TriCount card is gone", never "the page is blank".
    practical: { todos: [{ label: "Book the ferry", done: false }], ...practical },
  } as unknown as Trip;
}

function renderPage(practical: Trip["practical"], role = "owner"): string {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ["/t/t-231/practical"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/t/:tripId/practical",
          element: createElement(TripProvider, {
            trip: tripWith(practical, role),
            apply: () => {},
            children: createElement(PracticalsPage),
          }),
        }),
      ),
    ),
  );
}

describe("practicals page — TriCount card (#231)", () => {
  it("owner, nothing linked: no TriCount card on the page at all", () => {
    const html = renderPage({});
    expect(html).not.toContain("TriCount");
    // The old setup copy is gone with it.
    expect(html).not.toContain("shared expense pot");
    // Positive control: the page rendered its real content.
    expect(html).toContain("Book the ferry");
  });

  it("owner, linked: the connected panel renders with the trip's TriCount link", () => {
    const html = renderPage({ tricount: { registryKey: "tAbC123" } });
    expect(html).toContain("TriCount");
    expect(html).toContain("Open in Tricount");
    expect(html).toContain("https://tricount.com/tAbC123");
    // The pre-fetch state, not an empty shell.
    expect(html).toContain("No data.");
    // And no connect field sneaks onto the page.
    expect(html).not.toContain("Tricount sharing link or key");
  });

  it("crew (viewer), nothing linked: no TriCount card — the page is not a settings surface", () => {
    const html = renderPage({}, "viewer");
    expect(html).not.toContain("TriCount");
    expect(html).toContain("Book the ferry");
  });

  it("follower, nothing linked: no TriCount card either", () => {
    const html = renderPage({}, "follower");
    expect(html).not.toContain("TriCount");
    expect(html).toContain("Book the ferry");
  });
});
