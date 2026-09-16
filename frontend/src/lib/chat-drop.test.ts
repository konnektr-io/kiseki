import { describe, expect, it } from "vitest";
import {
  CHAT_FILE_ACCEPT,
  acceptKinds,
  acceptSummary,
  dropCarriesFiles,
} from "./chat-drop";

/* Issue #291 — the accept list is ONE source of truth, and a drag is only the
 * composer's business when it carries files. Both are pure, so they are pinned
 * here rather than through the panel's render.
 */

describe("CHAT_FILE_ACCEPT", () => {
  it("keeps the families the server's per-file caps are built on", () => {
    // Every family an upload may be: images (with the HEIC pair the phone
    // sends by extension), videos, documents, text, GPX tracks.
    for (const token of [
      "image/*",
      ".heic",
      ".heif",
      "video/*",
      ".mp4",
      ".mov",
      ".m4v",
      ".webm",
      ".pdf",
      ".doc",
      ".docx",
      ".txt",
      ".md",
      ".gpx",
    ]) {
      expect(CHAT_FILE_ACCEPT.split(",")).toContain(token);
    }
    // No stray spaces: the value goes into an `accept` attribute verbatim.
    expect(CHAT_FILE_ACCEPT).not.toMatch(/\s/);
  });
});

describe("acceptKinds / acceptSummary", () => {
  it("names the families of the real list, extensions folded into them", () => {
    expect(acceptKinds()).toEqual([
      "photos",
      "videos",
      "documents",
      "text notes",
      "GPX tracks",
    ]);
    expect(acceptSummary()).toBe(
      "photos, videos, documents, text notes and GPX tracks",
    );
  });

  it("joins two kinds with `and`, not a comma", () => {
    expect(acceptSummary("image/*,video/*")).toBe("photos and videos");
    expect(acceptSummary("image/*")).toBe("photos");
  });

  it("derives from the list it is given — .fit joins the copy by itself", () => {
    // #290 adds FIT parsing; the drop zone's vocabulary follows the accept
    // list with no second string to update. An unknown token is stated
    // verbatim rather than dropped.
    expect(acceptSummary(`${CHAT_FILE_ACCEPT},.fit`)).toBe(
      "photos, videos, documents, text notes, GPX tracks and .fit",
    );
    expect(acceptSummary("image/*,.gpx,.fit")).toBe(
      "photos, GPX tracks and .fit",
    );
  });

  it("dedupes repeated tokens and ignores blanks", () => {
    expect(acceptSummary(".gpx,.gpx, ,.md")).toBe("GPX tracks and text notes");
    expect(acceptSummary("")).toBe("files");
  });
});

describe("dropCarriesFiles", () => {
  it("is true for a desktop file drag", () => {
    expect(dropCarriesFiles(["Files"])).toBe(true);
    // Firefox prefixes the list; `Files` is still in it.
    expect(dropCarriesFiles(["application/x-moz-file", "Files"])).toBe(true);
  });

  it("is false for the other drags the panel sees", () => {
    // Selected text dragged inside the draft, a map marker, a URL from
    // another tab: none of them may light up the attach zone.
    expect(dropCarriesFiles(["text/plain"])).toBe(false);
    expect(dropCarriesFiles([])).toBe(false);
    expect(dropCarriesFiles(null)).toBe(false);
    expect(dropCarriesFiles(undefined)).toBe(false);
  });

  it("reads a DOMStringList (the older DataTransfer.types shape) too", () => {
    const stringList = Object.assign(Object.create(null), {
      0: "Files",
      length: 1,
      contains: () => true,
    }) as unknown as ArrayLike<string>;
    expect(dropCarriesFiles(stringList)).toBe(true);
  });
});
