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
import { EditModeProvider } from "../components/edit-mode";
import type { Person, ProfilePerson, Trip } from "../lib/types";
import { AddCrewPanel, CrewPage } from "./CrewPage";

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

function renderCrew(trip: Trip, editMode: boolean): string {
  return renderToString(
    createElement(TripProvider, {
      trip,
      apply: () => {},
      children: createElement(EditModeProvider, {
        tripId: trip.id,
        initial: editMode,
        children: createElement(MemoryRouter, null, createElement(CrewPage)),
      }),
    }),
  );
}

const removeLabel = (name: string) => `aria-label="Remove ${name} from the crew"`;

describe("CrewPage add/remove (#198)", () => {
  it("an owner sees the add affordance and remove controls (never on the owner row)", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER] }), true);
    expect(html).toContain("Add crew member");
    expect(html).toContain(removeLabel("Alex Viewer"));
    expect(html).not.toContain(removeLabel("Niko Owner"));
  });

  it("a viewer sees no add affordance and no remove control", () => {
    const html = renderCrew(crewTrip({ myRole: "viewer", crew: [OWNER, VIEWER] }), false);
    expect(html).not.toContain("Add crew member");
    expect(html).not.toContain(removeLabel("Alex Viewer"));
    expect(html).not.toContain(removeLabel("Niko Owner"));
  });

  it("an editor sees the add affordance but no remove control", () => {
    const html = renderCrew(crewTrip({ myRole: "editor", crew: [OWNER, VIEWER] }), true);
    expect(html).toContain("Add crew member");
    expect(html).not.toContain(removeLabel("Alex Viewer"));
  });

  it("a follower row on a PUBLIC trip renders no remove control (and the explanatory line)", () => {
    const html = renderCrew(
      crewTrip({ myRole: "owner", visibility: "public", crew: [OWNER, FOLLOWER] }),
    true,
    );
    expect(html).not.toContain(removeLabel("Sam Follower"));
    expect(html).toContain("stays readable by anyone holding the link");
  });

  it("a follower row on a PRIVATE trip is removable by the owner, with the promotion hint", () => {
    const html = renderCrew(
      crewTrip({ myRole: "owner", visibility: "private", crew: [OWNER, FOLLOWER] }),
    true,
    );
    expect(html).toContain(removeLabel("Sam Follower"));
    expect(html).toContain("Promote to Viewer or Editor");
  });

  it("an empty crew page still lets an editor+ add the first member", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [] }), true);
    expect(html).toContain("Crew not announced yet.");
    expect(html).toContain("Add crew member");
  });
  it("an owner with edit mode OFF reads: names render, no add/remove chrome", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER] }), false);
    expect(html).toContain("Niko Owner");
    expect(html).toContain("Alex Viewer");
    expect(html).not.toContain("Add crew member");
    expect(html).not.toContain("Remove Alex Viewer from the crew");
    expect(html).not.toContain("Remove Niko Owner from the crew");
  });
});

describe("CrewPage profile links (#196)", () => {
  it("a claimed crew member renders a link to /u/<percent-encoded sub>", () => {
    const claimed: Person = {
      id: "google-oauth2|100613034256980569871",
      name: "Niko Claimed",
      role: "editor",
      claimed: true,
    };
    const html = renderCrew(crewTrip({ myRole: "viewer", crew: [claimed] }), false);
    expect(html).toContain('href="/u/google-oauth2%7C100613034256980569871"');
    expect(html).toContain("Niko Claimed");
  });

  it("an unclaimed placeholder does NOT render its name as a link", () => {
    const placeholder: Person = {
      id: "0f1e2d3c-4b5a-6789-abcd-ef0123456789",
      name: "Alex Placeholder",
      role: "viewer",
      claimed: false,
    };
    const html = renderCrew(crewTrip({ myRole: "viewer", crew: [placeholder] }), false);
    expect(html).toContain("Alex Placeholder");
    expect(html).not.toContain('href="/u/');
  });
});

