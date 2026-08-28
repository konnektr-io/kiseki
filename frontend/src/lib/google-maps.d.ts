/* Minimal ambient types for the Google Maps JS API (loaded at runtime via script).
   Swap for @types/google.maps when we need deeper typing. */
declare global {
  const google: any;
  interface Window {
    google?: any;
  }
}

export {};
