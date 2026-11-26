// @vitest-environment jsdom
/**
 * The booklet progress pill (#booklet-progress).
 *
 * Why it exists: rendering the booklet takes ~30 s on the server and the
 * header menu that starts it CLOSES on click, so the only "is it doing
 * something" signal lived inside a menu the reader had just dismissed
 * (Niko, 2026-11-26). The pill is the signal outside that menu.
 *
 * The contract pinned here:
 *   - idle renders NOTHING (no reserved box on a normal visit);
 *   - busy is a `role="status"` live region with a ticking elapsed counter —
 *     a counter is what separates "working" from "hung" on a 30 s wait;
 *   - the failure state keeps the reason and stays polite (it is a message,
 *     not an alert), because the menu row is the retry.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookletProgress } from "./booklet-progress";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(state: "idle" | "busy" | "error", detail?: string): void {
  act(() => {
    root.render(<BookletProgress state={state} detail={detail} />);
  });
}

describe("booklet progress pill", () => {
  it("renders nothing at rest", () => {
    render("idle");
    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("announces the render and counts the seconds", () => {
    vi.useFakeTimers();
    render("busy");
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Preparing the booklet");
    expect(status!.textContent).toContain("0s");

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(status!.textContent).toContain("12s");
    // Polite, not an alert: nothing is wrong.
    expect(status!.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the reason when the render failed", () => {
    render("error", "Server said 500");
    const status = container.querySelector('[role="status"]');
    expect(status!.textContent).toContain("could not be prepared");
    expect(status!.textContent).toContain("Server said 500");
  });
});
