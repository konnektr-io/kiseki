/**
 * Edit-mode gate (reading/editor split) — SSR assertions on the REAL hook
 * through renderToString inside a TripProvider (the CrewPage pattern):
 * edit mode OFF (or no provider) renders the reading tree for every role,
 * and only editor+ with the mode ON sees edit chrome.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TripProvider } from "./theme";
import { EditModeProvider, useCanEdit } from "./edit-mode";
import type { Trip } from "../lib/types";

function tripWithRole(myRole: string | undefined): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test Trip",
    stage: "planned",
    visibility: "private",
    myRole,
    crew: [],
    practical: {},
    days: [],
    sections: [],
    locations: [],
  } as unknown as Trip;
}

function Probe() {
  const canEdit = useCanEdit();
  return createElement("span", null, canEdit ? "CAN-EDIT" : "READ-ONLY");
}

function renderGate(myRole: string | undefined, initial?: boolean, withProvider = true): string {
  const probe = createElement(Probe);
  const inner = withProvider
    ? createElement(EditModeProvider, { tripId: "t1", initial, children: probe })
    : probe;
  return renderToString(
    createElement(TripProvider, { trip: tripWithRole(myRole), apply: () => {}, children: inner }),
  );
}

describe("edit-mode gate (useCanEdit)", () => {
  it("an owner WITHOUT the provider reads (safe default — booklet/tests)", () => {
    expect(renderGate("owner", undefined, false)).toContain("READ-ONLY");
  });

  it("an owner with edit mode OFF reads", () => {
    expect(renderGate("owner", false)).toContain("READ-ONLY");
  });

  it("an owner with edit mode ON can edit", () => {
    expect(renderGate("owner", true)).toContain("CAN-EDIT");
  });

  it("an editor with edit mode ON can edit", () => {
    expect(renderGate("editor", true)).toContain("CAN-EDIT");
  });

  it("a viewer with edit mode ON still reads (role gate holds)", () => {
    expect(renderGate("viewer", true)).toContain("READ-ONLY");
  });

  it("signed-out (no role) with edit mode ON still reads", () => {
    expect(renderGate(undefined, true)).toContain("READ-ONLY");
  });
});
