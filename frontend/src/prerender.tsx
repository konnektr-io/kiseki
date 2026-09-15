import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MarketingLanding } from "./pages/LandingMarketing";

/**
 * The prerender entry (E4 of #249) — the signed-out front door, rendered to HTML
 * at BUILD time so `/` answers with real content before any JavaScript runs.
 *
 * Why only the landing: it is the one route whose body is static. Everything else
 * is per-viewer (a trip, a profile, a feed), and prerendering those would either
 * publish something private or ship a shell that flashes the wrong page.
 *
 * Scope, deliberately:
 * - **No data.** The page renders its no-showcase state, so the prerendered HTML
 *   contains no trip titles, no `/t/` links, no media URLs and no crew — the
 *   crawlable artifact is copy, and the real graph arrives after hydration. That
 *   also means this file cannot leak a private trip into a public document.
 * - **No auth.** `AuthButton` needs the Auth0 provider, which is browser-only, so
 *   the prerendered shell renders no account chip; `headerActions={null}` is the
 *   seam. A visitor without JS sees the copy and the hero CTA, not a Sign in that
 *   could not work.
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
