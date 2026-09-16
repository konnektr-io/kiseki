// @vitest-environment jsdom
/**
 * #301 — WHICH element a content link renders as is the contract, and SSR can
 * only show the difference in attributes. So this mounts the real component and
 * CLICKS it: an in-app target has to move the router's own location (a second
 * tab is exactly what must NOT happen), while an off-app target must not be
 * intercepted at all — it leaves the SPA.
 *
 * The glyph is part of the contract too: an external-link icon on an in-app
 * link promises a new tab that never happens.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentLink } from "./content-link";

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const loc = useLocation();
  return <span data-probe>{`${loc.pathname}${loc.search}${loc.hash}`}</span>;
}

function mount(url: string, glyph?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/t/t1"]}>
        <ContentLink url={url} glyph={glyph} className="pill">
          Open the day
        </ContentLink>
        <LocationProbe />
      </MemoryRouter>,
    );
  });
}

const anchor = () => container.querySelector("a") as HTMLAnchorElement;
const locationText = () => container.querySelector("[data-probe]")!.textContent;

function click() {
  act(() => {
    anchor().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("ContentLink (#301)", () => {
  it("navigates in-app for a Kiseki path — no target, no second tab", () => {
    mount("/t/t1/day/3");
    expect(anchor().getAttribute("href")).toBe("/t/t1/day/3");
    expect(anchor().getAttribute("target")).toBeNull();
    expect(anchor().getAttribute("rel")).toBeNull();
    // the click lands in the SPA: the router's own location moved.
    click();
    expect(locationText()).toBe("/t/t1/day/3");
  });

  it("keeps the query and the chapter hash of an in-app target", () => {
    mount("/t/t1/itinerary?s=1#s-2");
    expect(anchor().getAttribute("href")).toBe("/t/t1/itinerary?s=1#s-2");
    click();
    expect(locationText()).toBe("/t/t1/itinerary?s=1#s-2");
  });

  it("keeps an off-app target on the new-tab contract, and does not route it", () => {
    mount("https://www.strava.com/activities/9001");
    expect(anchor().getAttribute("href")).toBe("https://www.strava.com/activities/9001");
    expect(anchor().getAttribute("target")).toBe("_blank");
    expect(anchor().getAttribute("rel")).toBe("noreferrer");
    click();
    // the SPA did not navigate — the browser takes this one to a new tab.
    expect(locationText()).toBe("/t/t1");
  });

  it("shows the in-app arrow for an in-app target and the external glyph otherwise", () => {
    mount("/t/t1/day/3", "h-3 w-3");
    expect(anchor().querySelector("svg")!.getAttribute("class")).toContain("lucide-arrow-right");
    act(() => root.unmount());

    mount("https://www.strava.com/activities/9001", "h-3 w-3");
    expect(anchor().querySelector("svg")!.getAttribute("class")).toContain("lucide-external-link");
  });

  it("renders no glyph at all when the caller asks for none", () => {
    mount("/t/t1/day/3");
    expect(container.querySelector("svg")).toBeNull();
  });
});
