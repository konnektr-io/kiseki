// @vitest-environment jsdom
/**
 * User profile page (#196 phase D).
 *
 * The REAL ProfilePage/MePage mounted into a DOM (JoinPage.test.tsx
 * pattern — the profile loads in an effect, so renderToString can't reach
 * it), with `fetch` stubbed per test (api.test.ts pattern) and the Auth0
 * context controlled through a hoisted mock.
 *
 * Gates under test:
 * - a peer's profile renders name, counts and their trips (verbatim);
 * - follow/unfollow flip the button, send the bearer token, and never
 *   claim success on failure;
 * - your own profile shows no Follow button and does show the publicName
 *   switch, whose toggle PUTs /api/me with {"publicName": …};
 * - signed-out visitors get a sign-in CTA and cause no fetch storm;
 * - 404 and 503 render distinct, human error states;
 * - a truncated drill-in says so honestly ("Showing 1 of 250");
 * - a peer's email is never rendered, even if the payload carries one.
 * - (#317/#320) your own profile edits IN PLACE — the avatar button opens the
 *   picker, the shared inline-edit pencil renames (PUT /api/me {displayName}),
 *   a peer's profile carries neither; the crop dialog clips a fixed square
 *   viewport, positions the photo in px (never a scale transform), posts the
 *   cropped blob on save and clears the header photo on remove.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NB: the function identities here must be STABLE across renders (defined
// once in the hoisted object, like the real SDK's stable callbacks): the
// profile load effect depends on `getAccessTokenSilently`, and a fresh
// identity per render would re-fire the effect forever (an unbounded fetch
// loop that OOMs the worker).
const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  sub: "auth0|me-user",
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  loginWithRedirect: vi.fn(async () => undefined),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
    user: authState.isAuthenticated
      ? { sub: authState.sub, name: "Me User", email: "me@example.com" }
      : undefined,
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: authState.loginWithRedirect,
    logout: async () => undefined,
  }),
}));

const { MePage, ProfilePage } = await import("./ProfilePage");

const PEER_SUB = "google-oauth2|100613034256980569871";
const peerPath = `/u/${encodeURIComponent(PEER_SUB)}`;

interface SentCall {
  url: string;
  method: string;
  body?: string;
  auth?: string;
}

type Handler = (url: string, init?: { method?: string; body?: string }) => {
  ok: boolean;
  status: number;
  body?: unknown;
  detail?: string;
};

/** Stub global fetch: records every call, answers through `handler`. */
function stubFetch(handler: Handler): SentCall[] {
  const sent: SentCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body,
        auth: init?.headers?.Authorization,
      });
      const r = handler(url, init);
      if (r.ok) {
        return { ok: true, status: r.status, json: async () => r.body } as unknown as Response;
      }
      return {
        ok: false,
        status: r.status,
        text: async () => JSON.stringify({ detail: r.detail ?? "error" }),
      } as unknown as Response;
    }),
  );
  return sent;
}

function peerProfile(overrides: Record<string, unknown> = {}) {
  return {
    sub: PEER_SUB,
    name: "Alex Traveller",
    counts: { followers: 3, following: 1, trips: 2 },
    viewer: { isSelf: false, following: false },
    trips: [
      {
        dtId: "11111111-1111-4111-8111-111111111111",
        title: "Canada 2027",
        stage: "booked",
        startDate: "2027-02-01",
        endDate: "2027-02-16",
        visibility: "private",
        discoverable: true,
      },
      {
        dtId: "22222222-2222-4222-8222-222222222222",
        title: "Japan 2028",
        subtitle: "Campervan winter",
        stage: "planned",
        visibility: "private",
        discoverable: true,
        myRole: "viewer",
      },
    ],
    ...overrides,
  };
}

const okProfile = () => ({ ok: true, status: 200, body: peerProfile() });

let container: HTMLDivElement;
let root: Root;

