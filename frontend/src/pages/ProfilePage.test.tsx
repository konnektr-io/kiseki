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
 * - (#317) your own profile carries the Edit profile card (peer profiles
 *   never do); saving a name PUTs /api/me {"displayName"} and renames the
 *   heading, a failed save keeps the old name with an error;
 * - (#317) the header stacks below `sm` with a wrapping name (no Follow /
 *   name overlap on phones);
 * - (#317) photo upload posts the cropped blob and swaps the header photo;
 *   remove falls back and clears it.
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

describe("ProfilePage — editing your profile (#317)", () => {
  const SELF_SUB = authState.sub;

  function editHandler(): Handler {
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
      return {
        ok: true,
        status: 200,
        body: {
          sub: SELF_SUB,
          name: "Me User",
          publicName: false,
          counts: { followers: 0, following: 0, trips: 0 },
          viewer: { isSelf: true, following: false },
          trips: [],
        },
      };
    };
  }

  function selfPath() {
    return `/u/${encodeURIComponent(SELF_SUB)}`;
  }

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

  it("renders the Edit profile card on your own profile, never on a peer's", async () => {
    stubFetch(editHandler());
    mount(selfPath());
    await flush();

    expect(container.querySelector('[data-testid="profile-editor"]')).not.toBeNull();
    expect(container.querySelector("#profile-display-name")).not.toBeNull();
  });

  it("a peer's profile carries no editor", async () => {
    stubFetch(() => okProfile());
    mount(peerPath);
    await flush();

    expect(container.querySelector('[data-testid="profile-editor"]')).toBeNull();
    expect(container.querySelector("#profile-display-name")).toBeNull();
  });

  it("saving a new name PUTs /api/me {displayName} and renames the heading", async () => {
    const sent = stubFetch(editHandler());
    mount(selfPath());
    await flush();

    await typeInto(
      container.querySelector("#profile-display-name") as HTMLInputElement,
      "Bea",
    );
    const saveBtn = Array.from(
      container.querySelectorAll('[data-testid="profile-editor"] button'),
    ).find((b) => b.textContent === "Save name")!;
    await click(saveBtn);

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
      return editHandler()(url, init);
    });
    mount(selfPath());
    await flush();

    await typeInto(
      container.querySelector("#profile-display-name") as HTMLInputElement,
      "Bea",
    );
    const saveBtn = Array.from(
      container.querySelectorAll('[data-testid="profile-editor"] button'),
    ).find((b) => b.textContent === "Save name")!;
    await click(saveBtn);

    expect(container.querySelector("h1")?.textContent).toBe("Me User");
    expect(container.querySelector('[data-testid="profile-editor"] [role="alert"]')?.textContent)
      .toContain("Graph not configured");
  });

  it("the header stacks below sm with a wrapping name (no Follow overlap)", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: peerProfile({ name: "josserke@yakult-very-long-domain.example.com" }),
    }));
    mount(peerPath);
    await flush();

    const header = container.querySelector("main > div:first-child > div, main > * > div");
    const h1 = container.querySelector("h1");
    // The h1 carries the unbreakable-token wrap; its flex row stacks below sm.
    expect(h1?.className).toContain("wrap-anywhere");
    let row: HTMLElement | null = h1?.parentElement ?? null;
    while (row && !row.className.includes("flex-col")) row = row.parentElement;
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("sm:flex-row");
    expect(header).not.toBeNull();
    const follow = container.querySelector('button[aria-label^="Follow"]');
    expect(follow?.className).toContain("self-start");
  });

  it("photo upload posts the cropped blob and swaps the header photo", async () => {
    const realCreateObjectURL = URL.createObjectURL;
    const drawImage = vi.fn();
    const getCtx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (this: HTMLCanvasElement, cb: (b: Blob | null) => void) {
        cb(new Blob(["cropped"], { type: "image/jpeg" }));
      } as unknown as typeof HTMLCanvasElement.prototype.toBlob);
    URL.createObjectURL = vi.fn(() => "blob:fake-photo") as unknown as typeof URL.createObjectURL;
    try {
      const sent = stubFetch((url, init) => {
        if (url === "/api/me/avatar" && init?.method === "POST") {
          return { ok: true, status: 200, body: { sub: SELF_SUB, avatar: "/api/avatars/abc.jpg" } };
        }
        return editHandler()(url, init);
      });
      mount(selfPath());
      await flush();

      const picker = container.querySelector(
        '[data-testid="profile-editor"] input[type="file"]',
      ) as HTMLInputElement;
      const file = new File(["bytes"], "me.png", { type: "image/png" });
      await act(async () => {
        Object.defineProperty(picker, "files", { value: [file], configurable: true });
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();

      // Preview + zoom appear; saving posts the blob with the token.
      expect(container.querySelector('img[alt="Profile photo preview"]')).not.toBeNull();
      const savePhoto = Array.from(
        container.querySelectorAll('[data-testid="profile-editor"] button'),
      ).find((b) => b.textContent === "Save photo")!;
      await click(savePhoto);

      expect(drawImage).toHaveBeenCalledTimes(1);
      const post = sent.find((c) => c.method === "POST" && c.url === "/api/me/avatar");
      expect(post?.auth).toBe("Bearer test-token");
      expect(container.querySelector('main img[src="/api/avatars/abc.jpg"]')).not.toBeNull();
    } finally {
      URL.createObjectURL = realCreateObjectURL;
      getCtx.mockRestore();
      toBlob.mockRestore();
    }
  });

  it("remove photo falls back and clears the header", async () => {
    const sent = stubFetch((url, init) => {
      if (url === "/api/me/avatar" && init?.method === "DELETE") {
        return { ok: true, status: 200, body: { sub: SELF_SUB, avatar: null } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          sub: SELF_SUB,
          name: "Me User",
          avatar: "/api/avatars/old.jpg",
          publicName: false,
          counts: { followers: 0, following: 0, trips: 0 },
          viewer: { isSelf: true, following: false },
          trips: [],
        },
      };
    });
    mount(selfPath());
    await flush();

    expect(container.querySelector('main img[src="/api/avatars/old.jpg"]')).not.toBeNull();
    const remove = Array.from(
      container.querySelectorAll('[data-testid="profile-editor"] button'),
    ).find((b) => b.textContent === "Remove")!;
    await click(remove);

    const del = sent.find((c) => c.method === "DELETE" && c.url === "/api/me/avatar");
    expect(del?.auth).toBe("Bearer test-token");
    expect(container.querySelector('main img[src="/api/avatars/old.jpg"]')).toBeNull();
  });
});
