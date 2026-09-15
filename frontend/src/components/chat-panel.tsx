import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Loader2, Paperclip, Plus, Send, Square, X } from "lucide-react";
import type { FileUIPart, UIMessage } from "ai";
import { Button } from "./ui";
import { Markdown } from "../lib/markdown";
import { isPostHogConfigured, posthog } from "../lib/posthog";
import {
  ChatAuthError,
  chatContextKey,
  findTripIds,
  loadThreadId,
  messageActivities,
  messageInterrupted,
  messageToText,
  newThreadId,
  uploadChatFile,
  useTripChat,
  type TurnRecovery,
  type UploadedChatFile,
} from "../lib/chat";

/**
 * Whether the transcript should offer Reconnect — the last assistant message
 * is a turn the relay CUT, and nothing is picking it up.
 *
 * Every exclusion matters: a turn that is being attached to is already being
 * continued (`checking`), one that WAS attached to has been rebuilt and needs
 * no affordance, and a cut transcript with no re-attach in flight is exactly
 * the case the button exists for. Kept as a predicate so the rule is readable
 * and testable on its own, apart from rendering (issue #217).
 *
 * An `error` on an assistant tail is the SAME case, not a reason to hide the
 * button (#237): the relay's cut `finish` only exists when the UPSTREAM stream
 * ends early, and a phone whose socket dies with the screen never receives a
 * terminal chunk at all. Gating on `interrupted` therefore left the one
 * scenario the affordance was built for — screen off, "network error", no way
 * back — with nothing to press.
 */
export function shouldOfferReconnect(args: {
  working: boolean;
  error: Error | undefined;
  recovery: TurnRecovery;
  lastMessage: UIMessage | null;
}): boolean {
  // A turn that is still arriving is the attach path's business (see
  // `attachLostTurn`), not the button's.
  if (args.working) return false;
  if (args.recovery === "checking" || args.recovery === "attached") return false;
  const last = args.lastMessage;
  if (last === null || last.role !== "assistant") return false;
  return messageInterrupted(last) || args.error !== undefined;
}

/**
 * Chat panel (issue #9 / M4) — Chrome surface (`no-print`): the conversation
 * with the Kiseki trip-content agent. User bubbles right, agent left,
 * streamed markdown with inline trip images, an anchored-only attach button
 * (paperclip — only when `tripId` is set), and a composer (Enter sends,
 * Shift+Enter keeps the newline).
 *
 * Mounts: the landing "Kiseki assistant" section (general chat, no tripId)
 * and the in-trip chat drawer (tripId bound). Both are guarded by
 * `isAuthenticated` — there is no anonymous chat.
 */

/** Bare `/media/…` URLs the agent emits as plain text become inline images.
 *  Already-linked ones (`![alt](/media/…)`) are left alone. */
const BARE_MEDIA_RE = /(?<!\]\()(\/media\/[A-Za-z0-9/_.~%-]+)/g;

export function withInlineMediaImages(text: string): string {
  return text.replace(BARE_MEDIA_RE, "![attached image]($1)");
}

interface ChatPanelProps {
  tripId?: string;
  onTripCreated?: (tripId: string) => void;
  /** Fired once after each COMPLETED agent turn — the caller refetches the
   *  trip so the surfaces behind the drawer show what the agent just wrote. */
  onTurnComplete?: () => void;
  onClose?: () => void;
  className?: string;
}

