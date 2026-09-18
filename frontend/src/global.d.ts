/**
 * Global augmentations for the Kiseki SPA.
 *
 * `__KISEKI_PDF_RENDER__` is set by the backend's Playwright booklet renderer
 * (see backend/app/pdf.py, issue #58) before the SPA loads, so TripLayout can
 * skip its `isAuthenticated` UI gate when the backend has already enforced
 * JWT + crew role on the booklet endpoint.
 *
 * `__KISEKI_ACCESS_TOKEN__` is injected into the HTML shell by the backend's
 * SPA catch-all route when the request carries a Bearer token (i.e. the
 * Playwright renderer's loopback GET on /t/<key>/booklet). The SPA uses it as
 * the Bearer for its own /api/* fetches — no Auth0 login needed. Undefined
 * outside PDF-render mode.
 *
 * `__KISEKI_API_KEY__` is the ADMIN API KEY seam (issue #324): browser probes
 * set it with `add_init_script` (see backend/scripts/probe_trip_page.py) so a
 * Playwright session makes authorized API calls through `X-API-Key` without
 * minting an Auth0 M2M token. Set only by a probe — never by the app.
 *
 * `__KISEKI_ACT_AS_SUB__` is the key's mandatory impersonation identity: the
 * probe sets it beside the key, and `authHeaders()` sends it as
 * `X-Act-As-Sub` so API-key calls always act as a user.
 */
export {};

declare global {
  interface Window {
    __KISEKI_PDF_RENDER__?: boolean;
    __KISEKI_ACCESS_TOKEN__?: string;
    __KISEKI_API_KEY__?: string;
    __KISEKI_ACT_AS_SUB__?: string;
  }
}
