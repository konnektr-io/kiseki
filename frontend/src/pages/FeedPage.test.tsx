// @vitest-environment jsdom
/**
 * Activity feed page (#199).
 *
 * The REAL FeedPage mounted into a DOM (ProfilePage.test.tsx pattern — the
 * feed loads in an effect, so renderToString can't reach it), with `fetch`
 * stubbed per test and the Auth0 context controlled through a hoisted mock.
 * The real `fetchFeed` runs, so the request the page makes is under test too.
 *
 * Gates under test:
 * - both streams render, grouped one block per trip, in the server's order;
 * - every link is a trip id route (`/t/<dtId>`, `/t/<dtId>/day/<idx>`) — the
 *   slug form is dead and must never come back;
 * - an item row carries its label and its photos inline (the mom scenario);
 * - the empty state says what to do (follow people), not just "nothing here";
 * - signed-out visitors get a sign-in CTA and make no request at all;
 * - an expired session and an unreachable graph read differently;
 * - a window focus refreshes, and "Load older" pages through `before`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stable identities for the SDK callbacks: the load effect depends on
// `getAccessTokenSilently`, and a fresh identity per render would re-fire it
// forever (an unbounded fetch loop that OOMs the worker).
const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  loginWithRedirect: vi.fn(async () => undefined),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
    user: { name: "Me User" },
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: authState.loginWithRedirect,
    logout: async () => undefined,
  }),
}));

const { FeedPage, groupByTrip, relativeTime } = await import("./FeedPage");

const TRIP_A = "11111111-1111-4111-8111-111111111111";
const TRIP_B = "22222222-2222-4222-8222-222222222222";

interface SentCall {
  url: string;
  method: string;
  auth?: string;
}

type Handler = (url: string, init?: { method?: string }) => {
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
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      sent.push({ url, method: init?.method ?? "GET", auth: init?.headers?.Authorization });
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

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    kind: "item",
    tripId: TRIP_B,
    tripTitle: "Burning Man 2027",
    source: "followed-user",
    at: "2026-09-14T10:00:00Z",
    by: "google-oauth2|100613034256980569871",
    dayIndex: 2,
    dayTitle: "Day 3",
    blockTitle: "Camp",
    label: "4 photos added",
    thumbs: [`/media/${TRIP_B}/a.jpg`, `/media/${TRIP_B}/b.jpg`, `/media/${TRIP_B}/c.jpg`],
    href: `/t/${TRIP_B}/day/2`,
    ...overrides,
  };
}

function feedDoc(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-09-14T12:00:00Z",
    nextBefore: null,
    items: [
      {
        kind: "trip",
        tripId: TRIP_A,
        tripTitle: "Canada 2027",
        source: "my-trip",
        at: "2026-09-14T11:00:00Z",
        by: "auth0|me-user",
        changes: ["title", "cover photo"],
        href: `/t/${TRIP_A}`,
      },
      itemRow(),
    ],
    ...overrides,
  };
}

const okFeed = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  body: feedDoc(overrides),
});

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/feed"]}>
        <Routes>
          <Route path="/feed" element={<FeedPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Flush pending microtasks + effects inside act(). Twice over: the load chains
 *  getAccessTokenSilently → fetch → json. */
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

const hrefs = () =>
  Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");

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