function mount(path: string, page: "profile" | "me" = "profile") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/u/:sub" element={page === "profile" ? <ProfilePage /> : <MePage />} />
          <Route path="/me" element={<MePage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Flush pending microtasks + effects inside act(). Twice over: the load
 *  chains getAccessTokenSilently → fetch → json. */
async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  authState.isAuthenticated = true;
  authState.isLoading = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProfilePage — a peer's profile", () => {
  it("renders the name, counts and their trips verbatim (role vs discoverable)", async () => {
    stubFetch(() => okProfile());
    mount(peerPath);
    await flush();

    expect(container.textContent).toContain("Alex Traveller");
    expect(container.textContent).toContain("Canada 2027");
    expect(container.textContent).toContain("Japan 2028");
    // Counts ride the buttons that open the drill-ins.
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent === "3Followers")).toBe(true);
    expect(buttons.some((b) => b.textContent === "1Following")).toBe(true);
    // myRole present → the role pill (landing-page idiom); absent → the
    // honest Discoverable badge, never a fabricated role.
    expect(container.textContent).toContain("viewer");
    expect(container.textContent).toContain("Discoverable");
  });

  it("follow flips the button, sends the token, and unfollow flips it back", async () => {
    const sent = stubFetch((url, init) => {
      if (url.endsWith("/follow") && (init?.method ?? "GET") !== "GET") {
        return {
          ok: true,
          status: 200,
          body: { sub: PEER_SUB, following: init?.method === "POST" },
        };
      }
      return okProfile();
    });
    mount(peerPath);
    await flush();

    const followBtn = () =>
      container.querySelector('button[aria-label="Follow Alex Traveller"],button[aria-label="Unfollow Alex Traveller"]');

    expect(followBtn()?.getAttribute("aria-label")).toBe("Follow Alex Traveller");
    await click(followBtn()!);

    const post = sent.find((c) => c.method === "POST" && c.url.endsWith("/follow"));
    expect(post?.auth).toBe("Bearer test-token");
    expect(post?.url).toBe(`/api/users/${encodeURIComponent(PEER_SUB)}/follow`);
    expect(followBtn()?.getAttribute("aria-label")).toBe("Unfollow Alex Traveller");
    expect(container.textContent).toContain("4Followers");

    await click(followBtn()!);
    const del = sent.find((c) => c.method === "DELETE" && c.url.endsWith("/follow"));
    expect(del?.auth).toBe("Bearer test-token");
    expect(followBtn()?.getAttribute("aria-label")).toBe("Follow Alex Traveller");
    expect(container.textContent).toContain("3Followers");
  });

  it("a failed follow never claims success — the button stays and an error shows", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/follow") && init?.method === "POST") {
        return { ok: false, status: 500, detail: "Could not follow user" };
      }
      return okProfile();
    });
    mount(peerPath);
    await flush();

    const followBtn = () =>
      container.querySelector('button[aria-label="Follow Alex Traveller"],button[aria-label="Unfollow Alex Traveller"]');
    await click(followBtn()!);

    // Still "Follow" (not "Following"), count untouched, error on screen.
    expect(followBtn()?.getAttribute("aria-label")).toBe("Follow Alex Traveller");
    expect(container.textContent).toContain("3Followers");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not follow user");
  });

  it("never renders a peer's email, even if the payload carries one", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: peerProfile({ email: "alex-private@example.com" }),
    }));
    mount(peerPath);
    await flush();

    expect(container.textContent).toContain("Alex Traveller");
    expect(container.textContent).not.toContain("alex-private@example.com");
  });

  it("says truncation honestly when count exceeds the drill-in list", async () => {
    stubFetch((url) => {
      if (url.endsWith("/followers")) {
        return {
          ok: true,
          status: 200,
          body: { count: 250, people: [{ sub: "auth0|fan", name: "Sam Fan" }] },
        };
      }
      return okProfile();
    });
    mount(peerPath);
    await flush();

    const followersBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "3Followers",
    )!;
    await click(followersBtn);

    expect(container.textContent).toContain("Sam Fan");
    expect(container.textContent).toContain("Showing 1 of 250.");
  });

  it("never renders an email smuggled into the drill-in payload", async () => {
    // The follower/following list is the second path a peer's address could
    // ride along on, and the one an earlier leak hid behind — prove this
    // path drops it too, not just the profile doc.
    stubFetch((url) => {
      if (url.endsWith("/followers")) {
        return {
          ok: true,
          status: 200,
          body: {
            count: 1,
            people: [
              { sub: "auth0|fan", name: "Sam Fan", email: "sam-private@example.com" },
            ],
          },
        };
      }
      return okProfile();
    });
    mount(peerPath);
    await flush();

    const followersBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "3Followers",
    )!;
    await click(followersBtn);

    expect(container.textContent).toContain("Sam Fan");
    expect(container.textContent).not.toContain("sam-private@example.com");
  });
});

