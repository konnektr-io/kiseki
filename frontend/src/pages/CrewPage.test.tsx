/**
 * Crew page add/remove affordances (issue #198) — SSR assertions on the REAL
 * component through renderToString inside a TripProvider (the OverviewPage
 * pattern): CrewPage reads its trip synchronously from context, so no DOM is
 * needed.
 *
 * Gates under test (mirroring the server):
 * - add affordance: editor+ only;
 * - remove: owner-only, never on the owner row, follower rows only on a
 *   private trip (public trips stay link-readable, so revoking is not
 *   offered — a muted explanatory line renders instead).
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
    logout: async () => undefined,
  }),
}));

import { TripProvider } from "../components/theme";
import type { Person, Trip } from "../lib/types";
import { CrewPage } from "./CrewPage";

function crewTrip(args: {
  myRole?: string;
  visibility?: "public" | "private";
  crew?: Person[];
}): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test Trip",
    stage: "planned",
    visibility: args.visibility ?? "private",
    myRole: args.myRole,
    crew: args.crew ?? [],
    practical: {},
    days: [],
    sections: [],
    locations: [],
  } as unknown as Trip;
}

const OWNER: Person = { id: "p-owner", name: "Niko Owner", role: "owner", claimed: true };
const VIEWER: Person = { id: "p-viewer", name: "Alex Viewer", role: "viewer", claimed: false };
const FOLLOWER: Person = { id: "p-follower", name: "Sam Follower", role: "follower", claimed: true };

function renderCrew(trip: Trip): string {
  return renderToString(
    createElement(TripProvider, {
      trip,
      apply: () => {},
      children: createElement(MemoryRouter, null, createElement(CrewPage)),
    }),
  );
}

const removeLabel = (name: string) => `aria-label="Remove ${name} from the crew"`;

describe("CrewPage add/remove (#198)", () => {
  it("an owner sees the add affordance and remove controls (never on the owner row)", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER] }));
    expect(html).toContain("Add crew member");
    expect(html).toContain(removeLabel("Alex Viewer"));
    expect(html).not.toContain(removeLabel("Niko Owner"));
  });

  it("a viewer sees no add affordance and no remove control", () => {
    const html = renderCrew(crewTrip({ myRole: "viewer", crew: [OWNER, VIEWER] }));
    expect(html).not.toContain("Add crew member");
    expect(html).not.toContain(removeLabel("Alex Viewer"));
    expect(html).not.toContain(removeLabel("Niko Owner"));
  });

  it("an editor sees the add affordance but no remove control", () => {
    const html = renderCrew(crewTrip({ myRole: "editor", crew: [OWNER, VIEWER] }));
    expect(html).toContain("Add crew member");
    expect(html).not.toContain(removeLabel("Alex Viewer"));
  });

  it("a follower row on a PUBLIC trip renders no remove control (and the explanatory line)", () => {
    const html = renderCrew(
      crewTrip({ myRole: "owner", visibility: "public", crew: [OWNER, FOLLOWER] }),
    );
    expect(html).not.toContain(removeLabel("Sam Follower"));
    expect(html).toContain("stays readable by anyone holding the link");
  });

  it("a follower row on a PRIVATE trip is removable by the owner, with the promotion hint", () => {
    const html = renderCrew(
      crewTrip({ myRole: "owner", visibility: "private", crew: [OWNER, FOLLOWER] }),
    );
    expect(html).toContain(removeLabel("Sam Follower"));
    expect(html).toContain("Promote to Viewer or Editor");
  });

  it("an empty crew page still lets an editor+ add the first member", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [] }));
    expect(html).toContain("Crew not announced yet.");
    expect(html).toContain("Add crew member");
  });
});
