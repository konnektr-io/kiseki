// @vitest-environment jsdom
/**
 * Account panel (#196 phase E): export your data + delete your account.
 *
 * AccountPanel mounted directly (it takes only `displayName` — no profile
 * fetch of its own), `fetch` stubbed per test (ProfilePage.test.tsx
 * pattern), the Auth0 context controlled through a hoisted mock.
 *
 * Gates under test:
 * 1. export GETs /api/me/export with the bearer token and downloads a file
 *    named kiseki-export.json (URL.createObjectURL stubbed — jsdom has none);
 * 2. a failed export shows an error and downloads nothing (no false success);
 * 3. DELETE /api/me is never sent until the typed name matches (empty and
 *    wrong keep the button disabled; Enter never submits);
 * 4. a 409 renders the blocking trips as links, keeps the panel usable, and
 *    never claims deletion;
 * 5. a successful delete renders the terminal deleted state and fires no
 *    follow-up read of the (now gone) profile;
 * 6. session expiry on either action routes to the sign-in state;
 * 7. a 503 renders a distinct unavailable state on either action;
 * 8. no email address is ever rendered, even with one in the Auth0 user.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  sub: "auth0|me-user",
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  loginWithRedirect: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
    user: authState.isAuthenticated
      ? { sub: authState.sub, name: "Me User", email: "me-private@example.com" }
      : undefined,
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: authState.loginWithRedirect,
    logout: authState.logout,
  }),
}));

const { AccountPanel } = await import("./AccountPanel");

const DISPLAY_NAME = "Me User";

interface SentCall {
  url: string;
  method: string;
  body?: string;
  auth?: string;
}

interface StubResult {
  ok: boolean;
  status: number;
  /** JSON body for ok responses (served via json() AND blob()). */
  body?: unknown;
  /** Error detail: string renders as {"detail": s}; object as {"detail": o}. */
  detail?: unknown;
}

/** Stub global fetch: records every call, answers per `handler`. */
function stubFetch(handler: (url: string, init?: { method?: string; body?: string }) => StubResult): SentCall[] {
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
        const payload = JSON.stringify(r.body ?? {});
        return {
          ok: true,
          status: r.status,
          json: async () => r.body,
          blob: async () => new Blob([payload], { type: "application/json" }),
          text: async () => payload,
        } as unknown as Response;
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

let container: HTMLDivElement;
let root: Root;

/** Anchor clicks captured (the download leg): href + download attribute. */
let anchorClicks: { href: string; download: string }[];
let realAnchorClick: HTMLAnchorElement["click"];

function mountPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <AccountPanel displayName={DISPLAY_NAME} />
      </MemoryRouter>,
    );
  });
}

/** Flush pending microtasks + effects inside act(). */
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

