import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHROME_PADDING, clampPadding, type MapPadding } from "../lib/maps";
import { detentOcclusionPx, type Detent } from "../lib/sheet";
import { Sheet } from "./Sheet";

/**
 * The map/content ratio ladder (DESIGN.md §7.2) as four named modes.
 *
 * Think in ratio, not breakpoints: the question is always "how much of the
 * viewport does the map get, and how does the content sit next to it".
 *
 * | mode    | viewport                        | map              | content            |
 * |---------|---------------------------------|------------------|--------------------|
 * | `sheet` | phone portrait                  | full-bleed behind| bottom sheet, 3 detents |
 * | `side`  | phone landscape / small tablet  | 100%             | left side sheet, ~340px |
 * | `split` | tablet 768–1279                 | rest right       | draggable left column |
 * | `rail`  | desktop >= 1280                 | fills remaining  | draggable left rail  |
 *
 * `side` exists because a landscape phone has no vertical room for a bottom
 * sheet — the case that breaks every bottom-sheet layout that only tests
 * portrait.
 */
export type SurfaceMode = "sheet" | "side" | "split" | "rail";

/** Default rail width, user-draggable between the clamps (#105). */
const RAIL_DEFAULT_PX = 480;
const RAIL_MIN_PX = 320;
/** Never swallow the map: viewport minus this is the map's floor. */
const RAIL_MAX_VIEWPORT_RESERVE_PX = 480;
const SIDE_PX = 340;
/** Gap between a floating side panel and the viewport edge. */
const SIDE_GUTTER = 12;
/** sessionStorage key — the drag survives navigation, not sessions. */
const RAIL_WIDTH_KEY = "kiseki-rail-width";

/**
 * First match wins, so order is the ladder.
 *
 * `side` is keyed on HEIGHT, not `orientation: landscape`: what rules out a
 * bottom sheet on a landscape phone is that there is no vertical room for one,
 * and a 700x600 viewport is "landscape" with plenty of room. Modern phones in
 * landscape are wider than 768 anyway and land in `split`, whose content
 * column IS the ~340px side panel that row of the ladder asks for.
 */
const QUERIES: [SurfaceMode, string][] = [
  ["rail", "(min-width: 1280px)"],
  ["split", "(min-width: 768px)"],
  ["side", "(max-height: 500px)"],
];

/**
 * Which rung of the ladder we're on.
 *
 * This has to be JS rather than CSS: a bottom sheet and a rail are different
 * component trees, not different styling of one tree, and the map needs the
 * mode anyway to compute camera padding.
 */
export function useSurfaceMode(): SurfaceMode {
  const read = (): SurfaceMode => {
    if (typeof window === "undefined") return "rail";
    return QUERIES.find(([, q]) => window.matchMedia(q).matches)?.[0] ?? "sheet";
  };
  const [mode, setMode] = useState<SurfaceMode>(read);
  useEffect(() => {
    const mqls = QUERIES.map(([, q]) => window.matchMedia(q));
    const sync = () => setMode(read());
    mqls.forEach((m) => m.addEventListener("change", sync));
    // Rotating a phone changes `orientation` without crossing a width query
    // on some browsers, so listen to resize as well.
    window.addEventListener("resize", sync);
    sync();
    return () => {
      mqls.forEach((m) => m.removeEventListener("change", sync));
      window.removeEventListener("resize", sync);
    };
  }, []);
  return mode;
}

interface SplitViewProps {
  /** The map. Rendered with the camera padding for the current occlusion. */
  map: (padding: MapPadding) => ReactNode;
  /** The keyboard-reachable list — the accessible path to the map's content. */
  content: ReactNode;
  /** Accessible name for the sheet / rail region. */
  label: string;
  /** Shown even at `peek`: the "what am I looking at" line. */
  header?: ReactNode;
  detent: Detent;
  onDetentChange: (detent: Detent) => void;
  /** Desktop modes only (#104): pinned BELOW the scroller, outside it, so it
   *  stays flush with the rail's bottom edge at every scroll position. The
   *  phone sheet ignores it — there the scroller IS the sheet, and content
   *  carries its own in-flow sticky bar. */
  footer?: ReactNode;
}

/**
 * The user's rail width, clamped — read once per mount (a drag updates state
 * directly; the store is the persistence, not the truth).
 */
function readRailWidth(): number {
  if (typeof window === "undefined") return RAIL_DEFAULT_PX;
  const raw = Number(window.sessionStorage.getItem(RAIL_WIDTH_KEY));
  if (!Number.isFinite(raw)) return RAIL_DEFAULT_PX;
  return Math.min(Math.max(raw, RAIL_MIN_PX), Math.max(RAIL_MIN_PX, window.innerWidth - RAIL_MAX_VIEWPORT_RESERVE_PX));
}

/**
 * A map surface: one map, one list, and exactly one scroll container.
 *
 * The root is `relative` and fills its parent, so the caller owns the height
 * (a map surface is `100dvh` minus the app chrome). Nothing in here is
 * `position: fixed` — see the note in `Sheet`.
 */