export function ChatPanel({
  tripId,
  onTripCreated,
  onTurnComplete,
  onClose,
  className,
}: ChatPanelProps) {
  const {
    isAuthenticated,
    isLoading: authLoading,
    loginWithRedirect,
  } = useAuth0();
  const context = chatContextKey(tripId);
  // Initialized synchronously (not in an effect) so the thread also resolves
  // in SSR/prerender, where effects never run. Rotating creates a new thread
  // AND remounts the thread below (key), so chat state restarts cleanly.
  const [threadId, setThreadId] = useState(
    () => loadThreadId(context) ?? newThreadId(context),
  );

  if (authLoading) {
    return (
      <div className={className} role="status">
        <p className="animate-pulse p-4 text-sm text-muted-foreground">
          Loading chat…
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className={className}>
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Sign in to chat with the Kiseki assistant.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => loginWithRedirect()}
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ChatThread
      key={threadId}
      tripId={tripId}
      threadId={threadId}
      onNewChat={() => setThreadId(newThreadId(context))}
      onTripCreated={onTripCreated}
      onTurnComplete={onTurnComplete}
      onClose={onClose}
      className={className}
    />
  );
}

type Attachment =
  | { id: string; state: "uploading"; name: string }
  | { id: string; state: "ready"; file: UploadedChatFile }
  | { id: string; state: "failed"; name: string; error: string };

/** Monotonic id per attachment (#251) — React keys AND upload reconciliation.
 *  Never derived from the filename: two photos called `IMG_0001.jpg` are two
 *  attachments, and matching them by name made the second upload's result
 *  overwrite the first, leaving a chip stuck in `uploading` and the file out
 *  of the message. */
let attachmentSeq = 0;
function newAttachmentId(): string {
  attachmentSeq += 1;
  return `attachment-${attachmentSeq}`;
}

/** The visible accounting of what the composer holds (#251): what is ready,
 *  what was transcoded on the way in, and what failed — never a silent loss.
 *  Exported for the render tests. */
export function summarizeAttachments(attachments: Attachment[]): string {
  const ready = attachments.filter(
    (a): a is { id: string; state: "ready"; file: UploadedChatFile } =>
      a.state === "ready",
  );
  const failed = attachments.filter(
    (a): a is { id: string; state: "failed"; name: string; error: string } =>
      a.state === "failed",
  );
  const uploading = attachments.length - ready.length - failed.length;
  const photos = ready.filter((a) => a.file.isImage).length;
  const documents = ready.length - photos;
  const kinds = [
    photos > 0 ? `${photos} ${photos === 1 ? "photo" : "photos"}` : "",
    documents > 0
      ? `${documents} ${documents === 1 ? "document" : "documents"}`
      : "",
  ].filter(Boolean);

  const parts: string[] = [];
  if (ready.length > 0) {
    // With failures the denominator matters ("I picked 20"): say how many of
    // the picked files actually attached. Otherwise the kind breakdown.
    parts.push(
      failed.length > 0
        ? `${ready.length} of ${attachments.length} attached`
        : `${kinds.join(" · ")} attached`,
    );
  }
  const converted = ready.filter((a) => a.file.converted).length;
  if (converted > 0) parts.push(`${converted} converted`);
  if (failed.length > 0) {
    // The reason is what makes the failure actionable (a HEIC the server
    // refused, a size cap, …) — the chip carries the full text.
    parts.push(`${failed.length} failed: ${briefUploadError(failed[0].error)}`);
  }
  if (uploading > 0) parts.push(`${uploading} uploading…`);
  return parts.join(" · ");
}

/** Server error text without the transport wrapper — `Upload failed (422): x`
 *  reads as noise in a one-line summary. */
function briefUploadError(message: string): string {
  return message.replace(/^Upload failed \(\d+\):\s*/, "").trim();
}

