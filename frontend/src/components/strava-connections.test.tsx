// @vitest-environment jsdom
/**
 * Settings → Connections (#449).
 *
 * The row is the only prominent Strava surface, and it exists because the
 * connect flow is SERVER-side: the browser has no PKCE, so it asks the API for
 * an authorize URL (the API also mints the state cookie) and then navigates.
 * A regression that built the URL client-side would drop the state cookie and
 * the callback would refuse the redirect.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { getAccessTokenSilently: async () => "test-token", loginWithRedirect: vi.fn() },
  fetchStravaStatus: vi.fn(),
  stravaAuthorizeUrl: vi.fn(),
  disconnectStrava: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({ useAuth0: () => h.auth }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchStravaStatus: h.fetchStravaStatus,
    stravaAuthorizeUrl: h.stravaAuthorizeUrl,
    disconnectStrava: h.disconnectStrava,
  };
});

const { StravaConnections } = await import("./strava-connections");

let container: HTMLDivElement;
let root: Root | null = null;

async function mount(search = "") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search, assign: h.assign, pathname: "/me" },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StravaConnections />);
  });
  await act(async () => {});
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  );
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.fetchStravaStatus.mockReset();
  h.stravaAuthorizeUrl.mockReset();
  h.disconnectStrava.mockReset();
  h.assign.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe("Strava connections row", () => {
  it("offers Connect when this browser is not connected", async () => {
    h.fetchStravaStatus.mockResolvedValue({
      configured: true,
      connected: false,
      athlete: null,
      scopes: "",
    });
    await mount();
    const connect = button("Connect with Strava");
    expect(connect).toBeDefined();
    expect(connect!.className).toContain("h-12"); // 48 px, per the brand rules

    h.stravaAuthorizeUrl.mockResolvedValue("https://www.strava.com/oauth/authorize?x=1");
    await act(async () => {
      connect!.click();
    });
    // The URL comes from the API (it also minted the state cookie) — the
    // browser only navigates.
    expect(h.stravaAuthorizeUrl).toHaveBeenCalledWith("test-token");
    expect(h.assign).toHaveBeenCalledWith("https://www.strava.com/oauth/authorize?x=1");
  });

  it("shows the athlete and disconnects", async () => {
    h.fetchStravaStatus.mockResolvedValue({
      configured: true,
      connected: true,
      athlete: { id: 96911081, name: "Niko Raes" },
      scopes: "read activity:read_all",
    });
    h.disconnectStrava.mockResolvedValue({ connected: false, revoked: true });
    await mount();
    expect(container.textContent).toContain("connected as Niko Raes");

    await act(async () => {
      button("Disconnect")!.click();
    });
    expect(h.disconnectStrava).toHaveBeenCalledWith("test-token");
    // …and the row re-reads, so the button flips back to Connect.
    expect(h.fetchStravaStatus).toHaveBeenCalledTimes(2);
  });

  it("warns when the consent excluded 'Only You' activities", async () => {
    h.fetchStravaStatus.mockResolvedValue({
      configured: true,
      connected: true,
      athlete: { id: 1, name: "Niko" },
      scopes: "read",
    });
    await mount();
    expect(container.textContent).toContain("Only You");
  });

  it("renders nothing on a deployment without a Strava app", async () => {
    h.fetchStravaStatus.mockResolvedValue({
      configured: false,
      connected: false,
      athlete: null,
      scopes: "",
    });
    await mount();
    expect(container.textContent).toBe("");
  });

  it("says so when Strava access was declined", async () => {
    h.fetchStravaStatus.mockResolvedValue({
      configured: true,
      connected: false,
      athlete: null,
      scopes: "",
    });
    await mount("?strava=denied");
    expect(container.textContent).toContain("not granted");
  });
});