describe("ProfilePage — your own profile (viewer.isSelf)", () => {
  function selfHandler(): Handler {
    return (url, init) => {
      if (url === "/api/me" && init?.method === "PUT") {
        const next = (JSON.parse(init?.body ?? "{}") as { publicName?: boolean }).publicName;
        return { ok: true, status: 200, body: { sub: authState.sub, ensured: true, publicName: next } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          sub: authState.sub,
          name: "Me User",
          publicName: false,
          counts: { followers: 0, following: 0, trips: 0 },
          viewer: { isSelf: true, following: false },
          trips: [],
        },
      };
    };
  }

  it("shows no Follow button and does show the publicName control", async () => {
    stubFetch(selfHandler());
    mount(`/u/${encodeURIComponent(authState.sub)}`);
    await flush();

    expect(container.textContent).toContain("Me User");
    expect(container.querySelector('button[aria-label^="Follow"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Unfollow"]')).toBeNull();
    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.textContent).toContain("Using my initials");
  });

  it("toggling publicName PUTs /api/me with {\"publicName\": …} and flips the label", async () => {
    const sent = stubFetch(selfHandler());
    mount(`/u/${encodeURIComponent(authState.sub)}`);
    await flush();

    await click(container.querySelector('button[role="switch"]')!);

    const put = sent.find((c) => c.method === "PUT" && c.url === "/api/me");
    expect(put?.auth).toBe("Bearer test-token");
    expect(JSON.parse(put?.body ?? "{}")).toEqual({ publicName: true });
    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.textContent).toContain("Using my full name");
  });
});

describe("ProfilePage — states", () => {
  it("signed-out visitors get a sign-in CTA and cause no fetch storm", async () => {
    authState.isAuthenticated = false;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    mount(peerPath);
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Profiles need a sign-in.");
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Sign in"),
    ).toBe(true);
  });

  it("an unknown user (404) renders a human not-found state", async () => {
    stubFetch(() => ({ ok: false, status: 404, detail: "Unknown user" }));
    mount(peerPath);
    await flush();

    expect(container.textContent).toContain("No such user.");
    expect(container.textContent).not.toContain("directory is taking a break");
  });

  it("graph-not-configured (503) renders a distinct unavailable state", async () => {
    stubFetch(() => ({ ok: false, status: 503, detail: "Graph not configured" }));
    mount(peerPath);
    await flush();

    expect(container.textContent).toContain("directory is taking a break");
    expect(container.textContent).not.toContain("No such user.");
  });
});

