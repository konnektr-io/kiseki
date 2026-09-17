import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { MapPin, UserCheck, UserPlus } from "lucide-react";
import {
  TripAccessError,
  deleteMyAvatar,
  ensureMe,
  fetchUserFollowers,
  fetchUserFollowing,
  fetchUserProfile,
  followUser,
  setPublicName,
  unfollowUser,
  updateMyProfile,
  uploadMyAvatar,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { cropAvatar, type CropCanvas } from "../lib/avatar-crop";
import { formatDate } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import type { PeopleList, ProfilePerson, ProfileTrip, UserProfile } from "../lib/types";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { Badge, Button, Card, StageBadge } from "../components/ui";
import { AccountPanel } from "../components/AccountPanel";

/** "Niko Raes" → "NR"; single-word names keep their first two letters. */
function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type LoadFailure =
  | { kind: "expired" }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "load"; message: string };

function toLoadFailure(e: unknown): LoadFailure {
  if (isSessionExpiredError(e)) return { kind: "expired" };
  if (e instanceof TripAccessError) {
    if (e.status === 404) return { kind: "not-found" };
    if (e.status === 503) return { kind: "unavailable" };
    if (e.status === 401 || e.status === 403) return { kind: "forbidden" };
  }
  return { kind: "load", message: e instanceof Error ? e.message : "Couldn't load this profile." };
}

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="animate-pulse text-muted-foreground" role="status" aria-live="polite">
        Loading…
      </p>
    </div>
  );
}

function SignedOut({ title, body }: { title: string; body: string }) {
  const { loginWithRedirect } = useAuth0();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-heading text-2xl font-semibold tracking-wide">{title}</h1>
      <p className="max-w-sm text-muted-foreground">{body}</p>
      <Button
        onClick={() =>
          loginWithRedirect({ appState: { returnTo: window.location.pathname } })
        }
      >
        Sign in
      </Button>
    </div>
  );
}

function LoadErrorPanel({
  failure,
  selfHint,
  onRetry,
}: {
  failure: LoadFailure;
  selfHint: boolean;
  onRetry: () => void;
}) {
  const { loginWithRedirect } = useAuth0();
  if (failure.kind === "expired") {
    return (
      <div
        role="alert"
        className="mx-auto mt-16 max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
      >
        <p className="text-sm font-medium text-destructive">Your session expired.</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Sign in again to see this profile — this usually takes one click.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            loginWithRedirect({ appState: { returnTo: window.location.pathname } })
          }
          className="mt-3"
        >
          Sign in again
        </Button>
      </div>
    );
  }
  const copy = {
    "not-found": {
      title: "No such user.",
      body: selfHint
        ? "We couldn't find your profile yet. Sign-ins without a verified email can't get one — otherwise try again in a moment."
        : "We couldn't find that profile — the account may never have signed in to Kiseki.",
    },
    unavailable: {
      title: "Kiseki's directory is taking a break.",
      body: "The people graph isn't reachable right now — try again later.",
    },
    forbidden: {
      title: "You're not allowed to see this.",
      body: "Your account can't read this profile. If you just signed in, try again.",
    },
    load: {
      title: "Couldn't load this profile.",
      body: failure.kind === "load" ? failure.message : "Something went wrong.",
    },
  }[failure.kind];
  return (
    <div
      role="alert"
      className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-card p-6 text-center"
    >
      <h1 className="font-heading text-xl font-semibold">{copy.title}</h1>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{copy.body}</p>
      <div className="mt-4 flex items-center justify-center gap-3">
        {failure.kind !== "not-found" && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Link
          to="/"
          className="text-sm font-medium text-primary underline underline-offset-2 focus-visible:focus-ring"
        >
          Home
        </Link>
      </div>
    </div>
  );
}

/** One person row in a followers/following drill-in — name + avatar only,
 *  linking to their own profile. The viewer's own row is marked. */
