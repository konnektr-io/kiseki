import { describe, expect, it } from "vitest";
import {
  extractInstagramRef,
  instagramEmbedUrl,
  instagramWatchUrl,
  isInstagramUrl,
  partitionInstagramLinks,
} from "./instagram";

/* Issue #358 — an Instagram reel/post URL in a block's `links` plays inline.
 * Recognition is the security boundary (the iframe src is DERIVED from the
 * validated kind + shortcode on the /embed path, never the pasted URL), so
 * every accepted shape and every rejected near-miss is pinned here.
 */

describe("extractInstagramRef", () => {
  it("reads reel, post and tv URLs on both hosts, ignoring trailing slash + params", () => {
    expect(extractInstagramRef("https://www.instagram.com/reel/DMp9kQxT2zA/")).toEqual({
      kind: "reel",
      shortcode: "DMp9kQxT2zA",
    });
    expect(extractInstagramRef("https://instagram.com/reel/DMp9kQxT2zA")).toEqual({
      kind: "reel",
      shortcode: "DMp9kQxT2zA",
    });
    expect(extractInstagramRef("https://www.instagram.com/p/C8kLmN0pQrS/?igsh=abc123")).toEqual({
      kind: "p",
      shortcode: "C8kLmN0pQrS",
    });
    expect(extractInstagramRef("https://www.instagram.com/tv/CB7j8Kl9Mn0/")).toEqual({
      kind: "tv",
      shortcode: "CB7j8Kl9Mn0",
    });
  });

  it("accepts a pasted /embed suffix (same media)", () => {
    expect(extractInstagramRef("https://www.instagram.com/reel/DMp9kQxT2zA/embed")).toEqual({
      kind: "reel",
      shortcode: "DMp9kQxT2zA",
    });
  });

  it("rejects everything that is not an Instagram reel/post URL", () => {
    // Other video hosts must never become an embed.
    expect(extractInstagramRef("https://youtu.be/3DRV-9kUbxE")).toBeNull();
    expect(extractInstagramRef("https://www.tiktok.com/@user/video/1234567890123456789")).toBeNull();
    // Instagram non-media surfaces carry no embeddable media.
    expect(extractInstagramRef("https://www.instagram.com/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/some.traveler/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/stories/some.traveler/1234567890123456789/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/explore/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/direct/inbox/")).toBeNull();
    // Lookalike hosts are not Instagram.
    expect(extractInstagramRef("https://www.instagram.com.evil.example/reel/DMp9kQxT2zA/")).toBeNull();
    // Malformed shortcodes and non-URLs.
    expect(extractInstagramRef("https://www.instagram.com/reel/x/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/reel/")).toBeNull();
    expect(extractInstagramRef("https://www.instagram.com/p/DMp9kQxT2zA/liked_by/")).toBeNull();
    expect(extractInstagramRef("not a url")).toBeNull();
    expect(extractInstagramRef("")).toBeNull();
    expect(extractInstagramRef(null)).toBeNull();
    expect(extractInstagramRef(undefined)).toBeNull();
    // javascript: pseudo-URLs never parse as http(s).
    expect(extractInstagramRef("javascript:alert(1)")).toBeNull();
  });
});

describe("isInstagramUrl + player URLs", () => {
  it("flags playable URLs and derives embed + watch from the ref", () => {
    expect(isInstagramUrl("https://www.instagram.com/reel/DMp9kQxT2zA/")).toBe(true);
    expect(isInstagramUrl("https://www.instagram.com/some.traveler/")).toBe(false);
    const ref = { kind: "reel", shortcode: "DMp9kQxT2zA" } as const;
    expect(instagramEmbedUrl(ref)).toBe("https://www.instagram.com/reel/DMp9kQxT2zA/embed");
    expect(instagramWatchUrl(ref)).toBe("https://www.instagram.com/reel/DMp9kQxT2zA/");
    // The pasted URL never reaches the iframe — the src is derived.
    expect(instagramEmbedUrl(ref)).not.toContain("igsh");
  });
});

describe("partitionInstagramLinks", () => {
  it("splits players from pills, keeping order on both sides", () => {
    const links = [
      { label: "Trip write-up", url: "https://example.com/japow" },
      { label: "Palcoyo reel", url: "https://www.instagram.com/reel/DMp9kQxT2zA/" },
      { label: "Hut booking", url: "https://example.com/hut" },
      { label: "Market post", url: "https://www.instagram.com/p/C8kLmN0pQrS/" },
    ];
    const { instagram, rest } = partitionInstagramLinks(links);
    expect(instagram.map((e) => e.link.label)).toEqual(["Palcoyo reel", "Market post"]);
    expect(instagram[0].ref).toEqual({ kind: "reel", shortcode: "DMp9kQxT2zA" });
    expect(rest.map((l) => l.label)).toEqual(["Trip write-up", "Hut booking"]);
  });
});
