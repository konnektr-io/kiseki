import { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Loader2, Paperclip, Plus, Send, Square, X } from "lucide-react";
import type { FileUIPart, UIMessage } from "ai";
import { Button } from "./ui";
import { Markdown } from "../lib/markdown";
import {
  ChatAuthError,
  chatContextKey,
  findTripIds,
  loadThreadId,
  messageToText,
  newThreadId,
  uploadChatFile,
  useTripChat,
  type UploadedChatFile,
} from "../lib/chat";

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
  className?: string;
}

export function ChatPanel({ tripId, onTripCreated, className }: ChatPanelProps) {
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
      className={className}
    />
  );
}

type Attachment =
  | { state: "uploading"; name: string }
  | { state: "ready"; file: UploadedChatFile }
  | { state: "failed"; name: string; error: string };

function ChatThread({
  tripId,
  threadId,
  onNewChat,
  onTripCreated,
  className,
}: {
  tripId?: string;
  threadId: string;
  onNewChat: () => void;
  onTripCreated?: (tripId: string) => void;
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
  const { messages, status, error } = chat;
  const busy = status === "submitted" || status === "streaming";

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  const readyFiles = attachments.filter(
    (a): a is { state: "ready"; file: UploadedChatFile } =>
      a.state === "ready",
  );
  const uploading = attachments.some((a) => a.state === "uploading");
  const canSend =
    !busy && !uploading && (!!draft.trim() || readyFiles.length > 0);

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
    const text = [draft.trim(), ...docLinks].filter(Boolean).join("\n\n");
    setDraft("");
    setAttachments([]);
    setUploadError(null);
    await chat.sendMessage(
      images.length > 0 ? { text, files: images } : { text },
    );
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0 || !tripId) return;
    setUploadError(null);
    const picked = Array.from(files);
    setAttachments((prev) => [
      ...prev,
      ...picked.map(
        (f): Attachment => ({ state: "uploading", name: f.name }),
      ),
    ]);
    await Promise.all(
      picked.map(async (file) => {
        try {
          const uploaded = await uploadChatFile(
            file,
            tripId,
            getAccessTokenSilently,
          );
          setAttachments((prev) =>
            prev.map((a) =>
              a.state === "uploading" && a.name === file.name
                ? { state: "ready", file: uploaded }
                : a,
            ),
          );
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "Upload failed.";
          setAttachments((prev) =>
            prev.map((a) =>
              a.state === "uploading" && a.name === file.name
                ? { state: "failed", name: file.name, error: message }
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
        {status === "submitted" && (
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
        )}
      </div>

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
        <div className="flex flex-wrap gap-2 border-t border-border/60 px-4 pt-2.5">
          {attachments.map((a, i) => (
            <span
              key={`${a.state === "ready" ? a.file.name : a.name}-${i}`}
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
                        prev.filter((_, j) => j !== i),
                      )
                    }
                    className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
              {a.state === "failed" && (
                <span className="truncate text-destructive" title={a.error}>
                  {a.name} — upload failed
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {uploadError && (
        <p role="alert" className="px-4 pt-1 text-xs text-destructive">
          {uploadError}
        </p>
      )}

      <div className="flex items-end gap-2 p-3">
        {tripId && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.txt,.md"
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
          </>
        )}
        <textarea
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
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus-visible:focus-ring disabled:opacity-50"
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

function AgentBubble({ message }: { message: UIMessage }) {
  const text = messageToText(message);
  if (!text) return null;
  return (
    <div className="mr-auto max-w-[95%] rounded-2xl rounded-bl-md border border-border bg-muted/60 px-3.5 py-2 text-sm">
      <Markdown>{withInlineMediaImages(text)}</Markdown>
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
