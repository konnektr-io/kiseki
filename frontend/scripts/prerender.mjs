/**
 * Inject the prerendered landing into a second shell: `dist/landing.html` (E4, #249).
 *
 * Run after both builds (`vite build` for the app, `vite build --ssr` for the
 * entry). It reads the built `dist/index.html` — not the source one, so the shell
 * keeps Vite's hashed asset tags — and writes a copy with the landing's markup
 * inside `#root`.
 *
 * `dist/landing.html` and `dist/index.html` are served to DIFFERENT routes by the
 * backend: `/` gets the prerendered shell, every other SPA route gets the plain
 * one. If the shell were shared, a deep link into a trip would paint the marketing
 * copy first.
 *
 * Every check here FAILS THE BUILD rather than warning: a silent miss ships a
 * front door that is byte-identical to the old one while everyone believes the
 * crawler fix landed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const ssrEntry = resolve(root, "dist-ssr/prerender.js");
const shellPath = resolve(dist, "index.html");
const outPath = resolve(dist, "landing.html");

function fail(message) {
  console.error(`[prerender] ${message}`);
  process.exit(1);
}

if (!existsSync(shellPath)) fail(`no built shell at ${shellPath} — run vite build first`);
if (!existsSync(ssrEntry)) fail(`no SSR entry at ${ssrEntry} — run vite build --ssr first`);

const { renderLandingHtml, PRERENDER_MARKER } = await import(ssrEntry);
const body = renderLandingHtml();

// The copy that must exist without JavaScript. The marker comes FROM the page's own
// copy module (via the SSR entry), not from a literal here: a duplicated string only
// proves the two literals agree, and it fails the build on every headline rewrite.
if (!body.includes(PRERENDER_MARKER)) {
  fail(`the prerendered body has no headline (${PRERENDER_MARKER}) — the page did not render`);
}
// Data must NOT be in the artifact: this repo is public (AGENTS.md) and the
// prerender runs without a graph.
for (const forbidden of ['href="/t/', "/media/", "api/showcase"]) {
  if (body.includes(forbidden)) fail(`the prerendered body contains ${forbidden}`);
}
// Auth is browser-only; a prerendered account chip would be a lie to a no-JS visitor.
if (body.includes("Sign in")) fail("the prerendered body rendered an auth control");

const shell = readFileSync(shellPath, "utf8");
const anchor = '<div id="root"></div>';
if (!shell.includes(anchor)) {
  fail(`built shell has no ${anchor} to inject into — did index.html change?`);
}
const out = shell.replace(anchor, `<div id="root">${body}</div>`);
writeFileSync(outPath, out);

console.log(
  `[prerender] ${outPath} — ${body.length} bytes of landing markup inside the shell`,
);
