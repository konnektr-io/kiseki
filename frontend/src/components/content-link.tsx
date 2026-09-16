import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { internalAppPath } from "../lib/links";

/**
 * A content-supplied link (a feature card's `links`, a block's links, a todo's
 * links, `practical.links`) rendered as the RIGHT element for its target:
 * a router `Link` — same tab, client-side navigation — when the URL names a
 * route of this app, and the off-app contract (`target="_blank"` +
 * `rel="noreferrer"`, so a foreign page never gets a handle on this one) for
 * everything else. Which one it is comes from `internalAppPath` alone, so every
 * surface answers the same way (#301).
 *
 * `glyph` renders a leading icon sized by the caller's class. The caller picks
 * the SIZE, never the icon: the external-link glyph promises a new tab, so an
 * in-app target gets the app's own arrow instead — a glyph that lies about
 * where the click goes is worse than no glyph.
 */
export function ContentLink({
  url,
  className,
  glyph,
  title,
  children,
}: {
  url: string;
  className?: string;
  /** Size/utility classes for the leading glyph; omit for no glyph at all. */
  glyph?: string;
  title?: string;
  children: ReactNode;
}) {
  const to = internalAppPath(url);
  if (to) {
    return (
      <Link to={to} className={className} title={title}>
        {glyph ? <ArrowRight className={glyph} aria-hidden="true" /> : null}
        {children}
      </Link>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className={className} title={title}>
      {glyph ? <ExternalLink className={glyph} aria-hidden="true" /> : null}
      {children}
    </a>
  );
}
