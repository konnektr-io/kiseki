import { Component, StrictMode, useEffect, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AnalyticsPageviews } from "./components/AnalyticsPageviews";
import { CookieConsent } from "./components/CookieConsent";
import { AuthProvider } from "./components/AuthProvider";
import "./index.css";
import { consentGranted, initAnalytics, isPostHogConfigured, posthog } from "./lib/posthog";

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
    if (isPostHogConfigured && posthog.__loaded) posthog.captureException(error);
  }

  render() {
    if (this.state.hasError) {
      return <p>Something went wrong. Please refresh the page and try again.</p>;
    }

    return this.props.children;
  }
}

const container = document.getElementById("root")!;
// "/" is prerendered (#249, E4): `landing.html` already carries the marketing copy
// inside this element, so it paints — and is crawlable — before this module runs.
// React must own a container it did not render, so the prerendered children go
// first and the app takes over; on every other route this is a no-op.
if (container.firstChild) container.replaceChildren();

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        {/* Consent-gated analytics (issue #21): restore a previous "granted"
            choice immediately (returning visitor — no banner re-show), otherwise
            CookieConsent asks and initializes on accept. Until then the SDK is
            never created and AnalyticsPageviews is a no-op. */}
        <ConsentGate />
        {/* Inside the Router so it can read the location; outside AuthProvider
            so a signed-out visitor's pageview still counts. */}
        <AnalyticsPageviews />
        <AuthProvider>
          <App />
        </AuthProvider>
        <CookieConsent />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);

/** Restore a stored "granted" choice on load (returning visitor). Kept as a
 *  component so `main.tsx` stays declarative — the init itself is a side
 *  effect that must not run during render. */
function ConsentGate() {
  useEffect(() => {
    if (isPostHogConfigured && consentGranted()) initAnalytics();
  }, []);
  return null;
}
