// @vitest-environment jsdom
/**
 * Drag-and-drop onto the chat composer (issue #291).
 *
 * The panel is mounted for real (jsdom + `createRoot`, the AccountPanel.test
 * pattern) with the Auth0 + `useTripChat` seams stubbed and `fetch` recording
 * every call — so the drop goes through the REAL `uploadChatFile` and the real
 * `attach()`, which is the point: drop must be the picker's equal, not a
 * second path with its own behaviour.
 *
 * Contracts pinned here:
 * 1. a file drag over the panel shows a zone stating what it takes, from the
 *    same accept list the picker carries (no second vocabulary to drift);
 * 2. the zone survives the drag crossing the panel's own children (enters and
 *    leaves are per-element) and hides when the drag truly leaves;
 * 3. a drag of something other than files (selected text, a link) is left
 *    alone — no zone, nothing swallowed;
 * 4. a drop of N files is N uploads to the SAME endpoint, with the trip id,
 *    and the browser's default action (navigate to the dropped file) is
 *    prevented;
 * 5. per-file outcomes stay per-file: one rejected file does not lose the
 *    rest of the batch, and the rejection names the file;
 * 6. while a turn runs the drop is inert (picker parity) but still swallowed;
 * 7. the picker is untouched — present, multi-select, same accept list.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  getAccessTokenSilently: vi.fn(async () => "test-token"),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: vi.fn(async () => undefined),
  }),
}));

/* Analytics is not what is under test, and the real capture would fire on
 * every successful upload. */
vi.mock("../lib/posthog", () => ({
  isPostHogConfigured: false,
  posthog: { capture: () => {} },
}));

/* The panel reads messages/status/error/recovery from `useTripChat`; every
 * other helper in `lib/chat` stays real, `uploadChatFile` included. */
const chatState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat")>();
  return { ...actual, useTripChat: () => chatState.current };
});

const { ChatPanel } = await import("./chat-panel");
const { CHAT_FILE_ACCEPT, acceptSummary } = await import("../lib/chat-drop");

interface SentUpload {
  url: string;
  method: string;
  name: string;
  tripId: string | null;
}

/** Stub global fetch for `/api/files`: records the multipart body's file name
 *  and `trip_id`, and answers per `handler(filename)`. */
function stubUploads(
  handler: (name: string) => { ok: boolean; status: number; detail?: string; contentType?: string },
): SentUpload[] {
  const sent: SentUpload[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
      if (url !== "/api/files") throw new Error(`unexpected fetch ${url}`);
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const tripId = form.get("trip_id");
      sent.push({
        url,
        method: init?.method ?? "GET",
        name: file.name,
        tripId: typeof tripId === "string" ? tripId : null,
      });
      const r = handler(file.name);
      if (r.ok) {
        const body = {
          url: `/media/t1/${file.name}`,
          name: file.name,
          contentType: r.contentType ?? "image/jpeg",
          converted: false,
        };
        return { ok: true, status: r.status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
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

/** Every upload succeeds as a photo. */
function uploadsSucceed(): SentUpload[] {
  return stubUploads(() => ({ ok: true, status: 200 }));
}

let container: HTMLDivElement;
let root: Root;

function mount(overrides: Record<string, unknown> = {}) {
  chatState.current = {
    messages: [],
    status: "ready",
    error: undefined,
    recovery: "idle",
    resumable: true,
    sendMessage: async () => {},
    stop: async () => {},
    regenerate: async () => {},
    resumeTurn: async () => false,
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ChatPanel tripId="t-1" className="h-[400px]" />,
    );
  });
}

/** The panel's own root element — the drop target. */
function panel(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function dropZone(): HTMLElement | null {
  return container.querySelector('[data-testid="chat-drop-zone"]');
}

function picker(): HTMLInputElement {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error("file picker is gone");
  return el as HTMLInputElement;
}

/** Flush effects + the upload promises inside act(). */
async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A drag event carrying `files`. jsdom has no DataTransfer constructor, so
 *  the payload is attached to a plain Event — which is exactly how React
 *  reads it (`nativeEvent.dataTransfer`). */
function dragEvent(
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: File[] = [],
  types: string[] = ["Files"],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types,
      files,
      dropEffect: "none",
      effectAllowed: "all",
      setData: () => {},
      getData: () => "",
      clearData: () => {},
    },
  });
  return event;
}

async function fire(target: Element, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
}