export function SplitView({
  map,
  content,
  label,
  footer,
  header,
  detent,
  onDetentChange,
}: SplitViewProps) {
  const mode = useSurfaceMode();
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // #105 — draggable left panel (rail + split). Live during the drag, clamped
  // against the viewport so the map keeps at least its reserve; persisted per
  // session. `side` keeps its fixed float (no room to drag on a landscape
  // phone), `sheet` is detent-driven already.
  const [railWidth, setRailWidth] = useState<number>(() => (mode === "rail" ? readRailWidth() : 0));
  useEffect(() => {
    if (mode === "rail") setRailWidth(readRailWidth());
  }, [mode]);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const railClamp = (w: number) =>
    Math.min(Math.max(w, RAIL_MIN_PX), Math.max(RAIL_MIN_PX, window.innerWidth - RAIL_MAX_VIEWPORT_RESERVE_PX));
  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: railWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setRailWidth(railClamp(d.startWidth + (e.clientX - d.startX)));
  };
  const onDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Persist on release, not per-move: the store is written once with the
    // settled value.
    setRailWidth((w) => {
      const clamped = railClamp(w);
      window.sessionStorage.setItem(RAIL_WIDTH_KEY, String(clamped));
      return clamped;
    });
  };

  // The sheet's occlusion is a fraction of the surface, so the camera padding
  // needs the surface in px. Measured rather than assumed: mobile browser
  // chrome resizes this box while you scroll.
  useLayoutEffect(() => {
    const el = mapBoxRef.current;
    if (!el) return;
    const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // The map's usable viewport is the part not covered by content. In `split`
  // and `rail` the map has its own column, so only its own chrome occludes it.
  const sheetPx = mode === "sheet" ? detentOcclusionPx(detent, box.height) : 0;
  const occluded: MapPadding =
    mode === "sheet"
      ? { ...CHROME_PADDING, bottom: CHROME_PADDING.bottom + sheetPx }
      : mode === "side"
        ? { ...CHROME_PADDING, left: CHROME_PADDING.left + SIDE_PX + SIDE_GUTTER * 2 }
        : CHROME_PADDING;
  // Memoised on the NUMBERS, not rebuilt per render.
  //
  // `padding` is a camera instruction, and the map re-frames when it changes.
  // A fresh object every render means every unrelated re-render re-frames —
  // and `TripProvider` hands out a new context value on each `TripLayout`
  // render, so downloading the PDF from the header menu was enough to throw
  // away whatever the viewer had panned to. DESIGN.md §10: camera moves fire
  // on explicit intent, never on render.
  const padding = useMemo(
    () => clampPadding(occluded, box.width, box.height),
    [occluded.top, occluded.right, occluded.bottom, occluded.left, box.width, box.height],
  );

  // MapLibre's own chrome sits in the map container's corners, which is
  // exactly where the content is: the attribution row is under the sheet, and
  // the zoom chips are under the side panel. Attribution is a legal
  // requirement and the zoom buttons are the a11y floor's answer to "not
  // everyone can pinch", so neither may be covered — `index.css` translates
  // the corner rows by these two offsets.
  const chromeStyle = {
    "--map-chrome-x": mode === "side" ? `${SIDE_PX + SIDE_GUTTER}px` : "0px",
    "--map-chrome-y": `${sheetPx}px`,
  } as React.CSSProperties;

  if (mode === "split" || mode === "rail") {
    // rail: px column the user can drag; split: the fr ladder, also draggable
    // (drag sets an explicit px column, same mechanism both modes).
    const firstCol = mode === "rail" ? `${railWidth || RAIL_DEFAULT_PX}px` : `minmax(0, ${railWidth || 40}fr)`;
    const draggable = mode === "rail";
    return (
      <div
        className="grid h-full w-full overflow-hidden"
        style={{
          // #105: rail | 12px divider | map — the divider is a grid CHILD, so it
          // must have its own column or the map falls to an implicit second row.
          gridTemplateColumns: draggable
            ? `${firstCol} 12px minmax(0, 1fr)`
            : "minmax(0, 2fr) minmax(0, 3fr)",
        }}
      >
        {/* The rail is the only scroll container; the map never scrolls. */}
        <section
          aria-label={label}
          className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border bg-background"
        >
          {header && <div className="shrink-0 border-b border-border px-5 py-3">{header}</div>}
          <div data-scroll-root="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {content}
          </div>
          {footer && <div className="no-print shrink-0 border-t border-border">{footer}</div>}
        </section>
        {draggable && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize the ${label} panel`}
            aria-valuenow={railWidth || RAIL_DEFAULT_PX}
            aria-valuemin={RAIL_MIN_PX}
            aria-valuemax={railClamp(2000)}
            tabIndex={0}
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setRailWidth((w) => railClamp((w || RAIL_DEFAULT_PX) - 24));
              if (e.key === "ArrowRight") setRailWidth((w) => railClamp((w || RAIL_DEFAULT_PX) + 24));
            }}
            className="split-divider group relative z-10 -ml-1.5 w-3 shrink-0 cursor-col-resize touch-none"
          >
            <span className="split-divider-grip absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-border transition-colors group-hover:bg-accent/60" />
          </div>
        )}
        <div ref={mapBoxRef} className="map-surface relative h-full min-w-0">
          {map(padding)}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mapBoxRef}
      style={chromeStyle}
      data-sheet-detent={mode === "sheet" ? detent : undefined}
      className="map-surface relative h-full w-full overflow-hidden"
    >
      {map(padding)}
      {mode === "side" ? (
        // Landscape phone: the map keeps the whole viewport and the list
        // floats over it, so it needs the full four-layer recipe (§2.4).
        <section
          aria-label={label}
          className="floating absolute bottom-0 left-0 top-0 z-20 flex flex-col overflow-hidden rounded-r-2xl"
          style={{
            width: SIDE_PX,
            margin: SIDE_GUTTER,
            marginLeft: 0,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {header && <div className="shrink-0 border-b border-border/60 px-4 py-3">{header}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">{content}</div>
          {footer && <div className="no-print shrink-0 border-t border-border/60">{footer}</div>}
        </section>
      ) : (
        <Sheet detent={detent} onDetentChange={onDetentChange} label={label} header={header}>
          {content}
        </Sheet>
      )}
    </div>
  );
}
