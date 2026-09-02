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
 */
export {};

declare global {
  interface Window {
    __KISEKI_PDF_RENDER__?: boolean;
    __KISEKI_ACCESS_TOKEN__?: string;
  }
}
