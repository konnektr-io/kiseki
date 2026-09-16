// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* #254 — the booklet is the printing surface, so a roadbook's practicalities
 * have to survive the trip to paper: each titled block renders as heading +
 * prose inside "Key info". MapLibre is the only heavy peripheral in here. */
vi.mock("../components/MapView", () => ({ TripMap: () => null }));

import { BookletPage } from "./BookletPage";
import { TripProvider } from "../components/theme";
import type { Trip } from "../lib/types";

function tripWith(practical: Trip["practical"]): Trip {
  return {
    id: "t-254",
    slug: "roadbook",
    title: "Roadbook trip",
    stage: "planned",
    visibility: "private",
    myRole: "owner",
    locations: [],
    sections: [],
    crew: [],
    days: [],
    practical,
  } as unknown as Trip;
}

function renderBooklet(practical: Trip["practical"]): string {
  return renderToString(
    createElement(TripProvider, {
      trip: tripWith(practical),
      apply: () => {},
      children: createElement(BookletPage),
    }),
  );
}

const BLOCKS = [
  // The issue's own acceptance case, headings verbatim.
  { title: "Driving times", body: "San José to Tortuguero: 3 h 30 + 1 h 30 boat" },
  { title: "Money & tipping", body: "10 % service charge; cash at the SINAC gates" },
  { title: "Water & health", body: "Tap water is fine in San José; repellent on the Caribbean coast" },
];

describe("booklet — titled practicalities blocks (#254)", () => {
  it("prints each block under its own heading, in list order", () => {
    const html = renderBooklet({ blocks: BLOCKS });
    expect(html).toContain("Driving times");
    expect(html).toContain("Tortuguero");
    expect(html).toMatch(/Money &(amp;)? tipping/);
    expect(html).toContain("SINAC gates");
    expect(html).toMatch(/Water &(amp;)? health/);
    const order = ["Driving times", /Money &(amp;)? tipping/, /Water &(amp;)? health/];
    const positions = order.map((s) =>
      typeof s === "string" ? html.indexOf(s) : html.search(s as RegExp),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps the Key info section when blocks are all a trip has", () => {
    // Blocks alone must be enough to render the section — a trip with no
    // contacts, no notes and no crew still needs its practicalities on paper.
    const html = renderBooklet({ blocks: BLOCKS });
    expect(html).toContain("Key info");
    expect(html).toContain("Driving times");
  });

  it("still prints the legacy notes blob, and a notes-only trip keeps the section", () => {
    const withBlob = renderBooklet({ notes: "Bring the puffer.", blocks: BLOCKS });
    expect(withBlob).toContain("Essentials");
    expect(withBlob).toContain("Bring the puffer.");
    expect(withBlob).toContain("Driving times");

    const onlyBlob = renderBooklet({ notes: "Bring the puffer." });
    expect(onlyBlob).toContain("Key info");
    expect(onlyBlob).toContain("Bring the puffer.");
    expect(onlyBlob).not.toContain("Driving times");
  });

  it("a trip with no practicalities at all does not print an empty section", () => {
    const html = renderBooklet({});
    expect(html).not.toContain("Key info");
    expect(html).not.toContain("Driving times");
  });
});

/* #315 — the printed group is the people coming. A follower reads the trip
 * online; they are not on it, so they never appear in the booklet. */
function crewTrip(crew: Trip["crew"]): Trip {
  return {
    id: "t-315",
    slug: "crew",
    title: "Crew trip",
    stage: "planned",
    visibility: "private",
    myRole: "owner",
    locations: [],
    sections: [],
    crew,
    days: [],
    practical: {},
  } as unknown as Trip;
}

function renderCrewBooklet(crew: Trip["crew"]): string {
  return renderToString(
    createElement(TripProvider, {
      trip: crewTrip(crew),
      apply: () => {},
      children: createElement(BookletPage),
    }),
  );
}

describe("booklet — the group is the crew, never the followers (#315)", () => {
  const MEMBERS = [
    { id: "u1", name: "Niko Owner", role: "owner", claimed: true },
    { id: "u2", name: "Alex Viewer", role: "viewer", claimed: false },
  ] as Trip["crew"];
  const FOLLOWER = { id: "u3", name: "Sam Follower", role: "follower", claimed: true } as Trip["crew"][number];

  it("prints the crew and drops every follower", () => {
    const html = renderCrewBooklet([...MEMBERS, FOLLOWER]);
    expect(html).toContain("Group");
    expect(html).toContain("Niko Owner");
    expect(html).toContain("Alex Viewer");
    expect(html).not.toContain("Sam Follower");
  });

  it("a trip whose only people are followers prints no Group block", () => {
    const html = renderCrewBooklet([FOLLOWER]);
    expect(html).not.toContain("Group");
    expect(html).not.toContain("Sam Follower");
    // …and with nothing else practical to say, no empty Key info section either
    expect(html).not.toContain("Key info");
  });
});
