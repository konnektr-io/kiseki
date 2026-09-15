import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MarketingLanding } from "./pages/LandingMarketing";
import { MARKETING_HERO } from "./lib/marketing";

/**
 * The string `scripts/prerender.mjs` asserts on to prove the render produced the
 * page (a silent empty render is otherwise indistinguishable from a good build).
 *
 * Exported from here rather than hardcoded in the script so it cannot drift: it was
 * a literal in that file until a headline rewrite made the build fail its own guard
 * — which was the guard working, but a duplicated copy constant is a trap, not a test.
 */
export const PRERENDER_MARKER = MARKETING_HERO.headline;

/**
 * The prerender entry (E4 of #249) — the signed-out front door, rendered to HTML
 * at BUILD time so `/` answers with real content before any JavaScript runs.
 *
 * Why only the landing: it is the one route whose body is static. Everything else
 * is per-viewer (a trip, a profile, a feed), and prerendering those would either
 * publish something private or ship a shell that flashes the wrong page.
 *
 * And since the page shows an INVENTED example rather than the owner's trips (see
 * `pages/LandingMarketing.tsx`), the whole body is static — there is no data to
 * inject and no empty state to degrade into. What this artifact contains is copy
 * and five committed, rights-free photographs, and nothing else.
 *
 * Still no auth: `AuthButton` needs the Auth0 provider, which is browser-only, so
 * the prerendered shell renders no account chip (`headerActions={null}`). A visitor
 * without JS sees the copy and the example, not a Sign in that could not work.
 *
 * Built by `vite build --ssr src/prerender.tsx` and injected by
 * `scripts/prerender.mjs` into `dist/landing.html`; the backend serves that shell
 * for `/` only.
 */
export function renderLandingHtml(): string {
  return renderToString(
    <MemoryRouter>
      <MarketingLanding headerActions={null} />
    </MemoryRouter>,
  );
}
