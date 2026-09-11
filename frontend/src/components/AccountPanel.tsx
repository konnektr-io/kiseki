import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { Download, Trash2, TriangleAlert } from "lucide-react";
import {
  AccountDeleteBlockedError,
  TripAccessError,
  deleteMyAccount,
  downloadMyExport,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { Button, Card } from "./ui";

/* ------------------------------------------------------------------ errors
 * Every failure maps to a distinct, honest state — never a raw stack,
 * never a silent no-op. The server's message rides along when there is
 * one; the fallback is plain language. */

type ExportFailure =
  | { kind: "expired" }
  | { kind: "not-ready" }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "generic"; message: string };

function toExportFailure(e: unknown): ExportFailure {
  if (isSessionExpiredError(e)) return { kind: "expired" };
  if (e instanceof TripAccessError) {
    if (e.status === 404) return { kind: "not-ready" };
    if (e.status === 503) return { kind: "unavailable" };
    if (e.status === 401 || e.status === 403) return { kind: "forbidden" };
  }
  return {
    kind: "generic",
    message: e instanceof Error && e.message ? e.message : "Couldn't export your data.",
  };
}

type DeleteFailure =
  | { kind: "expired" }
  | { kind: "gone" }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "generic"; message: string };

function toDeleteFailure(e: unknown): DeleteFailure {
  if (isSessionExpiredError(e)) return { kind: "expired" };
  if (e instanceof TripAccessError) {
    if (e.status === 404) return { kind: "gone" };
    if (e.status === 503) return { kind: "unavailable" };
    if (e.status === 401 || e.status === 403) return { kind: "forbidden" };
  }
  return {
    kind: "generic",
    message: e instanceof Error && e.message ? e.message : "Couldn't delete your account.",
  };
}

/** The typed name matches the profile name when it is non-empty and equal
 *  after trimming, compared case-insensitively. */
export function deleteConfirmMatches(displayName: string, input: string): boolean {
  const want = displayName.trim().toLowerCase();
  const got = input.trim().toLowerCase();
  return want.length > 0 && got.length > 0 && got === want;
}

/**
 * The account area on `/me` (#196 phase E): export your data + delete your
 * account. Self-only — `MePage` renders it below the trips section, never
 * on a peer's profile.
 *
 * Deliberately separate from the profile read path (ProfileView): its own
 * fetch state, so a failure here can never blank the profile — and after a
 * successful delete it renders a terminal state instead of re-reading a
 * profile that no longer exists. Never renders an email address: the only
 * personal value it takes is the already-visible `displayName`.
 */
