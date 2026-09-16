// @vitest-environment jsdom
/**
 * The home-map pin preview (#249, slice 5).
 *
 * A pin tap opens the trip card, not the trip: photography-led, the trip's
 * own stage badge, the anchor place, one explicit way in — the same card
 * language as the bands, condensed, never a second one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TripPinCard } from "./TripPinCard";

const TRIP = {
  dtId: "trip-1",
  title: "Ski Week",
  stage: "booked" as const,
  cover: "/media/trip-1/cover.jpg",
  anchorName: "Revelstoke",
};

describe("TripPinCard", () => {
  it("renders the cover, the stage, the anchor and one way in", () => {
    const html = renderToString(
      <MemoryRouter>
        <TripPinCard trip={TRIP} onClose={() => undefined} />
      </MemoryRouter>,
    );
    expect(html).toContain(TRIP.cover);
    expect(html).toContain("Booked");
    expect(html).toContain("Revelstoke");
    expect(html).toContain('href="/t/trip-1"');
    expect(html).toContain("Open trip");
    expect(html).toContain('aria-label="Close trip preview"');
  });

  it("falls back to the pin glyph without a cover", () => {
    const html = renderToString(
      <MemoryRouter>
        <TripPinCard trip={{ ...TRIP, cover: null, anchorName: null }} onClose={() => undefined} />
      </MemoryRouter>,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("Ski Week");
  });

  it("closes on the close button", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TripPinCard trip={TRIP} onClose={onClose} />
        </MemoryRouter>,
      );
    });
    const close = container.querySelector('button[aria-label="Close trip preview"]') as HTMLElement;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
});