describe("MePage — the signed-in user's own profile", () => {
  it("ensures the twin once per session across remounts, then renders the profile", async () => {
    vi.resetModules();
    const { MePage: FreshMePage } = await import("./ProfilePage");
    const sent = stubFetch((url) => {
      if (url === "/api/me/ensure") {
        return { ok: true, status: 200, body: { sub: authState.sub, ensured: true } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          sub: authState.sub,
          name: "Me User",
          publicName: true,
          counts: { followers: 1, following: 0, trips: 0 },
          viewer: { isSelf: true, following: false },
          trips: [],
        },
      };
    });

    for (const Root_ of [FreshMePage, FreshMePage]) {
      const el = document.createElement("div");
      document.body.appendChild(el);
      const r = createRoot(el);
      await act(async () => {
        r.render(
          <MemoryRouter initialEntries={["/me"]}>
            <Routes>
              <Route path="/me" element={<Root_ />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();
      expect(el.textContent).toContain("Me User");
      // The self view carries the opt-in and never a Follow button.
      expect(el.querySelector('button[role="switch"]')).not.toBeNull();
      expect(el.querySelector('button[aria-label^="Follow"]')).toBeNull();
      await act(async () => {
        r.unmount();
      });
      el.remove();
    }

    expect(sent.filter((c) => c.url === "/api/me/ensure" && c.method === "POST")).toHaveLength(1);
  });

  it("not signed in → an explicit sign-in page, not an error", async () => {
    authState.isAuthenticated = false;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    mount("/me", "me");
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This is your profile.");
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Sign in"),
    ).toBe(true);
  });
});

describe("ProfilePage — editing your profile (#317/#320)", () => {
  const SELF_SUB = authState.sub;

  function selfDoc(overrides: Record<string, unknown> = {}) {
    return {
      sub: SELF_SUB,
      name: "Me User",
      publicName: false,
      counts: { followers: 0, following: 0, trips: 0 },
      viewer: { isSelf: true, following: false },
      trips: [],
      ...overrides,
    };
  }

  function editHandler(extra?: Handler): Handler {
    const tail: Handler = extra ?? (() => ({ ok: true, status: 200, body: selfDoc() }));
    return (url, init) => {
      if (url === "/api/me" && init?.method === "PUT") {
        const patch = JSON.parse(init?.body ?? "{}") as { displayName?: string };
        const name = patch.displayName ?? "Me User";
        return {
          ok: true,
          status: 200,
          body: { sub: SELF_SUB, ensured: true, name, displayName: name, publicName: false },
        };
      }
      return tail(url, init);
    };
  }

  const selfPath = () => `/u/${encodeURIComponent(SELF_SUB)}`;

  /** Drive a controlled input the way the skill prescribes: native setter
   *  + `input` event inside act(). */
  async function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  }

  async function pickFile(file: File) {
    const picker = container.querySelector(
      'input[type="file"][aria-label="Choose a profile photo"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  /** jsdom never loads an image, so `onLoad` (which is what measures the
   *  photo) has to be driven by hand — otherwise the crop maths never gets
   *  its dimensions and Save stays disabled. */
  async function loadPhoto(naturalWidth = 1200, naturalHeight = 800) {
    const photo = container.querySelector('[data-testid="avatar-photo"]') as HTMLImageElement;
    Object.defineProperty(photo, "naturalWidth", { value: naturalWidth, configurable: true });
    Object.defineProperty(photo, "naturalHeight", { value: naturalHeight, configurable: true });
    await act(async () => {
      photo.dispatchEvent(new Event("load"));
    });
    await flush();
  }

  /** jsdom has no canvas 2d context and no object URLs. */
  function stubCanvasBits() {
    const realCreateObjectURL = URL.createObjectURL;
    const drawImage = vi.fn();
    const getCtx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(((cb: (b: Blob | null) => void) =>
        cb(new Blob(["cropped"], { type: "image/jpeg" }))) as unknown as typeof HTMLCanvasElement.prototype.toBlob);
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:fake-photo"),
      configurable: true,
      writable: true,
    });
    return {
      drawImage,
      restore() {
        Object.defineProperty(URL, "createObjectURL", {
          value: realCreateObjectURL,
          configurable: true,
          writable: true,
        });
        getCtx.mockRestore();
        toBlob.mockRestore();
      },
    };
  }

  it("your own profile edits in place: avatar is the upload button, name has the pencil", async () => {
    stubFetch(editHandler());
    mount(selfPath());
    await flush();

    // The heavy "Edit profile" card is gone (#320) — the header itself edits.
    expect(container.querySelector('[data-testid="profile-editor"]')).toBeNull();
    const avatarBtn = container.querySelector('button[aria-label="Add a profile photo"]');
    expect(avatarBtn).not.toBeNull();
    expect(container.querySelector('button[aria-label="Choose a profile photo"]')).toBeNull();
    // The shared inline-edit pencil, the same control trip titles use.
    expect(container.querySelector('button[aria-label="Edit name"]')).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Me User");
  });

  it("a peer's profile has no edit affordances at all", async () => {
    stubFetch(() => okProfile());
    mount(peerPath);
    await flush();

    expect(container.querySelector('[data-testid="profile-avatar-button"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Edit name"]')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector('[data-testid="avatar-viewport"]')).toBeNull();
  });
  it("clicking your avatar opens the file picker", async () => {
    stubFetch(editHandler());
    mount(selfPath());
    await flush();

    const picker = container.querySelector(
      'input[type="file"][aria-label="Choose a profile photo"]',
    ) as HTMLInputElement;
    const clickSpy = vi.spyOn(picker, "click").mockImplementation(() => undefined);
    await click(container.querySelector('button[aria-label="Add a profile photo"]')!);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("picking a photo opens the square cropper: clipped viewport, pan+zoom, explicit px", async () => {
    const { restore } = stubCanvasBits();
    try {
      stubFetch(editHandler());
      mount(selfPath());
      await flush();
      await pickFile(new File(["bytes"], "me.png", { type: "image/png" }));
      await loadPhoto();

      const dialog = container.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const viewport = container.querySelector('[data-testid="avatar-viewport"]') as HTMLElement;
      // The #320 defect: the photo was clipped by NOTHING, so zoom spilled it
      // over the page. The viewport must own the clipping.
      expect(viewport.className).toContain("overflow-hidden");
      expect(viewport.className).toContain("touch-none");
      // …and the photo is positioned in px with a translate (never a scale
      // transform that escapes the box).
      const photo = container.querySelector('[data-testid="avatar-photo"]') as HTMLImageElement;
      expect(photo.style.transform).toContain("translate3d");
      expect(photo.style.transform).not.toContain("scale");
      expect(photo.style.width).toMatch(/px$/);
      expect(container.querySelector('input[type="range"]')).not.toBeNull();
      // Remove is offered only because this profile has no photo yet → absent.
      expect(
        Array.from(dialog!.querySelectorAll("button")).some((b) => b.textContent === "Remove photo"),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("Save photo posts the cropped blob and swaps the header photo", async () => {
    const bits = stubCanvasBits();
    try {
      const sent = stubFetch(
        editHandler((url, init) => {
          if (url === "/api/me/avatar" && init?.method === "POST") {
            return { ok: true, status: 200, body: { sub: SELF_SUB, avatar: "/api/avatars/abc.jpg" } };
          }
          return { ok: true, status: 200, body: selfDoc() };
        }),
      );
      mount(selfPath());
      await flush();
      await pickFile(new File(["bytes"], "me.png", { type: "image/png" }));
      await loadPhoto();

      const save = Array.from(container.querySelectorAll('[role="dialog"] button')).find(
        (b) => b.textContent === "Save photo",
      )!;
      await click(save);

      expect(bits.drawImage).toHaveBeenCalledTimes(1);
      const post = sent.find((c) => c.method === "POST" && c.url === "/api/me/avatar");
      expect(post?.auth).toBe("Bearer test-token");
      // Dialog closed, header shows the new photo (no token in the src — the
      // route is public, #320).
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      const shown = container.querySelector('img[src="/api/avatars/abc.jpg"]');
      expect(shown).not.toBeNull();
    } finally {
      bits.restore();
    }
  });

  it("a failed photo upload keeps the dialog open with the server's word", async () => {
    const bits = stubCanvasBits();
    try {
      stubFetch(
        editHandler((url, init) => {
          if (url === "/api/me/avatar" && init?.method === "POST") {
            return { ok: false, status: 422, detail: "that file is not a photo" };
          }
          return { ok: true, status: 200, body: selfDoc() };
        }),
      );
      mount(selfPath());
      await flush();
      await pickFile(new File(["bytes"], "me.png", { type: "image/png" }));
      await loadPhoto();
      const save = Array.from(container.querySelectorAll('[role="dialog"] button')).find(
        (b) => b.textContent === "Save photo",
      )!;
      await click(save);

      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
        "not a photo",
      );
    } finally {
      bits.restore();
    }
  });

  it("Remove photo (inside the dialog) clears the header photo", async () => {
    const bits = stubCanvasBits();
    try {
      const sent = stubFetch(
        editHandler((url, init) => {
          if (url === "/api/me/avatar" && init?.method === "DELETE") {
            return { ok: true, status: 200, body: { sub: SELF_SUB, avatar: null } };
          }
          return {
            ok: true,
            status: 200,
            body: selfDoc({ avatar: "/api/avatars/old.jpg" }),
          };
        }),
      );
      mount(selfPath());
      await flush();
      expect(container.querySelector('img[src="/api/avatars/old.jpg"]')).not.toBeNull();

      await pickFile(new File(["bytes"], "me.png", { type: "image/png" }));
      await loadPhoto();
      const remove = Array.from(container.querySelectorAll('[role="dialog"] button')).find(
        (b) => b.textContent === "Remove photo",
      )!;
      await click(remove);

      const del = sent.find((c) => c.method === "DELETE" && c.url === "/api/me/avatar");
      expect(del?.auth).toBe("Bearer test-token");
      expect(container.querySelector('img[src="/api/avatars/old.jpg"]')).toBeNull();
    } finally {
      bits.restore();
    }
  });

  it("the pencil renames through PUT /api/me {displayName} and the h1 follows", async () => {
    const sent = stubFetch(editHandler());
    mount(selfPath());
    await flush();

    await click(container.querySelector('button[aria-label="Edit name"]')!);
    const field = container.querySelector("input#inline-name") as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(field.value).toBe("Me User");

    await typeInto(field, "Bea");
    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    )!;
    await click(save);

    const put = sent.find((c) => c.method === "PUT" && c.url === "/api/me");
    expect(put?.auth).toBe("Bearer test-token");
    expect(JSON.parse(put?.body ?? "{}")).toEqual({ displayName: "Bea" });
    expect(container.querySelector("h1")?.textContent).toBe("Bea");
  });

  it("a failed rename keeps the old name with an error", async () => {
    stubFetch((url, init) => {
      if (url === "/api/me" && init?.method === "PUT") {
        return { ok: false, status: 500, detail: "Graph not configured" };
      }
      return { ok: true, status: 200, body: selfDoc() };
    });
    mount(selfPath());
    await flush();

    await click(container.querySelector('button[aria-label="Edit name"]')!);
    const field = container.querySelector("input#inline-name") as HTMLInputElement;
    await typeInto(field, "Bea");
    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    )!;
    await click(save);

    // The field stays open (nothing was saved) with the server's message …
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Graph not configured");
    // … and cancelling proves the profile still reads the OLD name.
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    )!;
    await click(cancel);
    expect(container.querySelector("h1")?.textContent).toBe("Me User");
  });

  it("the header stacks below sm with a wrapping name (no Follow overlap)", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: peerProfile({ name: "josserke.vanherckelele1974@yahoo.com" }),
    }));
    mount(peerPath);
    await flush();

    const h1 = container.querySelector("h1");
    // The h1 carries the unbreakable-token wrap; its flex row stacks below sm.
    expect(h1?.className).toContain("wrap-anywhere");
    let row: HTMLElement | null = h1?.parentElement ?? null;
    while (row && !row.className.includes("flex-col")) row = row.parentElement;
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("sm:flex-row");
    const follow = container.querySelector('button[aria-label^="Follow"]');
    expect(follow?.className).toContain("self-start");
  });
});