function buttonByText(text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
  if (!el) throw new Error(`no button with text ${JSON.stringify(text)}`);
  return el as HTMLButtonElement;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDeletePanel() {
  await click(buttonByText("Delete your account…"));
  await flush();
}

function confirmInput(): HTMLInputElement {
  const el = container.querySelector("#delete-confirm-name");
  if (!el) throw new Error("delete confirmation input not found (panel closed?)");
  return el as HTMLInputElement;
}

function confirmButton(): HTMLButtonElement {
  return buttonByText("Yes, delete my account");
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  authState.isAuthenticated = true;
  authState.isLoading = false;
  authState.getAccessTokenSilently.mockImplementation(async () => "test-token");
  // jsdom has no URL.createObjectURL — stub it and spy on the anchor click
  // (TripLayout.test.tsx mocks downloadBooklet instead; here the download
  // leg itself is under test, so the blob URL + click are asserted).
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock-url");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  anchorClicks = [];
  realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    anchorClicks.push({ href: this.href, download: this.download });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  HTMLAnchorElement.prototype.click = realAnchorClick;
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AccountPanel — export", () => {
  it("GETs /api/me/export with the bearer token and downloads kiseki-export.json", async () => {
    const sent = stubFetch((url) => {
      if (url === "/api/me/export") {
        return { ok: true, status: 200, body: { generatedAt: "2026-09-11", profile: {} } };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mountPanel();

    await click(buttonByText("Download your data"));

    const get = sent.find((c) => c.url === "/api/me/export");
    expect(get?.method).toBe("GET");
    expect(get?.auth).toBe("Bearer test-token");
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("kiseki-export.json");
    expect(anchorClicks[0].href).toBe("blob:mock-url");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    // Success IS the file — no banner claiming anything, no error either.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("a failed export shows an error and downloads nothing", async () => {
    stubFetch((url) => {
      if (url === "/api/me/export") {
        return { ok: false, status: 500, detail: "Export exploded" };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mountPanel();

    await click(buttonByText("Download your data"));

    expect(anchorClicks).toHaveLength(0);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Export exploded");
    expect(container.textContent).not.toContain("kiseki-export.json");
  });

  it("a 404 export says the profile isn't ready yet", async () => {
    stubFetch(() => ({ ok: false, status: 404, detail: "No user identity" }));
    mountPanel();

    await click(buttonByText("Download your data"));

    expect(anchorClicks).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "isn't ready yet",
    );
  });

  it("a 503 export renders the distinct unavailable state", async () => {
    stubFetch(() => ({ ok: false, status: 503, detail: "Graph not configured" }));
    mountPanel();

    await click(buttonByText("Download your data"));

    expect(anchorClicks).toHaveLength(0);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("taking a break");
    expect(alert).not.toContain("isn't ready yet");
  });
});

describe("AccountPanel — delete confirmation", () => {
  it("never sends DELETE until the typed name matches; empty or wrong keeps it disabled", async () => {
    const sent = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { deleted: { twinDeleted: true } },
    }));
    mountPanel();
    await openDeletePanel();

    // Empty: disabled, and nothing sent.
    expect(confirmButton().disabled).toBe(true);
    expect(sent.filter((c) => c.method === "DELETE")).toHaveLength(0);

    // Wrong: still disabled.
    typeInto(confirmInput(), "Someone Else");
    await flush();
    expect(confirmButton().disabled).toBe(true);

    // Enter never submits, even with a matching name typed.
    typeInto(confirmInput(), "me user");
    await flush();
    expect(confirmButton().disabled).toBe(false);
    await act(async () => {
      confirmInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(sent.filter((c) => c.method === "DELETE")).toHaveLength(0);

    // Only the explicit button sends it (with the bearer token).
    await click(confirmButton());
    const del = sent.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/api/me");
    expect(del?.auth).toBe("Bearer test-token");
  });

  it("surrounding whitespace is trimmed and case is ignored, but empty never matches", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: { deleted: {} } }));
    mountPanel();
    await openDeletePanel();

    typeInto(confirmInput(), "   ME USER   ");
    await flush();
    expect(confirmButton().disabled).toBe(false);

    typeInto(confirmInput(), "   ");
    await flush();
    expect(confirmButton().disabled).toBe(true);
  });

  it("Escape closes the panel and returns focus to the trigger", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: { deleted: {} } }));
    mountPanel();
    const trigger = buttonByText("Delete your account…");
    await click(trigger);
    expect(container.querySelector("#delete-confirm-name")).not.toBeNull();

    await act(async () => {
      confirmInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    expect(container.querySelector("#delete-confirm-name")).toBeNull();
    expect(document.activeElement?.textContent).toContain("Delete your account");
  });

  it("a 409 renders the blocking trips as links, keeps the panel usable, never claims deletion", async () => {
    const owned = [
      { dtId: "11111111-1111-4111-8111-111111111111", title: "Canada 2027", slug: "canada-2027" },
      { dtId: "22222222-2222-4222-8222-222222222222", title: "Japan 2028", slug: "japan-2028" },
    ];
    const serverMessage = "You still own 2 trip(s) (Canada 2027, Japan 2028); delete or hand them over first.";
    const sent = stubFetch((url, init) => {
      if (url === "/api/me" && init?.method === "DELETE") {
        return { ok: false, status: 409, detail: { message: serverMessage, ownedTrips: owned } };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mountPanel();
    await openDeletePanel();
    typeInto(confirmInput(), DISPLAY_NAME);
    await flush();
    await click(confirmButton());

    // The server's message, verbatim-ish, framed as NOT deleted.
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(serverMessage);
    expect(alert?.textContent).toContain("Nothing was deleted");
    // Each blocking trip links to its id-based route.
    for (const t of owned) {
      const link = container.querySelector(`a[href="/t/${t.dtId}"]`);
      expect(link?.textContent).toContain(t.title);
    }
    // Instruction for the way out.
    expect(container.textContent).toContain("hand it over");
    // Never the success state.
    expect(container.textContent).not.toContain("Your account is deleted");
    // Still usable: panel open, input kept, retry sends again.
    expect(container.querySelector("#delete-confirm-name")).not.toBeNull();
    expect(confirmButton().disabled).toBe(false);
    await click(confirmButton());
    expect(sent.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("a successful delete renders the terminal deleted state and reads nothing after", async () => {
    const sent = stubFetch((url, init) => {
      if (url === "/api/me" && init?.method === "DELETE") {
        return {
          ok: true,
          status: 200,
          body: { deleted: { crewEntriesReverted: 2, followsRemoved: 1, twinDeleted: true } },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    mountPanel();
    await openDeletePanel();
    typeInto(confirmInput(), DISPLAY_NAME);
    await flush();
    await click(confirmButton());

    expect(container.textContent).toContain("Your account is deleted");
    // The login survives — say so, and offer the way out of the live session.
    expect(container.textContent).toContain("fresh, empty profile");
    expect(buttonByText("Sign out")).not.toBeNull();
    // The confirmation UI is gone, not lingering under the success.
    expect(container.querySelector("#delete-confirm-name")).toBeNull();
    // Exactly one write, zero follow-up reads of the deleted profile.
    expect(sent).toHaveLength(1);

    await click(buttonByText("Sign out"));
    expect(authState.logout).toHaveBeenCalled();
  });

  it("a 404 delete is the honest already-gone state, not a panic", async () => {
    stubFetch(() => ({ ok: false, status: 404, detail: "No user identity to erase" }));
    mountPanel();
    await openDeletePanel();
    typeInto(confirmInput(), DISPLAY_NAME);
    await flush();
    await click(confirmButton());

    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("already gone");
    expect(container.textContent).not.toContain("Your account is deleted");
  });

  it("a 503 delete renders the distinct unavailable state", async () => {
    stubFetch(() => ({ ok: false, status: 503, detail: "Graph not configured" }));
    mountPanel();
    await openDeletePanel();
    typeInto(confirmInput(), DISPLAY_NAME);
    await flush();
    await click(confirmButton());

    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("taking a break");
    expect(alert).toContain("nothing was deleted");
    expect(alert).not.toContain("already gone");
    expect(container.textContent).not.toContain("Your account is deleted");
  });
});

describe("AccountPanel — session + privacy", () => {
  it("session expiry on export routes to sign-in", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: {} }));
    authState.getAccessTokenSilently.mockRejectedValueOnce({ error: "login_required" });
    mountPanel();

    await click(buttonByText("Download your data"));

    expect(authState.loginWithRedirect).toHaveBeenCalled();
    expect(anchorClicks).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("session expired");
  });

  it("session expiry on delete routes to sign-in", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: {} }));
    authState.getAccessTokenSilently.mockRejectedValueOnce({ error: "missing_refresh_token" });
    mountPanel();
    await openDeletePanel();
    typeInto(confirmInput(), DISPLAY_NAME);
    await flush();
    await click(confirmButton());

    expect(authState.loginWithRedirect).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Your account is deleted");
  });

  it("never renders an email address", async () => {
    // The Auth0 user in the mock carries me-private@example.com, and the
    // export failure below carries a server message with no address — the
    // panel must surface neither.
    stubFetch(() => ({ ok: false, status: 500, detail: "Export exploded" }));
    mountPanel();
    await click(buttonByText("Download your data"));
    await openDeletePanel();

    expect(container.textContent).not.toContain("me-private@example.com");
    expect(container.textContent).not.toContain("@example.com");
  });
});