function PersonRow({ person }: { person: ProfilePerson }) {
  return (
    <Link
      to={`/u/${encodeURIComponent(person.sub)}`}
      className="flex min-h-[44px] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:focus-ring"
    >
      {person.avatar ? (
        <img
          src={person.avatar}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-9 w-9 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary"
        >
          {initials(person.name)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{person.name}</span>
      {person.isSelf && <Badge variant="outline">You</Badge>}
    </Link>
  );
}

/** One trip in the profile's trip list, rendered verbatim from the server's
 *  listing rule. The badge is honest about WHY the trip is visible: the
 *  viewer's crew role (same pill as the landing-page trip cards) when they
 *  have one, "Discoverable" when the listing flag is the only reason. */
function TripRow({ trip }: { trip: ProfileTrip }) {
  const dates =
    trip.startDate && trip.endDate
      ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}`
      : "Dates TBD";
  return (
    <Link
      to={`/t/${trip.dtId}`}
      className="flex items-center gap-4 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40 focus-visible:focus-ring"
    >
      <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {trip.cover ? (
          <img
            src={trip.cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <MapPin className="h-6 w-6 text-muted-foreground/50" strokeWidth={1.5} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold">{trip.title}</span>
          <StageBadge stage={trip.stage} />
        </span>
        {trip.subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {trip.subtitle}
          </span>
        ) : null}
        <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
          {dates}
        </span>
      </span>
      {trip.myRole ? (
        <span className="shrink-0 rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          {trip.myRole}
        </span>
      ) : (
        <span
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          title="Listed because the trip is discoverable — you're not crew on it"
        >
          Discoverable
        </span>
      )}
    </Link>
  );
}

type ListKind = "followers" | "following";

/**
 * Self-only profile editor (#317): rename + photo, rendered on `/me` (and
 * your own `/u/:sub`) below the header card — never on a peer's profile.
 *
 * Name: inline input saved through `PUT /api/me {displayName}` (Kiseki-only,
 * never pushed to Auth0). Photo: file picker → square preview with a zoom
 * slider (center-crop + zoom, v1 — no panning) → client-side canvas crop
 * (`lib/avatar-crop`, 512px JPEG) → `POST /api/me/avatar`. Remove falls
 * back to the IdP photo when there is one, else the monogram. Every save
 * reports back through `onSaved` so the header updates without a refetch.
 */
function SelfProfileEditor({
  name,
  avatar,
  getAccessTokenSilently,
  loginWithRedirect,
  onSaved,
}: {
  name: string;
  avatar?: string;
  getAccessTokenSilently: () => Promise<string>;
  loginWithRedirect: (opts: { appState: { returnTo: string } }) => void;
  onSaved: (next: { name: string; avatar?: string }) => void;
}) {
  const [draft, setDraft] = useState(name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLImageElement>(null);

  // Keep the draft honest when the profile reloads underneath (e.g. after
  // a retry) — but never while the user is typing.
  useEffect(() => {
    setDraft((d) => (d === name || document.activeElement?.tagName === "INPUT" ? d : name));
  }, [name]);

  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  const expired = () => {
    loginWithRedirect({ appState: { returnTo: window.location.pathname } });
  };

  const saveName = async () => {
    const next = draft.trim();
    if (nameBusy || !next || next === name) return;
    if (next.length > 80) {
      setNameError("Keep it to 80 characters.");
      return;
    }
    setNameBusy(true);
    setNameError(null);
    try {
      const at = await getAccessTokenSilently();
      const res = await updateMyProfile({ displayName: next }, at);
      onSaved({ name: res.displayName, avatar });
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setNameBusy(false);
        expired();
        return;
      }
      setNameError(e instanceof Error ? e.message : "Couldn't save that name. Nothing changed.");
    } finally {
      setNameBusy(false);
    }
  };

  const pickPhoto = (file: File | undefined) => {
    setPhotoError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoError("That file isn't a photo — pick a JPEG, PNG, WebP, GIF or AVIF image.");
      return;
    }
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setZoom(1);
    setPhotoUrl(URL.createObjectURL(file));
  };

  const cancelPhoto = () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(null);
    setZoom(1);
    setPhotoError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const savePhoto = async () => {
    const img = previewRef.current;
    if (photoBusy || !img) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      // The DOM canvas satisfies CropCanvas structurally at runtime; the
      // cast bridges TS's strict image-source variance, not a real gap.
      const blob = await cropAvatar(img, zoom, document.createElement("canvas") as unknown as CropCanvas);
      const at = await getAccessTokenSilently();
      const res = await uploadMyAvatar(blob, at);
      onSaved({ name, avatar: res.avatar });
      cancelPhoto();
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setPhotoBusy(false);
        expired();
        return;
      }
      setPhotoError(e instanceof Error ? e.message : "Couldn't upload that photo. Nothing changed.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    if (removeBusy || !avatar) return;
    setRemoveBusy(true);
    setPhotoError(null);
    try {
      const at = await getAccessTokenSilently();
      const res = await deleteMyAvatar(at);
      onSaved({ name, avatar: res.avatar ?? undefined });
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setRemoveBusy(false);
        expired();
        return;
      }
      setPhotoError(e instanceof Error ? e.message : "Couldn't remove that photo. Nothing changed.");
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <Card className="mt-4 p-4 sm:p-6" data-testid="profile-editor">
      <p className="kicker">Edit profile</p>

      <div className="mt-3 flex items-center gap-4">
        {avatar && !photoUrl ? (
          <img
            src={avatar}
            alt=""
            referrerPolicy="no-referrer"
            className="h-16 w-16 shrink-0 rounded-full object-cover"
          />
        ) : !photoUrl ? (
          <span
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xl font-bold text-primary"
          >
            {initials(name)}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Photo</p>
          <p className="truncate text-xs text-muted-foreground">
            {photoUrl ? "Preview — drag the zoom until it looks right." : "Square crop, stored on Kiseki."}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={photoBusy}
              className="min-h-[44px]"
            >
              {avatar || photoUrl ? "Choose a new photo" : "Upload a photo"}
            </Button>
            {avatar && !photoUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void removePhoto()}
                disabled={removeBusy}
                className="min-h-[44px] text-destructive hover:text-destructive"
              >
                {removeBusy ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="Choose a profile photo"
            onChange={(e) => pickPhoto(e.target.files?.[0])}
          />
        </div>
      </div>

      {photoUrl && (
        <div className="mt-3 rounded-xl border border-border bg-muted/40 p-3">
          <div className="flex items-center gap-4">
            <img
              ref={previewRef}
              src={photoUrl}
              alt="Profile photo preview"
              className="h-32 w-32 shrink-0 rounded-lg object-cover"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
            />
            <div className="min-w-0 flex-1">
              <label htmlFor="avatar-zoom" className="text-xs font-medium text-muted-foreground">
                Zoom
              </label>
              <input
                id="avatar-zoom"
                type="range"
                min={1}
                max={3}
                step={0.1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="mt-1 w-full"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void savePhoto()} disabled={photoBusy} className="min-h-[44px]">
                  {photoBusy ? "Uploading…" : "Save photo"}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelPhoto} disabled={photoBusy} className="min-h-[44px]">
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {photoError && (
        <p role="alert" className="mt-2 text-xs font-medium text-destructive">
          {photoError}
        </p>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <label htmlFor="profile-display-name" className="text-sm font-medium">
          Name
        </label>
        <p className="text-xs text-muted-foreground">
          Shown on your profile and trips instead of your email address. Kiseki-only — it never changes your login.
        </p>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id="profile-display-name"
            type="text"
            value={draft}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveName();
            }}
            className="min-h-[44px] min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm focus-visible:focus-ring"
          />
          <Button
            size="sm"
            onClick={() => void saveName()}
            disabled={nameBusy || !draft.trim() || draft.trim() === name}
            className="min-h-[44px] shrink-0"
          >
            {nameBusy ? "Saving…" : "Save name"}
          </Button>
        </div>
        {nameError && (
          <p role="alert" className="mt-2 text-xs font-medium text-destructive">
            {nameError}
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * The profile body shared by `/u/:sub` and `/me`: header (avatar/monogram,
 * name, follower/following counts, Follow button), the self-only
 * `publicName` opt-in, drill-in people lists, and the trip list. Never
 * renders an email address — the type has no email field to read.
 *
 * `account` (only ever set by `MePage`) renders the self-only export/delete
 * area below the trips: its own component and fetch state, so a failure
 * there can never blank the profile.
 */
function ProfileView({
  sub,
  selfHint = false,
  account = false,
}: {
  sub: string;
  selfHint?: boolean;
  account?: boolean;
}) {
  const {
    isAuthenticated,
    isLoading: authLoading,
    getAccessTokenSilently,
    loginWithRedirect,
  } = useAuth0();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  // Bumped by the retry button — the load effect depends on it, so a retry
  // genuinely re-runs the fetch.
  const [attempt, setAttempt] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [openList, setOpenList] = useState<ListKind | null>(null);
  const [lists, setLists] = useState<Partial<Record<ListKind, PeopleList>>>({});
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [publicName, setPublicNameValue] = useState<boolean | null>(null);
  const [pnBusy, setPnBusy] = useState(false);
  const [pnError, setPnError] = useState<string | null>(null);

  usePageTitle(profile ? `${profile.name} · Profile` : "Profile");

  useEffect(() => {
    let cancelled = false;
    if (authLoading || !isAuthenticated) return;
    setProfile(null);
    setFailure(null);
    setFollowError(null);
    setOpenList(null);
    setLists({});
    setListError(null);
    setPublicNameValue(null);
    setPnError(null);
    getAccessTokenSilently()
      .then((at) => fetchUserProfile(sub, at))
      .then((doc) => {
        if (cancelled) return;
        setProfile(doc);
        if (typeof doc.publicName === "boolean") setPublicNameValue(doc.publicName);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure(toLoadFailure(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sub, isAuthenticated, authLoading, getAccessTokenSilently, attempt]);

  if (authLoading) return <Loading />;

  if (!isAuthenticated) {
    // No fetch storm: the profile endpoints need a token, so an anonymous
    // visitor gets the sign-in CTA instead of a failing request.
    return (
      <SignedOut
        title="Profiles need a sign-in."
        body="Sign in to see who's who on Kiseki — profiles are only visible to signed-in travellers."
      />
    );
  }

  if (failure) {
    return (
      <div className="min-h-screen">
        <LoadErrorPanel
          failure={failure}
          selfHint={selfHint}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </div>
    );
  }

  if (!profile) return <Loading />;

  const isSelf = profile.viewer.isSelf;
  const following = profile.viewer.following;

  const toggleFollow = async () => {
    // Guarded while in flight — no double-submit, no claimed success: the
    // button only flips after the server answers, and a failure leaves the
    // old state on screen with an error line.
    if (followBusy) return;
    setFollowBusy(true);
    setFollowError(null);
    const next = !following;
    try {
      const at = await getAccessTokenSilently();
      if (next) await followUser(sub, at);
      else await unfollowUser(sub, at);
      setProfile((p) =>
        p
          ? {
              ...p,
              viewer: { ...p.viewer, following: next },
              counts: {
                ...p.counts,
                followers: p.counts.followers + (next ? 1 : -1),
              },
            }
          : p,
      );
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setFollowBusy(false);
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setFollowError(e instanceof Error ? e.message : "Couldn't update the follow. Nothing changed.");
    } finally {
      setFollowBusy(false);
    }
  };

  const loadList = async (which: ListKind) => {
    // A failed fetch stores nothing, so retry is just another load.
    if (lists[which]) return;
    setListError(null);
    setListLoading(true);
    try {
      const at = await getAccessTokenSilently();
      const doc =
        which === "followers" ? await fetchUserFollowers(sub, at) : await fetchUserFollowing(sub, at);
      setLists((m) => ({ ...m, [which]: doc }));
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setListLoading(false);
        setOpenList(null);
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setListError(e instanceof Error ? e.message : "Couldn't load that list.");
    } finally {
      setListLoading(false);
    }
  };

  const toggleList = (which: ListKind) => {
    if (listLoading) return;
    if (openList === which) {
      setOpenList(null);
      return;
    }
    setOpenList(which);
    void loadList(which);
  };

  const flipPublicName = async () => {
    if (pnBusy || publicName === null) return;
    const next = !publicName;
    setPnBusy(true);
    setPnError(null);
    try {
      const at = await getAccessTokenSilently();
      const res = await setPublicName(next, at);
      setPublicNameValue(res.publicName);
      setProfile((p) => (p ? { ...p, publicName: res.publicName } : p));
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setPnBusy(false);
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setPnError(e instanceof Error ? e.message : "Couldn't save that. Nothing changed.");
    } finally {
      setPnBusy(false);
    }
  };

  const openDoc = openList ? lists[openList] : undefined;

  return (
    <div className="min-h-screen">
      <AppHeader
        home={{ to: "/", label: "Home" }}
        kicker="Profile"
        actions={<AuthButton />}
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Card className="p-4 sm:p-6">
          {/* Stacked on phones (#317): a long unbreakable name (an email
              address for passkey accounts) used to run UNDER the shrink-0
              Follow button. Column layout below `sm`, row above. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            {profile.avatar ? (
              <img
                src={profile.avatar}
                alt={profile.name}
                referrerPolicy="no-referrer"
                className="h-16 w-16 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xl font-bold text-primary"
              >
                {initials(profile.name)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="font-heading wrap-anywhere text-2xl font-semibold tracking-wide">
                {profile.name}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() => void toggleList("followers")}
                  aria-expanded={openList === "followers"}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
                >
                  <strong className="tabular-nums text-foreground">
                    {profile.counts.followers}
                  </strong>
                  Followers
                </button>
                <button
                  type="button"
                  onClick={() => void toggleList("following")}
                  aria-expanded={openList === "following"}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
                >
                  <strong className="tabular-nums text-foreground">
                    {profile.counts.following}
                  </strong>
                  Following
                </button>
              </div>
            </div>
            {!isSelf && (
              <Button
                variant={following ? "outline" : "default"}
                onClick={() => void toggleFollow()}
                disabled={followBusy}
                aria-pressed={following}
                aria-label={
                  following ? `Unfollow ${profile.name}` : `Follow ${profile.name}`
                }
                className="min-h-[44px] shrink-0 self-start"
              >
                {followBusy ? (
                  "Saving…"
                ) : following ? (
                  <>
                    <UserCheck className="h-4 w-4" aria-hidden="true" /> Following
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4" aria-hidden="true" /> Follow
                  </>
                )}
              </Button>
            )}
          </div>

          {followError && (
            <p role="alert" className="mt-3 text-xs font-medium text-destructive">
              {followError}
            </p>
          )}

          {isSelf && publicName !== null && (
            <div className="mt-4 rounded-xl border border-border bg-muted/40 p-3">
              <p className="kicker mb-1">Name on shared trips</p>
              <p className="text-sm text-muted-foreground">
                On a discoverable trip, other people see you as your initials
                unless you opt in.
              </p>
              <button
                type="button"
                role="switch"
                aria-checked={publicName}
                aria-label="Show my full name on discoverable trips"
                onClick={() => void flipPublicName()}
                disabled={pnBusy}
                className="mt-2 inline-flex min-h-[44px] items-center gap-2.5 rounded-md focus-visible:focus-ring disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    publicName ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-card shadow transition-transform ${
                      publicName ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </span>
                <span className="text-sm font-medium">
                  {pnBusy
                    ? "Saving…"
                    : publicName
                      ? "Using my full name"
                      : "Using my initials"}
                </span>
              </button>
              {pnError && (
                <p role="alert" className="mt-2 text-xs font-medium text-destructive">
                  {pnError}
                </p>
              )}
            </div>
          )}
        </Card>

        {isSelf && (
          <SelfProfileEditor
            name={profile.name}
            avatar={profile.avatar}
            getAccessTokenSilently={getAccessTokenSilently}
            loginWithRedirect={loginWithRedirect}
            onSaved={(next) =>
              setProfile((p) =>
                p ? { ...p, name: next.name, avatar: next.avatar } : p,
              )
            }
          />
        )}

        {openList && (
          <Card className="mt-4 p-3" aria-live="polite">
            <p className="kicker px-2 pb-1">
              {openList === "followers" ? "Followers" : "Following"}
            </p>
            {listLoading && !openDoc ? (
              <p
                className="animate-pulse px-2 py-3 text-sm text-muted-foreground"
                role="status"
              >
                Loading…
              </p>
            ) : listError ? (
              <div className="px-2 py-3">
                <p role="alert" className="text-sm font-medium text-destructive">
                  {listError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadList(openList)}
                  className="mt-2"
                >
                  Try again
                </Button>
              </div>
            ) : (
              openDoc && (
                <>
                  {openDoc.people.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">
                      {openList === "followers"
                        ? "No followers yet."
                        : "Not following anyone yet."}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {openDoc.people.map((p) => (
                        <li key={p.sub}>
                          <PersonRow person={p} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {openDoc.count > openDoc.people.length && (
                    <p className="px-2 pt-2 text-xs text-muted-foreground">
                      Showing {openDoc.people.length} of {openDoc.count}.
                    </p>
                  )}
                </>
              )
            )}
          </Card>
        )}

        <section aria-label="Trips" className="mt-8">
          <h2 className="font-heading text-xl font-semibold tracking-wide">
            Trips{" "}
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              ({profile.counts.trips})
            </span>
          </h2>
          {profile.trips.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
              No trips listed here yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {profile.trips.map((t) => (
                <li key={t.dtId}>
                  <TripRow trip={t} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {account && isSelf && <AccountPanel displayName={profile.name} />}
      </main>
    </div>
  );
}

/** `GET /u/:sub` — anyone's profile. Signed-out visitors get the sign-in
 *  CTA (the endpoints need a token); the Follow button never renders on
 *  your own profile. */
export function ProfilePage() {
  const { sub = "" } = useParams();
  return <ProfileView sub={sub} />;
}

// Fired once per session: the caller's twin must exist before their own
// profile can be read. A failure never breaks the page — the profile load
// below runs regardless, and its error states stay reachable.
let meEnsureFired = false;

/** `GET /me` — the signed-in user's own profile: ensures the twin once,
 *  then renders the same profile view (with the `publicName` control and
 *  no Follow button). Not signed in → an explicit sign-in page. */
export function MePage() {
  const {
    isAuthenticated,
    isLoading: authLoading,
    user,
    getAccessTokenSilently,
  } = useAuth0();
  const [ensureNote, setEnsureNote] = useState<string | null>(null);
  usePageTitle("Your profile");

  useEffect(() => {
    if (authLoading || !isAuthenticated || meEnsureFired) return;
    meEnsureFired = true;
    getAccessTokenSilently()
      .then((at) => ensureMe(at))
      .then(() => undefined)
      .catch((e: unknown) => {
        // An unrecoverable session surfaces below as the profile load's own
        // "sign in again" state — no note needed for that. Anything else is
        // a soft heads-up; the page keeps working.
        if (!isSessionExpiredError(e)) {
          setEnsureNote(
            "We couldn't prepare your profile just now — what you see may be incomplete.",
          );
        }
      });
  }, [authLoading, isAuthenticated, getAccessTokenSilently]);

  if (authLoading) return <Loading />;

  if (!isAuthenticated) {
    return (
      <SignedOut
        title="This is your profile."
        body="Sign in to see your trips, your followers, and your name settings."
      />
    );
  }

  const sub = user?.sub;
  if (!sub) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="font-heading text-2xl font-semibold">Your profile.</h1>
        <p role="alert" className="max-w-sm text-sm text-muted-foreground">
          We couldn't tell which account you're signed in as — try signing in
          again.
        </p>
        <Link
          to="/"
          className="text-sm font-medium text-primary underline underline-offset-2 focus-visible:focus-ring"
        >
          Home
        </Link>
      </div>
    );
  }

  return (
    <>
      {ensureNote && (
        <p
          role="status"
          className="no-print mx-auto max-w-3xl px-4 pt-4 text-center text-xs text-muted-foreground"
        >
          {ensureNote}
        </p>
      )}
      <ProfileView sub={sub} selfHint account />
    </>
  );
}
