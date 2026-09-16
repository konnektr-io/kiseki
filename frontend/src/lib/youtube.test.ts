import { describe, expect, it } from "vitest";
import {
  extractYouTubeId,
  isYouTubeUrl,
  partitionYouTubeLinks,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from "./youtube";

/* Issue #283 — a YouTube URL in a block's `links` plays inline. Recognition
 * is the security boundary (the iframe src is DERIVED from the validated id
 * on the nocookie host, never the pasted URL), so every accepted shape and
 * every rejected near-miss is pinned here.
 */

describe("extractYouTubeId", () => {
  it("reads the standard watch URL with extra params", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
    expect(extractYouTubeId("https://www.youtube.com/watch?v=3DRV-9kUbxE&t=42s&list=PLx")).toBe(
      "3DRV-9kUbxE",
    );
  });

  it("reads youtu.be shares, embed, shorts, live and nocookie forms", () => {
    expect(extractYouTubeId("https://youtu.be/3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
    expect(extractYouTubeId("https://youtu.be/e1ELqQ_WbD0?t=10")).toBe("e1ELqQ_WbD0");
    expect(extractYouTubeId("https://www.youtube.com/embed/3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
    expect(extractYouTubeId("https://www.youtube.com/shorts/3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
    expect(extractYouTubeId("https://www.youtube.com/live/3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
    expect(extractYouTubeId("https://www.youtube-nocookie.com/embed/3DRV-9kUbxE")).toBe(
      "3DRV-9kUbxE",
    );
    expect(extractYouTubeId("https://m.youtube.com/watch?v=3DRV-9kUbxE")).toBe("3DRV-9kUbxE");
  });

  it("rejects everything that is not a YouTube video URL", () => {
    // Other video hosts must never become an embed.
    expect(extractYouTubeId("https://vimeo.com/123456789")).toBeNull();
    expect(extractYouTubeId("https://www.strava.com/activities/17044240934")).toBeNull();
    // YouTube non-video pages carry no id.
    expect(extractYouTubeId("https://www.youtube.com/")).toBeNull();
    expect(extractYouTubeId("https://www.youtube.com/@somechannel")).toBeNull();
    expect(extractYouTubeId("https://www.youtube.com/playlist?list=PLx")).toBeNull();
    // music.youtube.com is a different app surface — not recognised.
    expect(extractYouTubeId("https://music.youtube.com/watch?v=3DRV-9kUbxE")).toBeNull();
    // Malformed ids and non-URLs.
    expect(extractYouTubeId("https://www.youtube.com/watch?v=too-short")).toBeNull();
    expect(extractYouTubeId("https://www.youtube.com/watch")).toBeNull();
    expect(extractYouTubeId("not a url")).toBeNull();
    expect(extractYouTubeId("")).toBeNull();
    expect(extractYouTubeId(null)).toBeNull();
    expect(extractYouTubeId(undefined)).toBeNull();
    // javascript: pseudo-URLs never parse as http(s).
    expect(extractYouTubeId("javascript:alert(1)")).toBeNull();
  });
});

describe("player URLs", () => {
  it("derives the embed from the id on the nocookie host", () => {
    expect(youtubeEmbedUrl("3DRV-9kUbxE")).toBe(
      "https://www.youtube-nocookie.com/embed/3DRV-9kUbxE",
    );
    expect(youtubeEmbedUrl("3DRV-9kUbxE", true)).toContain("autoplay=1");
  });

  it("derives watch + thumbnail from the id", () => {
    expect(youtubeWatchUrl("3DRV-9kUbxE")).toBe("https://www.youtube.com/watch?v=3DRV-9kUbxE");
    expect(youtubeThumbnailUrl("3DRV-9kUbxE")).toBe("https://i.ytimg.com/vi/3DRV-9kUbxE/hqdefault.jpg");
  });
});

describe("partitionYouTubeLinks", () => {
  it("splits players from pills, keeping order on both sides", () => {
    const links = [
      { label: "Trip write-up", url: "https://example.com/japow" },
      { label: "Rusutsu powder", url: "https://youtu.be/3DRV-9kUbxE" },
      { label: "Hut booking", url: "https://example.com/hut" },
      { label: "Niseko edit", url: "https://www.youtube.com/watch?v=e1ELqQ_WbD0" },
    ];
    const { youtube, rest } = partitionYouTubeLinks(links);
    expect(youtube.map((e) => e.id)).toEqual(["3DRV-9kUbxE", "e1ELqQ_WbD0"]);
    expect(rest.map((l) => l.label)).toEqual(["Trip write-up", "Hut booking"]);
  });

  it("is empty-safe", () => {
    expect(partitionYouTubeLinks([])).toEqual({ youtube: [], rest: [] });
    expect(partitionYouTubeLinks(null)).toEqual({ youtube: [], rest: [] });
    expect(partitionYouTubeLinks(undefined)).toEqual({ youtube: [], rest: [] });
  });

  it("isYouTubeUrl mirrors the extractor", () => {
    expect(isYouTubeUrl("https://youtu.be/3DRV-9kUbxE")).toBe(true);
    expect(isYouTubeUrl("https://example.com/x")).toBe(false);
  });
});