function ChatThread({
  tripId,
  threadId,
  onNewChat,
  onTripCreated,
  onTurnComplete,
  onClose,
  className,
}: {
  tripId?: string;
  threadId: string;
  onNewChat: () => void;
  onTripCreated?: (tripId: string) => void;
  onTurnComplete?: () => void;
  onClose?: () => void;
  className?: string;
}) {
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const chat = useTripChat({
    tripId,
    threadId,
    getToken: getAccessTokenSilently,
    onFinish: (text) => {
      const ids = findTripIds(text);
      if (ids.length > 0 && onTripCreated) {
        onTripCreated(ids[ids.length - 1]);
      }
    },
  });
  const { messages, status, error, recovery } = chat;
  const busy = status === "submitted" || status === "streaming";
  // Re-attaching a turn this thread was left in the middle of (#217) is live
  // work from the user's point of view, even though the SDK hasn't started
  // streaming yet: the thinking row shows for the probe too, and the composer
  // stays shut — a message sent in that window would start a SECOND turn and
  // leave the real one running with nothing rendering it.
  const working = busy || recovery === "checking";
  // The agent edits the trip server-side, while the trip page keeps the
  // document it read at load (api.ts memoizes it for the session) and the
  // activity row unmounts at settle — so a turn's own result is otherwise
  // invisible until a manual reload. Fire once per COMPLETED turn so the
  // caller can refetch the trip (issue #179 follow-up: "you don't see the
  // result in the UI"). Errors do not fire it: a failed turn changed nothing.
  //
  // Two things count as a turn having done work, because a turn can settle in
  // two ways: the `busy` window (a turn this client watched), or an attach
  // (#217) — a thread opening onto a turn that ran while the client was away.
  // The replayed frames land in one burst there, so that window is not
  // guaranteed to render; the attach outcome is, and both latch the same
  // refetch. Without it a recovered turn would render its answer while the
  // trip page kept the stale document the agent had just edited.
  const refetchPending = useRef(false);
  useEffect(() => {
    if (busy || recovery === "attached") refetchPending.current = true;
    if (refetchPending.current && !working && !error) {
      refetchPending.current = false;
      onTurnComplete?.();
    }
  }, [busy, working, recovery, error, onTurnComplete]);
  // A dropped turn (issue #152): the relay closed the stream without the
  // agent's terminal event, so it marked the finish `interrupted`. The turn
  // looks "done" but the agent never finished — offer Reconnect. Since #217
  // that ATTACHES to the turn the relay is still holding (the agent kept
  // working while the connection was gone); re-sending the transcript stays
  // the fallback for when there is nothing left to attach to.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const droppedTurn = shouldOfferReconnect({
    working,
    error,
    recovery,
    lastMessage,
  });

  const reconnect = async () => {
    if (!droppedTurn || busy) return;
    if (isPostHogConfigured) posthog.capture("chat_reconnect_requested");
    // Attach first (#217). Only when the relay no longer knows the turn —
    // it restarted, or the turn settled while we were away — fall back to
    // re-sending on the same threadId, which is what #152 did.
    const attached = await chat.resumeTurn();
    if (!attached) await chat.regenerate();
  };

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  // Grow the composer with its content (up to max-h-32): reset to auto so the
  // measured height tracks the current line count, then cap at the same bound
  // the CSS class applies. Runs whenever the draft changes.
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    // Measure with the scrollbar suppressed: a visible gutter narrows the box
    // and rounds scrollHeight up past clientHeight (~1px with leading-relaxed),
    // which made overflow-y-auto paint a permanent scrollbar even on empty
    // drafts. Restore auto only at the 128px cap, where scrolling is real.
    el.style.overflowY = "hidden";
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 128);
    el.style.height = `${next}px`;
    el.style.overflowY = next >= 128 ? "auto" : "hidden";
  }, [draft]);

  const readyFiles = attachments.filter(
    (a): a is { id: string; state: "ready"; file: UploadedChatFile } =>
      a.state === "ready",
  );
  const uploading = attachments.some((a) => a.state === "uploading");
  const canSend =
    !working && !uploading && (!!draft.trim() || readyFiles.length > 0);

  const send = async () => {
    if (!canSend) return;
    const images: FileUIPart[] = [];
    const docLinks: string[] = [];
    for (const a of readyFiles) {
      if (a.file.isImage) {
        images.push({
          type: "file",
          mediaType: a.file.mediaType,
          url: a.file.url,
          filename: a.file.name,
        });
      } else {
        docLinks.push(`[${a.file.name}](${a.file.url})`);
      }
    }
    // The count travels WITH the message (#251): the transcript then says how
    // many files a turn actually carried (8 and 10 used to look identical),
    // and the agent can state it without guessing from image parts.
    const attachmentNote =
      readyFiles.length > 0 ? summarizeAttachments(attachments) : "";
    const text = [attachmentNote, draft.trim(), ...docLinks]
      .filter(Boolean)
      .join("\n\n");
    if (isPostHogConfigured) {
      posthog.capture("chat_message_sent", {
        conversation_scope: tripId ? "trip" : "general",
        has_text: Boolean(draft.trim()),
        attachment_count: readyFiles.length,
        attachment_converted: readyFiles.filter((a) => a.file.converted).length,
        attachment_failed: attachments.filter((a) => a.state === "failed")
          .length,
      });
    }
    setDraft("");
    setAttachments([]);
    setUploadError(null);
    await chat.sendMessage(
      images.length > 0 ? { text, files: images } : { text },
    );
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    const picked = Array.from(files).map((file) => ({
      file,
      id: newAttachmentId(),
    }));
    setAttachments((prev) => [
      ...prev,
      ...picked.map(
        ({ file, id }): Attachment => ({ id, state: "uploading", name: file.name }),
      ),
    ]);
    await Promise.all(
      picked.map(async ({ file, id }) => {
        try {
          // No tripId → the file lands in the user's inbox (landing chat);
          // the agent promotes it into the trip it creates (#9 / M4).
          const uploaded = await uploadChatFile(
            file,
            tripId,
            getAccessTokenSilently,
          );
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id ? { id, state: "ready", file: uploaded } : a,
            ),
          );
          if (isPostHogConfigured) {
            posthog.capture("chat_attachment_uploaded", {
              conversation_scope: tripId ? "trip" : "general",
              attachment_type: uploaded.isImage ? "image" : "document",
              converted: uploaded.converted,
            });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : "Upload failed.";
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { id, state: "failed", name: file.name, error: message }
                : a,
            ),
          );
        }
      }),
    );
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className={`no-print flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <p className="kicker">Kiseki assistant</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewChat}
            aria-label="Start a new chat"
            className="h-9 px-2.5 text-xs"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New chat
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close chat"
              className="h-9 w-9"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && (
          <p className="mx-auto max-w-sm py-6 text-center text-sm text-muted-foreground">
            {tripId
              ? "Ask about this trip — or ask for edits and watch them land."
              : "Ask about your trips — or say “create a trip” to start a new one."}
          </p>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AgentBubble key={message.id} message={message} />
          ),
        )}
        {working && <AgentActivity messages={messages} />}
      </div>

      {droppedTurn && (
        <ChatReconnectBanner onReconnect={() => void reconnect()} />
      )}

      {error && (
        <ChatErrorBanner
          error={error}
          onRetry={() => chat.regenerate()}
          onSignIn={() =>
            loginWithRedirect({
              appState: { returnTo: window.location.pathname },
            })
          }
        />
      )}

      {attachments.length > 0 && (
        <div className="border-t border-border/60 px-4 pt-2.5">
          {/* The count, always visible while the batch is in flight and after
              it lands (#251): "8 or 10?" was unanswerable from the composer. */}
          <p
            className="text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="attachment-summary"
          >
            {summarizeAttachments(attachments)}
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
              >
                {a.state === "uploading" && (
                  <>
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{a.name}</span>
                  </>
                )}
                {a.state === "ready" && (
                  <>
                    {a.file.isImage ? (
                      <img
                        src={a.file.url}
                        alt=""
                        className="h-6 w-6 rounded object-cover"
                      />
                    ) : null}
                    <span className="truncate">{a.file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${a.file.name}`}
                      onClick={() =>
                        setAttachments((prev) =>
                          prev.filter((other) => other.id !== a.id),
                        )
                      }
                      className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                )}
                {a.state === "failed" && (
                  <span
                    className="truncate text-destructive"
                    title={a.error}
                  >
                    {a.name} — {briefUploadError(a.error)}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {uploadError && (
        <p role="alert" className="px-4 pt-1 text-xs text-destructive">
          {uploadError}
        </p>
      )}

      <div className="flex items-end gap-2 p-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.heic,.heif,.pdf,.doc,.docx,.txt,.md"
          className="sr-only"
          aria-label="Attach a file"
          onChange={(e) => void attach(e.target.files)}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Attach a file"
          title="Attach a photo or document"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="h-11 w-11 shrink-0"
        >
          <Paperclip className="h-5 w-5" aria-hidden="true" />
        </Button>
        <textarea
          ref={draftRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            tripId ? "Ask about this trip…" : "Ask, or say “create a trip”…"
          }
          aria-label="Chat message"
          rows={1}
          disabled={busy}
          className="max-h-32 min-h-[44px] flex-1 resize-none overflow-y-hidden rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus-visible:focus-ring disabled:opacity-50"
        />
        {busy ? (
          <Button
            variant="outline"
            size="icon"
            aria-label="Stop generating"
            onClick={() => void chat.stop()}
            className="h-11 w-11 shrink-0"
          >
            <Square className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label="Send message"
            onClick={() => void send()}
            disabled={!canSend}
            className="h-11 w-11 shrink-0"
          >
            <Send className="h-5 w-5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UIMessage }) {
  const text = messageToText(message);
  const files = message.parts.filter((part) => part.type === "file");
  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {files.map((part, i) =>
            part.type === "file" &&
            (part.mediaType === "image" ||
              part.mediaType.startsWith("image/")) ? (
              <img
                key={i}
                src={part.url}
                alt={part.filename ?? "Attached image"}
                loading="lazy"
                className="aspect-[4/3] w-28 rounded-lg border border-border object-cover"
              />
            ) : null,
          )}
        </div>
      )}
      {text && (
        <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The agent's own words — every text part, exactly as it streamed.
 *
 * History (issue #179/#181, reverted after live use in the app): #181 rendered
 * only text positioned AFTER the last activity part so pre-tool narration could
 * never become a bubble. In practice it (a) hid the running commentary the user
 * actually wants — "Days are in. Now the section chapters." — (b) delayed every
 * plain answer until the turn settled, so an answer could surface after the
 * user's NEXT message, and (c) blanked earlier agent messages the moment a new
 * turn started, because `busy` was passed to every bubble. The narration
 * problem was the weak model producing it, not the rendering: with a capable
 * model the narrative is the product. So the bubble shows everything, always.
 */
function AgentBubble({ message }: { message: UIMessage }) {
  const text = messageToText(message);
  // A tool-only stretch has no words of its own — the activity row below is
  // the feedback; an empty bubble would be a blank slate.
  if (!text.trim()) return null;
  return (
    <div className="mr-auto max-w-[95%] rounded-2xl rounded-bl-md border border-border bg-muted/60 px-3.5 py-2 text-sm">
      <Markdown>{withInlineMediaImages(text)}</Markdown>
    </div>
  );
}

function ChatReconnectBanner({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div
      role="alert"
      className="mx-3 mb-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-center"
    >
      <p className="text-xs text-muted-foreground">
        Connection lost — the agent didn&apos;t finish. Reconnect continues
        the same turn (nothing is sent twice).
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onReconnect}
        className="mt-2 text-xs"
      >
        Reconnect
      </Button>
    </div>
  );
}

/**
 * Live agent-activity feed (issue #151) — what the agent is doing RIGHT
 * NOW, while the turn runs. Shows ONE row: the latest `data-kiseki-activity`
 * part of the current turn (issue #175 — rows replace each other instead of
 * piling up; friendly labels from the relay, never raw tool names). The row
 * spins for the WHOLE turn and the feed unmounts when the turn ends
 * (`{working && <AgentActivity/>}` at the mount site — `working` is `busy`
 * plus the window where a thread open is re-attaching to a running turn) —
 * nothing lingers after the answer.
 *
 * Issue #181 follow-up: the row used to flip to a check as soon as the wire
 * closed that call (`done: true` when the tool result lands). In a single-row
 * feed that reads as a premature "finished" claim — the user sees a tick while
 * the turn is still working, and the next call replaces it a moment later. The
 * row is a live indicator: it spins while the turn runs; the outcome arrives as
 * the agent's own words plus the refetched trip.
 * Falls back to the plain "thinking" row when no activity arrived yet —
 * a text-only turn (or a slow first byte) still shows something alive.
 * This fallback is the ONLY thinking indicator (issue #157): it renders for
 * the whole `busy` window, so no separate `submitted` row may ever render
 * alongside it — that used to show "Agent is thinking" twice.
 */
function AgentActivity({ messages }: { messages: UIMessage[] }) {
  // The current turn is the LAST message while busy (the streaming assistant
  // message; nothing is appended after it until the turn completes). Reading
  // only it keeps a fresh turn from inheriting the previous turn's last row.
  const current = messages.length > 0 ? messages[messages.length - 1] : null;
  const rows = current ? messageActivities(current) : [];
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  if (!latest) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2
          className="h-4 w-4 animate-spin"
          aria-hidden="true"
        />
        Agent is thinking…
      </div>
    );
  }
  return (
    <div role="status" aria-label="Agent activity" className="flex flex-col gap-1.5">
      <div
        key={`${rows.length - 1}-${latest.label}`}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2
          className="h-4 w-4 animate-spin"
          aria-hidden="true"
        />
        <span>{latest.label}</span>
      </div>
    </div>
  );
}

function ChatErrorBanner({
  error,
  onRetry,
  onSignIn,
}: {
  error: Error;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  if (error instanceof ChatAuthError && error.status === 401) {
    return (
      <div
        role="alert"
        className="mx-3 mb-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-center"
      >
        <p className="text-xs font-medium text-destructive">
          Your session expired — sign in again to keep chatting.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onSignIn}
          className="mt-2 text-xs"
        >
          Sign in again
        </Button>
      </div>
    );
  }
  if (error instanceof ChatAuthError && error.status === 403) {
    return (
      <div
        role="alert"
        className="mx-3 mb-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-center"
      >
        <p className="text-xs text-muted-foreground">
          You don&apos;t have access to chat about this trip.
        </p>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="mx-3 mb-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-center"
    >
      <p className="text-xs text-muted-foreground">{error.message}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="mt-2 text-xs"
      >
        Try again
      </Button>
    </div>
  );
}

/**
 * Floating chat popup — the same drawer for the trip page and the landing
 * page (issue #9 / M4). Bottom sheet on mobile, right rail on desktop; the
 * trip (or trips grid) stays mounted underneath so agent edits land visibly.
 * The close X lives in the panel header (next to "New chat"), never as an
 * absolutely-positioned overlay — the old drawer X overlapped that button.
 */
export function ChatPopup({
  tripId,
  onClose,
  onTripCreated,
  onTurnComplete,
  label,
  banner,
}: {
  tripId?: string;
  onClose: () => void;
  onTripCreated?: (tripId: string) => void;
  onTurnComplete?: () => void;
  label: string;
  banner?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={label}
      className="no-print fixed inset-x-3 bottom-3 z-30 md:inset-x-auto md:bottom-6 md:right-6 md:top-20 md:w-[400px]"
    >
      <div className="floating relative flex max-h-[70dvh] flex-col overflow-hidden rounded-2xl md:max-h-none md:h-full">
        {banner && (
          <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-2.5">
            {banner}
          </div>
        )}
        <ChatPanel
          tripId={tripId}
          onClose={onClose}
          onTripCreated={onTripCreated}
          onTurnComplete={onTurnComplete}
          className="h-[60dvh] border-0 md:h-full"
        />
      </div>
    </div>
  );
}
