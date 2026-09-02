/**
 * Global augmentations for the Kiseki SPA.
 *
 * `__KISEKI_PDF_RENDER__` is set by the backend's Playwright booklet renderer
 * (see backend/app/pdf.py, issue #58) before the SPA loads, so TripLayout can
 * skip its `isAuthenticated` UI gate when the backend has already enforced
 * JWT + crew role on the booklet endpoint.
 */
export {};

declare global {
  interface Window {
    __KISEKI_PDF_RENDER__?: boolean;
  }
}