function file(name: string, type = "image/jpeg"): File {
  return new File(["x"], name, { type });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the drop zone (#291)", () => {
  it("appears for a file drag and states what it takes, from the picker's list", async () => {
    uploadsSucceed();
    mount();

    expect(dropZone()).toBeNull();
    await fire(panel(), dragEvent("dragenter"));

    const zone = dropZone();
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toContain("Drop to attach");
    expect(zone?.textContent).toContain(acceptSummary());
    // The copy is derived from the accept list, so it can only ever state what
    // the picker takes — `.fit` (#290) would show up here by itself.
    expect(zone?.textContent).toContain("the same upload as the picker");
  });

  it("survives the drag crossing the panel's own children, and hides on leaving", async () => {
    uploadsSucceed();
    mount();
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("no composer");

    await fire(panel(), dragEvent("dragenter"));
    await fire(textarea, dragEvent("dragenter"));
    await fire(textarea, dragEvent("dragleave"));
    // Still inside the panel: the chip/textarea hop must not blink the zone.
    expect(dropZone()).not.toBeNull();

    await fire(panel(), dragEvent("dragleave"));
    expect(dropZone()).toBeNull();

    // And a drag that re-enters works again (the counter reaches zero, so the
    // next enter is not swallowed by a stale depth).
    await fire(panel(), dragEvent("dragenter"));
    expect(dropZone()).not.toBeNull();
  });

  it("ignores a drag that carries no files — selected text is the draft's business", async () => {
    uploadsSucceed();
    mount();

    const event = dragEvent("dragenter", [], ["text/plain"]);
    await fire(panel(), event);
    expect(dropZone()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("dropping a batch (#291)", () => {
  it("uploads every file through the same endpoint as the picker, and never lets the browser navigate", async () => {
    const sent = uploadsSucceed();
    mount();

    const files = [file("a1.gpx"), file("a2.gpx"), file("a3.jpg")];
    const over = dragEvent("dragover", files);
    await fire(panel(), over);
    // preventDefault on dragover is what allows the drop AND stops the browser
    // from opening the file in place of the app.
    expect(over.defaultPrevented).toBe(true);

    const drop = dragEvent("drop", files);
    await fire(panel(), drop);
    expect(drop.defaultPrevented).toBe(true);

    // One call per file, to the existing multipart route, scoped to the trip.
    expect(sent).toHaveLength(3);
    expect(sent.map((c) => c.name)).toEqual(["a1.gpx", "a2.gpx", "a3.jpg"]);
    expect(sent.every((c) => c.url === "/api/files" && c.method === "POST")).toBe(true);
    expect(sent.every((c) => c.tripId === "t-1")).toBe(true);

    // All three are attachable — the batch is in the composer, not just logged.
    const summary = container.querySelector('[data-testid="attachment-summary"]')?.textContent;
    expect(summary).toBe("3 photos attached");
    expect(container.textContent).toContain("a1.gpx");
    expect(container.textContent).toContain("a3.jpg");

    // The zone is gone with the drop.
    expect(dropZone()).toBeNull();
  });

  it("keeps a rejected file per-file: the rest of the batch still lands", async () => {
    const sent = stubUploads((name) =>
      name === "bad.gpx"
        ? { ok: false, status: 422, detail: "this build has no GPX decoder" }
        : { ok: true, status: 200 },
    );
    mount();

    await fire(panel(), dragEvent("drop", [file("a1.gpx"), file("bad.gpx"), file("c3.jpg")]));

    expect(sent).toHaveLength(3);
    expect(container.textContent).toContain("2 of 3 attached");
    // The failed row names the file and the server's reason, and the two good
    // ones are still there — a batch is never all-or-nothing.
    expect(container.textContent).toContain("bad.gpx");
    expect(container.textContent).toContain("this build has no GPX decoder");
    expect(container.textContent).toContain("a1.gpx");
    expect(container.textContent).toContain("c3.jpg");
  });

  it("is inert while a turn runs, but still swallows the default", async () => {
    const sent = uploadsSucceed();
    mount({ status: "streaming" });

    await fire(panel(), dragEvent("dragenter"));
    expect(dropZone()).toBeNull();

    const drop = dragEvent("drop", [file("a1.gpx")]);
    await fire(panel(), drop);

    // Picker parity: its button is disabled during a turn, so the drop attaches
    // nothing either — and no navigation happens while the answer streams.
    expect(drop.defaultPrevented).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("the picker is still the primary path (#291)", () => {
  it("keeps a multi-select picker carrying the shared accept list", async () => {
    uploadsSucceed();
    mount();

    const input = picker();
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("accept")).toBe(CHAT_FILE_ACCEPT);
    // And it still uploads what it is given (the drop did not replace it).
    const sent = uploadsSucceed();
    Object.defineProperty(input, "files", { value: [file("picked.jpg")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(sent.map((c) => c.name)).toEqual(["picked.jpg"]);
  });
});
