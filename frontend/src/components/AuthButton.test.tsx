// @vitest-environment jsdom
/**
 * Header account chip avatar (follow-up to #320): the chip shows the Kiseki
 * profile photo when the twin has one, else the Auth0 session picture, else
 * initials — in BOTH clusters (desktop row + phone menu chip).
 *
 * Gates:
 * - twin avatar wins over the session picture;
 * - twin without avatar falls back to the session picture;
 * - a failed profile read falls back silently (no crash, no redirect);
 * - one profile read per sub no matter how often the header remounts;
 * - a cache write (upload/remove path) is picked up without a refetch.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  sub: "auth0|me-user",
  picture: "https://auth0.example.com/session-photo.jpg",
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  loginWithRedirect: vi.fn(async () => undefined),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
    user: authState.isAuthenticated
      ? { sub: authState.sub, name: "Me User", picture: authState.picture }
      : undefined,
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: authState.loginWithRedirect,
    logout: async () => undefined,
  }),
}));

vi.mock("../lib/posthog", () => ({ resetIdentity: () => undefined }));

const { AuthButton } = await import("./AuthButton");
const { clearMyAvatarCache, myAvatar, setMyAvatar } = await import("../lib/my-avatar");

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <AuthButton />
      </MemoryRouter>,
    );
  });
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function stubProfile(handler: (url: string) => { ok: boolean; status: number; body?: unknown }): {
  calls: string[];
} {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const r = handler(url);
      if (r.ok) return { ok: true, status: r.status, json: async () => r.body } as unknown as Response;
      return { ok: false, status: r.status, text: async () => "{}" } as unknown as Response;
    }),
  );
  return { calls };
}

/** Both clusters render an <img>; collect every header photo src. */
function headerPhotos(): string[] {
  return Array.from(container.querySelectorAll("img"))
    .map((img) => img.getAttribute("src") ?? "")
    .filter(Boolean);
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearMyAvatarCache();
  authState.isAuthenticated = true;
  authState.isLoading = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AuthButton avatar — Kiseki photo first, session picture fallback", () => {
  it("shows the Kiseki profile photo when the twin has one", async () => {
    stubProfile(() => ({
      ok: true,
      status: 200,
      body: { sub: authState.sub, name: "Me User", avatar: "/api/avatars/abc.jpg" },
    }));
    mount();
    await flush();

    const photos = headerPhotos();
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((src) => src === "/api/avatars/abc.jpg")).toBe(true);
  });

  it("falls back to the Auth0 session picture when the twin has no photo", async () => {
    stubProfile(() => ({
      ok: true,
      status: 200,
      body: { sub: authState.sub, name: "Me User" },
    }));
    mount();
    await flush();

    const photos = headerPhotos();
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((src) => src === authState.picture)).toBe(true);
  });

  it("a failed profile read falls back silently — no crash, no redirect", async () => {
    stubProfile(() => ({ ok: false, status: 500 }));
    mount();
    await flush();

    const photos = headerPhotos();
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((src) => src === authState.picture)).toBe(true);
    expect(authState.loginWithRedirect).not.toHaveBeenCalled();
  });

  it("reads the profile once per sub across remounts", async () => {
    const { calls } = stubProfile(() => ({
      ok: true,
      status: 200,
      body: { sub: authState.sub, name: "Me User", avatar: "/api/avatars/abc.jpg" },
    }));
    mount();
    await flush();
    act(() => root.unmount());
    container.remove();
    mount();
    await flush();

    expect(calls.filter((u) => u.includes("/api/users/"))).toHaveLength(1);
  });

  it("a cache write (upload/remove) swaps the chip without a refetch", async () => {
    const { calls } = stubProfile(() => ({
      ok: true,
      status: 200,
      body: { sub: authState.sub, name: "Me User" },
    }));
    mount();
    await flush();
    expect(headerPhotos().every((src) => src === authState.picture)).toBe(true);

    await act(async () => {
      setMyAvatar(authState.sub, "/api/avatars/new.jpg");
    });
    // A fresh mount (e.g. navigating back from /me after an upload) reads cache.
    act(() => root.unmount());
    container.remove();
    mount();
    await flush();

    expect(headerPhotos().every((src) => src === "/api/avatars/new.jpg")).toBe(true);
    expect(calls.filter((u) => u.includes("/api/users/"))).toHaveLength(1);
  });

  it("myAvatar resolves null on failure and caches the answer", async () => {
    stubProfile(() => ({ ok: false, status: 503 }));
    const first = await myAvatar(authState.sub, authState.getAccessTokenSilently);
    const second = await myAvatar(authState.sub, authState.getAccessTokenSilently);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(authState.getAccessTokenSilently).toHaveBeenCalledTimes(1);
  });
});