describe("relativeTime", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");

  it("reads in minutes, hours, days — then falls back to a date", () => {
    expect(relativeTime("2026-09-14T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-14T11:48:00Z", now)).toBe("12 min ago");
    expect(relativeTime("2026-09-14T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-12T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("2026-07-01T12:00:00Z", now)).toBe("Jul 1, 2026");
  });

  it("says nothing rather than something wrong for a missing stamp", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("groupByTrip", () => {
  it("keeps the server's order and gathers a trip's rows into one block", () => {
    const groups = groupByTrip([
      itemRow({ at: "2026-09-14T10:00:00Z" }),
      { kind: "trip", tripId: TRIP_A, tripTitle: "Canada 2027", href: `/t/${TRIP_A}` },
      itemRow({ at: "2026-09-14T09:00:00Z", href: `/t/${TRIP_B}/day/1` }),
    ] as never);

    expect(groups.map((g) => g.tripId)).toEqual([TRIP_B, TRIP_A]);
    expect(groups[0].entries.map((e) => e.href)).toEqual([
      `/t/${TRIP_B}/day/2`,
      `/t/${TRIP_B}/day/1`,
    ]);
  });
});

describe("FeedPage — the feed itself", () => {
  it("renders both streams, one block per trip, with the write labels", async () => {
    stubFetch(() => okFeed());
    mount();
    await flush();

    expect(container.textContent).toContain("Canada 2027");
    expect(container.textContent).toContain("Burning Man 2027");
    expect(container.textContent).toContain("Updated title, cover photo");
    expect(container.textContent).toContain("4 photos added");
    expect(container.textContent).toContain("Day 3");

    // One request, bearer token attached, aimed at the feed endpoint.
    expect(container.textContent).not.toContain("Loading your feed");
  });

  it("names the block that moved, not just the day and an action", async () => {
    stubFetch(() => okFeed());
    mount();
    await flush();

    // The day can hold several blocks, so the row has to say which one moved.
    expect(container.textContent).toContain("Camp");
    expect(container.textContent).toContain("4 photos added");
  });

  it("still reads when a payload carries no block title", async () => {
    stubFetch(() => okFeed({ items: [itemRow({ blockTitle: "" })] }));
    mount();
    await flush();

    expect(container.textContent).toContain("4 photos added");
  });

  it("sends the caller's token to /api/feed", async () => {
    const sent = stubFetch(() => okFeed());
    mount();
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/feed");
    expect(sent[0].auth).toBe("Bearer test-token");
  });

  it("shows the photos inline on an item row — the point of item granularity", async () => {
    stubFetch(() => okFeed());
    mount();
    await flush();

    // Scoped to the feed content: the shared bar (#239) carries its own mark,
    // so a page-global `img` query no longer means "this item's photos".
    const imgs = Array.from(container.querySelectorAll("main img")).map((i) => i.getAttribute("src"));
    expect(imgs).toEqual([
      `/media/${TRIP_B}/a.jpg`,
      `/media/${TRIP_B}/b.jpg`,
      `/media/${TRIP_B}/c.jpg`,
    ]);
  });

  it("routes by trip id — no slug form anywhere", async () => {
    stubFetch(() => okFeed());
    mount();
    await flush();

    const found = hrefs();
    expect(found).toContain(`/t/${TRIP_B}/day/2`);
    expect(found).toContain(`/t/${TRIP_A}`);
    expect(found).toContain(`/t/${TRIP_B}`);
    // The server's own hrefs are used verbatim: anything slug-shaped would be
    // a regression the page must not paper over.
    expect(found.some((h) => /slug|burning-man|canada-2027/.test(h))).toBe(false);
  });

  it("marks your own writes and leaves a followed trip's rows alone", async () => {
    stubFetch(() => okFeed());
    mount();
    await flush();

    const rows = Array.from(container.querySelectorAll("li"));
    const mine = rows.filter((r) => r.textContent?.includes("Updated title, cover photo"));
    const theirs = rows.filter((r) => r.textContent?.includes("4 photos added"));
    expect(mine.some((r) => r.textContent?.includes("You"))).toBe(true);
    expect(theirs.some((r) => r.textContent?.includes("You"))).toBe(false);
  });

  it("tells an empty feed what to do about it", async () => {
    stubFetch(() => okFeed({ items: [] }));
    mount();
    await flush();

    expect(container.textContent).toContain("Follow people to see their public trips");
  });

  it("pages older rows through ?before= and appends them", async () => {
    const older = {
      generatedAt: "2026-09-14T12:00:00Z",
      nextBefore: null,
      items: [itemRow({ at: "2026-09-01T10:00:00Z", label: "1 photo added", href: `/t/${TRIP_B}/day/1` })],
    };
    const sent = stubFetch((url) => (url.includes("before=") ? { ok: true, status: 200, body: older } : okFeed({ nextBefore: "2026-09-10T00:00:00Z" })));
    mount();
    await flush();

    const more = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Load older"),
    );
    expect(more).toBeTruthy();
    await click(more!);

    expect(sent[1].url).toBe(`/api/feed?before=${encodeURIComponent("2026-09-10T00:00:00Z")}`);
    expect(container.textContent).toContain("1 photo added");
    // The first page survives the append.
    expect(container.textContent).toContain("4 photos added");
  });
});

describe("FeedPage — the gates", () => {
  it("asks a signed-out visitor to sign in, and fetches nothing", async () => {
    authState.isAuthenticated = false;
    const sent = stubFetch(() => okFeed());
    mount();
    await flush();

    expect(container.textContent).toContain("The feed is private to you");
    expect(sent).toHaveLength(0);
    expect(authState.getAccessTokenSilently).not.toHaveBeenCalled();
  });

  it("distinguishes an expired session from an unreachable graph", async () => {
    stubFetch(() => ({ ok: false, status: 401, detail: "invalid token" }));
    mount();
    await flush();
    expect(container.textContent).toContain("Your session expired");
    act(() => root.unmount());
    container.remove();

    stubFetch(() => ({ ok: false, status: 503, detail: "graph down" }));
    mount();
    await flush();
    expect(container.textContent).toContain("The graph is unreachable right now");
  });

  it("refreshes on window focus, not on a timer", async () => {
    const sent = stubFetch(() => okFeed());
    mount();
    await flush();
    expect(sent).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(sent).toHaveLength(2);
  });
});
