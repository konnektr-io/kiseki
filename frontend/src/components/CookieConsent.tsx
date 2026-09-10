import { useEffect, useState } from "react";
import { CookieIcon } from "lucide-react";
import { Button } from "./ui";
import { CONSENT_COOKIE, storeConsent } from "../lib/analytics-consent";
import { initAnalytics } from "../lib/posthog";

/** Any stored answer (granted OR denied) means the visitor decided before. */
function hasStoredChoice(): boolean {
  try {
    return document.cookie.includes(`${CONSENT_COOKIE}=`);
  } catch {
    return false; // storage blocked → treat as undecided, show the banner
  }
}

/**
 * Analytics consent banner (issue #21) — ported from graph-explorer's
 * `cookie-consent.tsx` (Niko: "copy the cookie banner from ktrlplane /
 * graph-explorer"), restyled to Kiseki tokens and `no-print` so the PDF
 * booklet never captures it.
 *
 * Copy is deliberately NOT "we use cookies": Kiseki's analytics is cookieless
 * (no cookie, no local/session storage), so the banner describes exactly what
 * ships — anonymous, per-trip usage events — instead of a generic cookie line
 * that would be false. The only cookie involved is the strictly-necessary
 * choice itself (`kiseki_consent`).
 *
 * Until a choice is made, PostHog is not initialized at all: a closed tab
 * sends nothing (the probe asserts zero events pre-consent).
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Decide on mount. The PDF renderer and the e2e probe harness are automated
  // contexts — no banner, no consent prompt, no analytics: the booklet route
  // must stay pixel-stable and the probe asserts the un-consented zero-event
  // path. Real visitors get the banner.
  useEffect(() => {
    const automated =
      typeof window !== "undefined" &&
      (window.__KISEKI_PDF_RENDER__ === true ||
        new URLSearchParams(window.location.search).has("kiseki_e2e"));
    if (automated || hasStoredChoice()) {
      // Automated context, or the visitor already answered on a previous visit:
      // gone entirely — a closed-but-mounted banner would still intercept taps.
      setHidden(true);
      return;
    }
    setOpen(true);
  }, []);

  const finish = (ms = 600) => {
    setOpen(false);
    window.setTimeout(() => setHidden(true), ms);
  };

  const accept = () => {
    storeConsent("granted");
    initAnalytics(); // the FIRST PostHog init of the session happens here
    finish();
  };

  const decline = () => {
    storeConsent("denied");
    finish();
  };

  if (hidden) return null;

  return (
    <div
      role="dialog"
      aria-label="Anonymous analytics"
      className={`no-print fixed inset-x-0 bottom-0 z-40 w-full p-3 duration-700 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:max-w-md sm:p-0 ${
        open ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
      } transition-[opacity,transform]`}
    >
      <div className="rounded-lg border border-border bg-card shadow-lg">
        <div className="flex h-12 items-center justify-between border-b border-border p-3 sm:h-14 sm:p-4">
          <h2 className="text-base font-medium sm:text-lg">Anonymous analytics</h2>
          <CookieIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="p-3 sm:p-4">
          <p className="text-xs text-muted-foreground sm:text-sm">
            Kiseki uses anonymous, cookie-free analytics to learn how the app is
            used — which pages people open, whether trip pages work on mobile,
            how often booklets get downloaded. No cookies, no ads, no trackers;
            trip content never leaves your browser. It is one small first-party
            cookie: your choice on this banner.
          </p>
        </div>
        <div className="grid grid-cols-2 items-center gap-2 border-t border-border p-3 sm:px-4 sm:py-4">
          <Button onClick={accept} size="sm" className="w-full">
            Allow analytics
          </Button>
          <Button onClick={decline} size="sm" variant="outline" className="w-full">
            No thanks
          </Button>
        </div>
      </div>
    </div>
  );
}