describe("Add crew from the people you follow (#198 follow-up)", () => {
  const FOLLOWING: ProfilePerson[] = [
    { sub: "google-oauth2|frieda", name: "Frieda Friend" },
    { sub: "google-oauth2|sam", name: "Sam Stranger" },
  ];

  function renderPanel(args: {
    isOwner?: boolean;
    following?: ProfilePerson[];
    crewIds?: string[];
    loading?: boolean;
  }): string {
    return renderToString(
      createElement(AddCrewPanel, {
        busy: false,
        isOwner: args.isOwner ?? true,
        following: args.following ?? FOLLOWING,
        crewIds: args.crewIds ?? ["google-oauth2|me"],
        loadingFollowing: args.loading ?? false,
        onAdd: async () => true,
        onClose: () => {},
      }),
    );
  }

  it("an owner gets the picker: the people they follow are rendered as buttons", () => {
    const html = renderPanel({});
    expect(html).toContain("People you follow");
    expect(html).toContain("Frieda Friend");
    expect(html).toContain("Sam Stranger");
    expect(html).toContain('aria-pressed="false"');
    // the account path explains itself before you click
    expect(html).toContain("they join this trip right away");
  });

  it("someone already ON the crew is not offered a second time", () => {
    const html = renderPanel({ crewIds: ["google-oauth2|me", "google-oauth2|sam"] });
    expect(html).toContain("Frieda Friend");
    expect(html).not.toContain("Sam Stranger");
  });

  it("an editor gets the manual form and never the picker (server is owner-only)", () => {
    const html = renderPanel({ isOwner: false });
    expect(html).not.toContain("People you follow");
    expect(html).not.toContain("Frieda Friend");
    // …and the placeholder path is unchanged, contact field included
    expect(html).toContain("Add crew member");
    expect(html).toContain("Contact (optional)");
  });

  it("says what it is doing instead of rendering an empty list", () => {
    const loading = renderPanel({ loading: true });
    expect(loading).toContain("Loading people you follow");
    const empty = renderPanel({ following: [] });
    expect(empty).toContain("add someone by name below and share the invite link");
    expect(empty).toContain("Contact (optional)");
  });

  it("caps a long follow list at 8 chips and offers a search box", () => {
    const many: ProfilePerson[] = Array.from({ length: 12 }, (_, i) => ({
      sub: `google-oauth2|p${i}`,
      name: `Person ${i}`,
    }));
    const html = renderPanel({ following: many });
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(8);
    expect(html).toContain('id="crew-add-search"');
    // SSR inserts a comment node between the count and the text: match loosely
    expect(html).toMatch(/4(<!-- -->)? more — search to narrow the list/);
    // above the cap there is no search box at all — nothing to narrow
    const few = renderPanel({ following: FOLLOWING });
    expect(few).not.toContain('id="crew-add-search"');
  });
});

describe("CrewPage followers are their own section (#315)", () => {
  it("renders the crew and the followers as two sections, follower rows inside the followers one", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER, FOLLOWER] }), false);
    const anchor = html.indexOf('id="followers"');
    expect(anchor).toBeGreaterThan(-1);
    const [crew, followers] = [html.slice(0, anchor), html.slice(anchor)];
    // the crew list is the people coming — a follower is not one of them
    expect(crew).toContain("Niko Owner");
    expect(crew).toContain("Alex Viewer");
    expect(crew).not.toContain("Sam Follower");
    expect(followers).toContain("Sam Follower");
    expect(followers).toContain("Followers");
    // the heading says what they are; the row does not repeat the role badge
    expect(followers).not.toContain(">Follower<");
  });

  it("no followers, no section (and the word never leaks into the page)", () => {
    const html = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER] }), false);
    expect(html).not.toContain('id="followers"');
    expect(html).not.toContain("Follower");
  });

  it("a trip whose only people are followers still says the crew is unannounced", () => {
    const html = renderCrew(crewTrip({ myRole: "viewer", crew: [FOLLOWER] }), false);
    expect(html).toContain("Crew not announced yet.");
    expect(html).toContain('id="followers"');
    expect(html).toContain("Sam Follower");
  });

  it("the title row wraps as a unit and the button labels never break mid-word", () => {
    // The geometry (two lines instead of wrapped labels at 390px) is asserted
    // in the browser probe; this pins the classes that make it so. `h-8 px-3`
    // is the sm Button box, so this counts BUTTONS only — Badge carries
    // whitespace-nowrap too.
    const label = "h-8 px-3 whitespace-nowrap";
    const count = (html: string) => (html.match(new RegExp(label, "g")) ?? []).length;
    const withPlaceholder = renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, VIEWER] }), true);
    expect(withPlaceholder).toContain("flex flex-wrap items-center justify-between gap-2");
    expect(withPlaceholder).not.toContain("flex items-center justify-between gap-2");
    // add crew member + copy invite link (the viewer is an unclaimed placeholder)
    expect(count(withPlaceholder)).toBe(2);
    // …and the invite button is the placeholder's alone: a settled crew keeps
    // just the add button
    expect(count(renderCrew(crewTrip({ myRole: "owner", crew: [OWNER, FOLLOWER] }), true))).toBe(1);
    expect(count(renderCrew(crewTrip({ myRole: "owner", crew: [OWNER] }), true))).toBe(1);
  });
});
