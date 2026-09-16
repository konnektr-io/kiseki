import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppHeader } from "./AppHeader";

/**
 * `hideBrandOnPhone` is the trip's escape hatch (#239 follow-up): on a
 * 360–430px phone the brand squeezed the trip name into an ellipsis, so it
 * leaves the bar there. Two things must hold — it never fires on a route that
 * doesn't ask for it, and it can never fire when the brand IS the bar's `<h1>`
 * (the landing), or a route would lose its only page heading.
 */
const BRAND_YIELD = "max-[480px]:hidden";

function render(props: Parameters<typeof AppHeader>[0]) {
  return renderToString(
    <MemoryRouter>
      <AppHeader {...props} />
    </MemoryRouter>,
  );
}

describe("AppHeader brand on phones", () => {
  it("keeps the brand in the bar by default", () => {
    const out = render({ title: "Feed" });
    expect(out).toContain("Kiseki");
    expect(out).not.toContain(BRAND_YIELD);
  });

  it("lets the brand yield on phones when the caller asks (the trip)", () => {
    const out = render({ title: "Canada Heliski + Resort Trip", hideBrandOnPhone: true });
    // Still rendered — it is the same bar, the CSS hides it on phones only.
    expect(out).toContain("Kiseki");
    expect(out).toContain(BRAND_YIELD);
  });

  it("never yields when the brand is the bar's own heading (the landing)", () => {
    const out = render({ hideBrandOnPhone: true });
    expect(out).toContain("<h1");
    expect(out).not.toContain(BRAND_YIELD);
  });
});

describe("AppHeader stacking", () => {
  it("paints above the sheet, so an open menu is never covered", () => {
    const html = render({ actions: <span /> });
    // Stacking cannot be computed in jsdom, so the contract is pinned here and
    // MEASURED in the browser probe: the header is chrome (§2.3) and the sheet
    // is content, and `Sheet.tsx` is z-20. At z-20 both sat in the root
    // stacking context, the sheet won on DOM order, and a phone's account menu
    // was covered by the sheet's top edge.
    expect(html).toContain("z-30");
    expect(html).not.toContain("sticky top-0 z-20");
  });
});
