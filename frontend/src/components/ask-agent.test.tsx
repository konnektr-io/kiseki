// @vitest-environment jsdom
/**
 * The ask-agent button (#296, phase 2) — the bridge from a day/block/section
 * into the trip chat drawer.
 *
 * Both halves of the gate (#104 rule): anonymous (signed out) and viewer see
 * NO chrome; editor+ gets the button, and clicking it dispatches the bridge
 * event carrying the entity context (ids + values for the composer — the
 * intent LOG in phase 3 records names only, never these values).
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({ isAuthenticated: authState.isAuthenticated }),
}));

const intentMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/edit-intent", () => ({ logEditIntent: intentMock }));

vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

const { AskAgentButton } = await import("./ask-agent");
const { TripProvider } = await import("./theme");
const { ASK_AGENT_EVENT } = await import("../lib/ask-agent");
import type { AskAgentContext } from "../lib/ask-agent";
import type { Trip } from "../lib/types";

const CONTEXT: AskAgentContext = {
  entity: "day",
  id: "d1",
  label: "Day 1 — Rest day",
  fields: ["title", "notes"],
  draft: "About Day 1 — “Rest day” (day_id=d1):\n\n",
};

function tripWithRole(myRole: string | undefined): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test trip",
    stage: "planned",
    myRole: myRole as Trip["myRole"],
    locations: [],
    days: [],
  } as unknown as Trip;
}

let container: HTMLDivElement;
let root: Root;

function mount(myRole: string | undefined, context: AskAgentContext | null = CONTEXT) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(TripProvider, {
        trip: tripWithRole(myRole),
        apply: () => {},
        children: createElement(AskAgentButton, { context, variant: "full" }),
      }),
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  authState.isAuthenticated = true;
  intentMock.mockClear();
});

describe("AskAgentButton gating", () => {
  it("signed out: no chrome", () => {
    authState.isAuthenticated = false;
    mount("editor");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("viewer: no chrome", () => {
    mount("viewer");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("anonymous role: no chrome", () => {
    mount(undefined);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("null context: no chrome even for an editor", () => {
    mount("editor", null);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("editor: the button dispatches the bridge event with the context", async () => {
    mount("editor");
    const btn = container.querySelector("button");
    expect(btn?.getAttribute("aria-label")).toBe("Ask the agent about Day 1 — Rest day");
    const seen: AskAgentContext[] = [];
    const onAsk = (e: Event) => seen.push((e as CustomEvent<AskAgentContext>).detail);
    window.addEventListener(ASK_AGENT_EVENT, onAsk);
    try {
      await act(async () => {
        btn!.click();
        await Promise.resolve();
      });
      expect(seen).toEqual([CONTEXT]);
      // Phase-3 intent: entity + field names only — the draft values (which
      // the drawer needs) never reach the log.
      expect(intentMock).toHaveBeenCalledTimes(1);
      expect(intentMock).toHaveBeenCalledWith("day", ["title", "notes"]);
      const serialized = JSON.stringify(intentMock.mock.calls);
      expect(serialized).not.toContain("day_id=d1");
    } finally {
      window.removeEventListener(ASK_AGENT_EVENT, onAsk);
    }
  });

  it("gated trees log nothing (no button, no intent)", () => {
    authState.isAuthenticated = false;
    mount("editor");
    expect(intentMock).not.toHaveBeenCalled();
  });
});
