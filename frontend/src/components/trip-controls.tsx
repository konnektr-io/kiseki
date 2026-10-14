import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { EllipsisVertical, FileDown, LogIn, Pencil, Settings, UserPlus } from "lucide-react";
import { useTripState } from "./theme";
import { useEditMode } from "./edit-mode";
import { followPublicTrip } from "../lib/api";
import { isAuthConfigured } from "../lib/auth";
import { roleAtLeast } from "../lib/editing";

/**
 * Trip header actions — ONE overflow menu in the top-right corner so the
 * header stays a single row (issue #46 follow-up). Since #248 it holds only
 * what is per-visit or per-app:
 *
 *   signed in      → Booklet PDF
 *   not signed in  → Sign in                  (#423)
 *   may follow     → Follow this trip         (#423)
 *   editor+        → Edit mode toggle (reading/editor split — the surfaces
 *                    read clean until an editor opts into the pencils,
 *                    ghost buttons and block chrome for this trip)
 *   editor+        → Trip settings  →  /t/<id>/settings
 *
 * The account rows are here because the trip page had no way to sign in at
 * all (#423): the Auth0 chip lives in the landing header, so a visitor who
 * arrived on a shared `/t/<id>` link and then decided they wanted an account
 * had to navigate home first — and, having signed in, the only follow
 * affordance in the app was the discovery chip on the landing page, nowhere
 * near the trip they were reading. Both now live where the decision is made.
 *
 *   * Follow uses `POST /api/trips/{id}/follow` (#197) — the PUBLIC-trip path,
 *     with no invite. It is offered when the viewer has no role at all on a
 *     public trip: a follower/crew member is already ON the trip (`myRole`),
 *     and a private trip is invite-only on that path (the server answers 403),
 *     so neither shows the row. The returned document carries
 *     `myRole: "follower"`, so applying it removes the row — the feedback is
 *     the move, exactly as on the landing chip.
 *   * The row is GREYED while signed out rather than hidden: following is what
 *     the trip affords, and the Sign in row right above it is the way there.
 *   * The booklet download is a member feature now: an anonymous visitor is not
 *     who it is for, and offering a download to a cold reader was the menu's
 *     only row. This is presentation only — `/booklet.pdf` keeps its
 *     visibility gate (public trips still serve anonymously, #64) and nothing
 *     in the backend moved.
 *   * Both account rows need auth: on a deployment without Auth0
 *     (`isAuthConfigured()`, the secret-link mode) there is no one to sign in,
 *     so the rows are absent and — with the booklet gated too — the menu can be
 *     empty, which is why the whole trigger is dropped in that case rather than
 *     opening onto nothing.
 *
 * Everything that configures the TRIP (stage, theme, sharing, the crew invite
 * links, the TriCount connection, delete) lives on the settings page — the menu
 * had grown into a scrolling panel of eight unrelated rows, most of them
 * settings. The settings row is a LINK, not an action: the page is the single
 * home for trip-level settings, and hiding the row for a viewer/follower is
 * presentation only — the page and the server both gate on the same editor+
 * rule. (The settings page itself stays ungated: it IS the edit home, reached
 * explicitly — edit mode only quiets the surfaces that are read first.)
 */
export function TripActionsMenu({
  pdfBusy = false,
  onDownloadPdf,
}: {
  pdfBusy?: boolean;
  onDownloadPdf: () => void;
}) {
  const { trip, apply } = useTripState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { editMode, setEditMode } = useEditMode();

  const { isAuthenticated, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [followBusy, setFollowBusy] = useState(false);
  // A refused follow (a trip that stopped being public, a network hiccup) —
  // one line, inside the menu, where the button is. Never swallowed.
  const [followError, setFollowError] = useState<string | null>(null);

  const authAvailable = isAuthConfigured();
  // Following is a signed-in reader's move on a public trip they are not on.
  const canFollow = authAvailable && trip.visibility === "public" && !trip.myRole;
  // Nothing actionable left? Then the kebab stays out of the header (see the
  // class comment: an empty menu is worse than no menu — it is exactly the
  // deployment without Auth0, where the booklet gate leaves nothing behind).
  const hasRows = isAuthenticated || canEdit || canFollow;

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Sign in and come back to THIS page (`AuthProvider.onRedirectCallback`
  // navigates to `appState.returnTo`) — the whole point of the row is not
  // having to go home first.
  const signIn = () =>
    loginWithRedirect({ appState: { returnTo: window.location.pathname } });

  const onFollow = async () => {
    if (followBusy) return;
    setFollowBusy(true);
    setFollowError(null);
    try {
      const token = await getAccessTokenSilently();
      // The canonical document comes back with `myRole: follower`, so the row
      // goes away by itself. The menu deliberately stays OPEN for that: the
      // reader watches the state change instead of being thrown back to a
      // closed kebab.
      apply(await followPublicTrip(trip.id, token));
    } catch (e) {
      setFollowError(e instanceof Error ? e.message : "Could not follow this trip.");
    } finally {
      setFollowBusy(false);
    }
  };

  if (!hasRows) return null;

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Trip actions"
        title="Trip actions"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground focus-visible:focus-ring"
      >
        <EllipsisVertical className="h-4 w-4" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Trip actions"
          className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-border bg-card p-1.5 shadow-lg"
        >
          {/* Sign in — signed out, on a deployment that can authenticate.
              Returns to this trip (`appState.returnTo`). */}
          {authAvailable && !isAuthenticated && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                void signIn();
              }}
            >
              <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>Sign in</span>
            </button>
          )}

          {/* Follow this trip — a public trip the viewer is not on. Greyed
              while signed out (there is nothing to follow WITH yet). */}
          {canFollow && (
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={!isAuthenticated || followBusy}
              title={isAuthenticated ? undefined : "Sign in to follow this trip"}
              onClick={() => void onFollow()}
            >
              <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span aria-live="polite">
                {followBusy ? "Following…" : "Follow this trip"}
              </span>
              {/* The row is unclickable while signed out, so the reason is
                  stated in the accessible name rather than in a hover
                  tooltip that a disabled control never shows. */}
              {!isAuthenticated && <span className="sr-only"> (sign in first)</span>}
            </button>
          )}

          {followError && (
            <p role="alert" className="px-2.5 py-1.5 text-xs text-destructive">
              {followError}
            </p>
          )}

          {/* Booklet PDF — signed-in readers (#423). The endpoint itself is
              unchanged: a public trip still serves an anonymous download to
              anyone who asks directly. */}
          {isAuthenticated && (
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={pdfBusy}
              onClick={() => {
                onDownloadPdf();
                setOpen(false);
              }}
            >
              <FileDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span aria-live="polite">{pdfBusy ? "Preparing booklet…" : "Download booklet PDF"}</span>
            </button>
          )}

          {/* Edit mode — editor+ (reading/editor split: the surfaces read
              clean until an editor opts into the chrome for this trip) */}
          {canEdit && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={editMode}
              className={item}
              onClick={() => setEditMode(!editMode)}
            >
              <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>Edit mode</span>
              <span className="ml-auto text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {editMode ? "On" : "Off"}
              </span>
            </button>
          )}

          {/* Trip settings — editor+ (the page's own gate is the same rule) */}
          {canEdit && (
            <Link
              to={`/t/${trip.id}/settings`}
              role="menuitem"
              className={item}
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>Trip settings</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