export function AccountPanel({ displayName }: { displayName: string }) {
  const { getAccessTokenSilently, loginWithRedirect, logout } = useAuth0();

  const [exportBusy, setExportBusy] = useState(false);
  const [exportFailure, setExportFailure] = useState<ExportFailure | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [blocked, setBlocked] = useState<{
    message: string;
    ownedTrips: { dtId: string; title: string; slug: string }[];
  } | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<DeleteFailure | null>(null);
  const [deleted, setDeleted] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);

  // Focus moves into the panel when it opens (the heading is the first
  // thing a screen reader announces — the irreversible explanation before
  // the input). Closing returns focus to the trigger; see closePanel.
  useEffect(() => {
    if (panelOpen) panelHeadingRef.current?.focus();
  }, [panelOpen]);

  const closePanel = () => {
    if (deleteBusy) return;
    setPanelOpen(false);
    setConfirmInput("");
    setBlocked(null);
    setDeleteFailure(null);
    triggerRef.current?.focus();
  };

  const sessionExpired = () => {
    // The page's existing behaviour: back to Auth0 for one click.
    void loginWithRedirect({ appState: { returnTo: window.location.pathname } });
  };

  const runExport = async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportFailure(null);
    try {
      const at = await getAccessTokenSilently();
      await downloadMyExport(at);
      // Success IS the file arriving — nothing further to claim.
    } catch (e) {
      const failure = toExportFailure(e);
      setExportFailure(failure);
      if (failure.kind === "expired") sessionExpired();
    } finally {
      setExportBusy(false);
    }
  };

  const runDelete = async () => {
    if (deleteBusy || !deleteConfirmMatches(displayName, confirmInput)) return;
    setDeleteBusy(true);
    setBlocked(null);
    setDeleteFailure(null);
    try {
      const at = await getAccessTokenSilently();
      await deleteMyAccount(at);
      // Terminal state — deliberately no profile re-read: the twin is gone,
      // and a re-fetch would render a broken "not found" under a success.
      setDeleted(true);
    } catch (e) {
      if (e instanceof AccountDeleteBlockedError) {
        // 409: NOTHING was deleted. The panel stays usable so the user can
        // fix the blocking trips and retry.
        setBlocked({ message: e.message, ownedTrips: e.ownedTrips });
      } else {
        const failure = toDeleteFailure(e);
        setDeleteFailure(failure);
        if (failure.kind === "expired") sessionExpired();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  if (deleted) {
    return (
      <section aria-label="Account" className="mt-8">
        <Card className="p-4 text-center sm:p-6" role="status">
          <h2 className="font-heading text-xl font-semibold tracking-wide">
            Your account is deleted.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Everything Kiseki held about you is gone. Your login itself still
            exists — signing in again would create a fresh, empty profile.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Button
              onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
              className="min-h-[44px]"
            >
              Sign out
            </Button>
            <Link
              to="/"
              className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary underline underline-offset-2 focus-visible:focus-ring"
            >
              Home
            </Link>
          </div>
        </Card>
      </section>
    );
  }

  const confirmReady = deleteConfirmMatches(displayName, confirmInput);

  return (
    <section aria-label="Account" className="mt-8">
      <h2 className="font-heading text-xl font-semibold tracking-wide">Account</h2>

      {/* ---------------- export: plain, non-destructive ---------------- */}
      <Card className="mt-3 p-4 sm:p-6">
        <h3 className="font-heading text-lg font-semibold tracking-wide">
          Export your data
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          One file with everything Kiseki holds about you — your profile, your
          trips, and your crew rows on other people's trips.
        </p>
        <Button
          variant="outline"
          onClick={() => void runExport()}
          disabled={exportBusy}
          className="mt-3 min-h-[44px]"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exportBusy ? "Preparing…" : "Download your data"}
        </Button>
        {exportFailure && (
          <p role="alert" className="mt-2 text-sm font-medium text-destructive">
            {exportFailure.kind === "expired" && (
              <>
                Your session expired.{" "}
                <button
                  type="button"
                  onClick={() => sessionExpired()}
                  className="min-h-[44px] underline underline-offset-2 focus-visible:focus-ring"
                >
                  Sign in again
                </button>
              </>
            )}
            {exportFailure.kind === "not-ready" &&
              "Your profile isn't ready yet — try again in a moment."}
            {exportFailure.kind === "unavailable" &&
              "Kiseki's directory is taking a break — try again later."}
            {exportFailure.kind === "forbidden" &&
              "Your sign-in can't export accounts. If you just signed in, try again."}
            {exportFailure.kind === "generic" && exportFailure.message}
          </p>
        )}
      </Card>

      {/* ---------------- delete: visually distinct, destructive ---------------- */}
      <Card className="mt-4 border-destructive/40 bg-destructive/5 p-4 sm:p-6">
        <h3 className="font-heading text-lg font-semibold tracking-wide text-destructive">
          Delete your account
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently erase your Kiseki profile. This cannot be undone.
        </p>
        {!panelOpen ? (
          <Button
            ref={triggerRef}
            variant="outline"
            onClick={() => {
              setPanelOpen(true);
              setConfirmInput("");
              setBlocked(null);
              setDeleteFailure(null);
            }}
            aria-expanded={false}
            aria-controls="delete-account-panel"
            className="mt-3 min-h-[44px] border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete your account…
          </Button>
        ) : (
          <div
            id="delete-account-panel"
            role="region"
            aria-label="Confirm account deletion"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closePanel();
              }
            }}
            className="mt-3 rounded-xl border border-destructive/40 bg-card p-4"
          >
            <h4
              ref={panelHeadingRef}
              tabIndex={-1}
              className="font-heading text-base font-semibold tracking-wide focus-visible:focus-ring"
            >
              This is irreversible. Read this first.
            </h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>
                Deleting erases your Kiseki profile — there is no way back.
              </li>
              <li>
                On other people's trips, your crew entries revert to an
                unclaimed placeholder with the same name. Those trips keep
                rendering for everyone else; your contact details do not survive.
              </li>
              <li>
                Trips you own block deletion — delete them first, or hand one
                over by granting the <span className="font-medium">owner</span>{" "}
                role to another crew member, then come back.
              </li>
              <li>Follows are removed in both directions.</li>
              <li>
                Your login itself is not deleted. Signing in again would create
                a fresh, empty profile.
              </li>
            </ul>

            <label
              htmlFor="delete-confirm-name"
              className="mt-4 block text-sm font-medium"
            >
              To confirm, type your display name{" "}
              <span className="font-semibold">{displayName}</span> exactly.
            </label>
            <input
              id="delete-confirm-name"
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={confirmInput}
              disabled={deleteBusy}
              onChange={(e) => setConfirmInput(e.target.value)}
              onKeyDown={(e) => {
                // Nothing auto-submits: Enter in the input must not delete.
                if (e.key === "Enter") e.preventDefault();
              }}
              aria-describedby="delete-confirm-hint"
              className="mt-1.5 min-h-[44px] w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus-visible:focus-ring disabled:opacity-50"
            />
            <p id="delete-confirm-hint" className="mt-1 text-xs text-muted-foreground">
              Surrounding spaces don't matter; letter case doesn't. An empty or
              wrong name keeps the button disabled.
            </p>

            {blocked && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-border bg-muted/40 p-3"
              >
                <p className="flex items-start gap-2 text-sm font-medium">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    Nothing was deleted — {blocked.message}
                  </span>
                </p>
                {blocked.ownedTrips.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {blocked.ownedTrips.map((t) => (
                      <li key={t.dtId}>
                        <Link
                          to={`/t/${t.dtId}`}
                          className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary underline underline-offset-2 focus-visible:focus-ring"
                        >
                          {t.title || t.dtId}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Delete the trip, or hand it over by granting the owner role to
                  another crew member, then come back and try again.
                </p>
              </div>
            )}

            {deleteFailure && (
              <p role="alert" className="mt-2 text-sm font-medium text-destructive">
                {deleteFailure.kind === "expired" && (
                  <>
                    Your session expired.{" "}
                    <button
                      type="button"
                      onClick={() => sessionExpired()}
                      className="min-h-[44px] underline underline-offset-2 focus-visible:focus-ring"
                    >
                      Sign in again
                    </button>
                  </>
                )}
                {deleteFailure.kind === "gone" &&
                  "Your account is already gone — there's nothing left to delete."}
                {deleteFailure.kind === "unavailable" &&
                  "Kiseki's directory is taking a break — nothing was deleted. Try again later."}
                {deleteFailure.kind === "forbidden" &&
                  "Your sign-in can't delete accounts. If you just signed in, try again."}
                {deleteFailure.kind === "generic" && deleteFailure.message}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="default"
                onClick={() => void runDelete()}
                disabled={!confirmReady || deleteBusy}
                aria-disabled={!confirmReady || deleteBusy}
                className="min-h-[44px] bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {deleteBusy ? "Deleting…" : "Yes, delete my account"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={closePanel}
                disabled={deleteBusy}
                className="min-h-[44px]"
              >
                Keep my account
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
