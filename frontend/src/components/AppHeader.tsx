import type { ReactNode, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * The app's one header bar (#239).
 *
 * Every route used to re-implement its own bar — a different `max-w-*`, a
 * different back affordance and different (or no) brand chrome — so the chrome
 * jumped between routes and never spanned the viewport, and on a phone the row
 * wrapped once the feed entry point (#199) joined the profile chip. This is the
 * single source of truth for:
 *
 * - **geometry**: full width (`w-full` + inner padding), one sticky row. Only
 *   the page content keeps its own reading column (`max-w-3xl` and friends).
 * - **the Home/back affordance**: `HeaderIconLink`, one round control, the same
 *   label semantics everywhere.
 * - **the brand**: app icon + typographic wordmark, linking home, on every
 *   route — including the trip, which had no brand chrome at all.
 * - **the account/feed chips**: passed in as `actions` (see `AuthButton`).
 *
 * Mobile-safe by construction: the row is `flex-nowrap` with an explicit
 * truncation chain — the title takes the flexible slot and truncates, the
 * subtitle truncates with it, the brand and the actions never shrink — so a
 * 360–390px viewport degrades to an ellipsis instead of wrapping onto a second
 * line. Where an ellipsis is still not enough to READ the page's own title, the
 * brand leaves the bar on phones instead of the title shrinking further —
 * `hideBrandOnPhone`, which the trip sets.
 */

/**
 * Round chrome control geometry: a 44px touch target on phones (DESIGN §2.3 —
 * touch targets are ≥ 44×44) and the compact 32px control on pointer devices,
 * which is the size the chrome used before. Shared by `HeaderIconLink` and by
 * callers that put their own `<button>` in the bar (the trip's chat toggle), so
 * every round control in the chrome is the same object.
 */
export const HEADER_CONTROL =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground focus-visible:focus-ring md:h-8 md:w-8";

/** The bar's single row: full width, one line, never wrapped. */
const HEADER_ROW =
  "flex w-full flex-nowrap items-center gap-2 px-4 py-2 md:gap-3 md:py-2.5";

/** Round header control that navigates — Home, or back to the trips list. */
export function HeaderIconLink({
  to,
  label,
  icon: Icon = ArrowLeft,
}: {
  to: string;
  label: string;
  icon?: LucideIcon;
}) {
  return (
    <Link to={to} title={label} aria-label={label} className={HEADER_CONTROL}>
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Link>
  );
}

/**
 * Brand: app icon + wordmark, linking home.
 *
 * The mark is `/logo-mark-transparent.png` — genuinely transparent and pixel-
 * identical in its centre to the app icon (`/favicon-32.png`), so the chrome
 * cannot drift from the tab icon the way the old landing logo image did (see
 * LandingPage.tsx). 512px source, so it stays crisp at 24px on a 2x screen.
 * The wordmark stays typographic, in the same treatment as the landing hero.
 *
 * `compact` is set when the row also carries a title: the 軌跡 glyph then drops
 * below `sm`, so the app name stays legible on a phone while the title keeps
 * the room that matters most. The glyph is decoration, the name is the brand.
 *
 * `hideOnPhone` goes one step further and drops the whole brand below 480px.
 * Only the trip sets it: its title is user content (a 27-char trip name needs
 * ~210px) and the bar also carries a stage badge plus its own controls, so at
 * 360–430px the app name was squeezing the trip name into an ellipsis — the
 * app name is not what the traveler tapped through to read. Nothing is lost by
 * hiding it: the round back/Home control never yields, so the way home stays
 * exactly where it was.
 */
function Brand({
  asHeading,
  compact,
  hideOnPhone,
}: {
  asHeading: boolean;
  compact: boolean;
  hideOnPhone: boolean;
}) {
  const wordmark = (
    <>
      Kiseki{" "}
      <span className={compact ? "hidden text-primary sm:inline" : "text-primary"}>
        軌跡
      </span>
    </>
  );
  return (
    <Link
      to="/"
      title="Home"
      aria-label="Kiseki — home"
      className={`flex shrink-0 items-center gap-2 rounded-md focus-visible:focus-ring${
        hideOnPhone ? " max-[480px]:hidden" : ""
      }`}
    >
      <img
        src="/logo-mark-transparent.png"
        alt=""
        aria-hidden="true"
        className="h-6 w-6 shrink-0 rounded"
      />
      {asHeading ? (
        <h1 className="font-heading truncate text-lg font-semibold tracking-widest">
          {wordmark}
        </h1>
      ) : (
        <span className="font-heading truncate text-lg font-semibold tracking-widest">
          {wordmark}
        </span>
      )}
    </Link>
  );
}

export type AppHeaderProps = {
  /** Round Home/back control. Omitted on the landing, which is where it goes. */
  home?: { to: string; label: string } | null;
  /** The route's heading, rendered as the bar's `<h1>`. */
  title?: ReactNode;
  /** Small uppercase label, for routes whose `<h1>` lives in the content. */
  kicker?: ReactNode;
  /** Second line under the title (trip dates, place subtitle). */
  subtitle?: ReactNode;
  /** Rendered beside the title (the trip's StageBadge). */
  badge?: ReactNode;
  /**
   * Let the brand leave the bar below 480px (phones in portrait), so the
   * bar's own title keeps the width. Set by the trip — the one bar whose title
   * is user content and which also carries a badge and its own controls: on the
   * live trip bar the title slot goes 141px → 236px at 360px, 211px → 306px at
   * 430px. Ignored when the brand IS the bar's heading (the landing), so no
   * route can lose its `<h1>` this way.
   */
  hideBrandOnPhone?: boolean;
  /** Right-hand cluster: the account/feed chips, the trip chat + actions menu. */
  actions?: ReactNode;
  /** Second row inside the bar — the trip's desktop nav. */
  nav?: ReactNode;
  ref?: Ref<HTMLElement>;
};

export function AppHeader({
  home,
  title,
  kicker,
  subtitle,
  badge,
  hideBrandOnPhone,
  actions,
  nav,
  ref,
}: AppHeaderProps) {
  const hasHeading = Boolean(title || kicker || subtitle);
  // The brand only ever yields to a heading of its own — when it IS the
  // heading it is the page's `<h1>` and must stay.
  const brandYields = Boolean(hideBrandOnPhone && hasHeading);
  return (
    <header
      ref={ref}
      /* z-30, one step ABOVE the sheet (`Sheet` is z-20). The header is chrome
         and the sheet is content (§2.3), so every header affordance — the
         account menu, a trip's actions — has to paint over it. At z-20 both sat
         in the root stacking context and the sheet, being later in the DOM, won:
         on a phone an open menu was covered by the sheet's top edge. The map's
         own chips stay inside the map (z-10) and the sheet still floats over
         them, which is the order those two want. */
      className="no-print sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur"
    >
      <div className={HEADER_ROW}>
        {home && <HeaderIconLink to={home.to} label={home.label} />}
        {/* The wordmark owns an `<h1>` only when the bar carries no title of
            its own (the landing), so no route ever ships two page headings. */}
        <Brand asHeading={!hasHeading} compact={hasHeading} hideOnPhone={brandYields} />

        {hasHeading && (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {kicker ? (
                <p className="kicker truncate">{kicker}</p>
              ) : (
                <h1 className="truncate text-lg font-bold leading-tight">{title}</h1>
              )}
              {badge}
            </div>
            {subtitle && (
              <p className="flex min-w-0 items-center gap-1.5 truncate text-xs tabular-nums text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
        )}

        {actions && (
          <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>

      {nav && (
        // Second row inside the same measured <header> (TripLayout reads
        // `headerRef.offsetHeight` into --kiseki-header-h), so the map surface
        // (#39) subtracts this row too on desktop. Phones get the bottom nav
        // instead, so this row is hidden there and costs no height.
        <div className="hidden w-full px-4 pb-2 md:block">{nav}</div>
      )}
    </header>
  );
}
