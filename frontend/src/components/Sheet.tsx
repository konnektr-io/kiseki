import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { ChevronUp } from "lucide-react";
import {
  DETENT_FRACTION,
  SHEET_FRACTION,
  detentOffsetPct,
  nearestDetent,
  nextDetent,
  prevDetent,
  type Detent,
} from "../lib/sheet";
import { prefersReducedMotion } from "../lib/maps";

export type { Detent };

interface SheetProps {
  detent: Detent;
  onDetentChange: (detent: Detent) => void;
  /** Accessible name — the sheet is a region, not a dialog. */
  label: string;
  /** Always visible, even at `peek`: the "what am I looking at" line. */
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Below this many px of movement the gesture hasn't declared itself yet. */
const DRAG_SLOP = 4;

/**
 * The bottom sheet (DESIGN.md §7.3, kiseki-map-ux) — Chrome, over a map.
 *
 * Three detents: `peek` (~15%, one line), `half` (~50%, the list), `full`
 * (~90%). It is **not a modal**: Escape and a tap above it return to `peek`,
 * never to nothing, because the sheet IS the content next to the map.
 *
 * Mechanics worth knowing before editing:
 *
 * - The element is always laid out at its FULL height and translated down to
 *   expose the current detent, so every transition is a `transform` (§10 —
 *   never animate `height`) and no measurement is needed to lay it out.
 * - Dragging is 1:1 with the finger and unanimated; only the snap animates
 *   (200ms), and `prefers-reduced-motion` removes even that.
 * - It renders `absolute`, not `fixed`: a map surface owns a fixed-height box
 *   already, and a `fixed` element here would leak into the print path — the
 *   thing DESIGN.md §2 warns is enough to break the booklet on its own.
 * - The caller owns `detent` because the map needs it too: camera padding has
 *   to track the occlusion or half the route hides under the sheet.
 */
export function Sheet({ detent, onDetentChange, label, header, children, className }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Live px offset while a finger is down; null when settled. */
  const [dragPx, setDragPx] = useState<number | null>(null);
  // The live offset also lives on the ref: `pointerup` must read the value
  // the last `pointermove` produced, not whatever state React has committed.
  const gesture = useRef<{
    id: number;
    startY: number;
    /** Clamped offset actually applied to the sheet. */
    px: number;
    /** Raw finger travel — what decides "this was a drag, not a tap". */
    dy: number;
    active: boolean;
  } | null>(null);
  // A finished drag still fires `click` on whatever it started on — the
  // handle (which would step the detent again, over the top of the snap the
  // drag just chose) or a list row (which would select a place the user was
  // only using as something to pull on). One capture-phase handler on the
  // section swallows that click, wherever it lands.
  const dragged = useRef(false);

  const baseOffsetPct = detentOffsetPct(detent);
  const maxOffsetPct = detentOffsetPct("peek");

  const heightPx = () => sheetRef.current?.offsetHeight ?? 0;

  const endGesture = useCallback(
    (commit: boolean) => {
      const g = gesture.current;
      gesture.current = null;
      setDragPx(null);
      // Judged on raw travel, not the clamped offset: dragging UP from `full`
      // clamps to zero movement, and treating that as a tap made the handle's
      // click handler collapse the sheet to `peek` — the opposite of the
      // gesture.
      if (g?.active && Math.abs(g.dy) > DRAG_SLOP) dragged.current = true;
      if (!commit || !g?.active) return;
      const h = heightPx();
      if (!h) return;
      const totalPx = (baseOffsetPct / 100) * h + g.px;
      const exposed = (1 - totalPx / h) * SHEET_FRACTION;
      const target = nearestDetent(exposed);
      if (target !== detent) onDetentChange(target);
    },
    [baseOffsetPct, detent, onDetentChange],
  );

  const clampDrag = (dy: number) => {
    const h = heightPx();
    if (!h) return 0;
    const base = (baseOffsetPct / 100) * h;
    const max = (maxOffsetPct / 100) * h;
    return Math.min(Math.max(base + dy, 0), max) - base;
  };

  const onPointerDown = (e: React.PointerEvent, fromHandle: boolean) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragged.current = false;
    // A drag that starts in the body only becomes a sheet drag when the body
    // is already scrolled to the top and the finger goes DOWN — otherwise it
    // is a scroll, and stealing it is what makes sheets feel broken.
    if (!fromHandle && (bodyRef.current?.scrollTop ?? 0) > 0) return;
    gesture.current = { id: e.pointerId, startY: e.clientY, px: 0, dy: 0, active: fromHandle };
    if (fromHandle) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragPx(0);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dy = e.clientY - g.startY;
    if (!g.active) {
      if (dy > DRAG_SLOP && (bodyRef.current?.scrollTop ?? 0) <= 0) {
        g.active = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } else if (dy < -DRAG_SLOP) {
        gesture.current = null;
        return;
      } else {
        return;
      }
    }
    const px = clampDrag(dy);
    g.px = px;
    g.dy = dy;
    setDragPx(px);
  };

  const onPointerUp = () => endGesture(true);
  const onPointerCancel = () => endGesture(false);

  // Escape returns to `peek` from anywhere on the surface — including when
  // focus sits on the map canvas, which is why this is a window listener.
  useEffect(() => {
    if (detent === "peek") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDetentChange("peek");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detent, onDetentChange]);

  // The body only scrolls once there is something to scroll; at `peek` it is
  // a single line. Exactly one scroll container at a time (§7.2).
  const scrollable = detent !== "peek";
  useEffect(() => {
    if (!scrollable && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollable]);

  // The body must end exactly where the sheet's VISIBLE region ends (#109).
  // The sheet element is translated to its detent — so live rects lie twice
  // over: its box can extend past the viewport, and during the 200ms snap the
  // rect is mid-animation. Everything below is therefore read transform-
  // immune: layout offsets (`offsetTop`, `offsetHeight`, parent client box)
  // plus the PARENT's viewport rect (the parent never transforms). Body
  // height = min(final sheet bottom, viewport bottom) − final body top.
  // An element-height body would let the last rows (the day nav) scroll into
  // the hidden region and become unreachable — at `half` that hid the nav
  // entirely; at `full` it left it hanging below the floor.
  const [bodyHeightPx, setBodyHeightPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const body = bodyRef.current;
    const surface = sheet?.parentElement;
    if (!sheet || !body || !surface) return;
    const measure = () => {
      const surfaceTop = surface.getBoundingClientRect().top; // stable
      const surfaceH = surface.clientHeight;
      const sheetH = sheet.offsetHeight; // layout height, transform-immune
      const finalBottom =
        surfaceH - (detentOffsetPct(detent) / 100) * sheetH; // sheet's settled bottom in surface coords
      const bodyTop =
        surfaceH - sheetH + body.offsetTop; // body's settled top in surface coords
      const visibleBottom = Math.min(surfaceTop + finalBottom, window.innerHeight);
      setBodyHeightPx(Math.max(0, Math.round(visibleBottom - (surfaceTop + bodyTop))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(surface!);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [detent]);

  // `dragPx` is only ever set once a gesture is active, so it doubles as the
  // "finger is down" flag — no ref read during render.
  const dragging = dragPx != null;
  const transform = dragging
    ? `translateY(calc(${baseOffsetPct}% + ${dragPx}px))`
    : `translateY(${baseOffsetPct}%)`;

  return (
    <>
      {/* The strip of map still visible above a `full` sheet doubles as the
          way back — the sheet is content, so this collapses it to `peek`
          rather than dismissing it. Escape is the keyboard equivalent, which
          is why this carries no role of its own. */}
      {detent === "full" && (
        <div
          aria-hidden="true"
          onClick={() => onDetentChange("peek")}
          className="absolute inset-x-0 top-0 z-10 bg-scrim/10"
          style={{ height: `${(1 - DETENT_FRACTION.full) * 100}%` }}
        />
      )}
      <section
        ref={sheetRef}
        aria-label={label}
        data-detent={detent}
        onClickCapture={(e) => {
          if (!dragged.current) return;
          dragged.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
        className={twMerge(
          "floating absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-2xl",
          !dragging && !prefersReducedMotion() && "transition-transform duration-200 ease-out",
          className,
        )}
        style={{
          height: `${SHEET_FRACTION * 100}%`,
          transform,
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Drag handle — a real button, so the detents are reachable without a
            drag gesture at all (pointer-free, and the only path for AT). */}
        <button
          type="button"
          aria-label={`${label} — ${detent === "full" ? "collapse" : "expand"} panel`}
          aria-expanded={detent !== "peek"}
          onPointerDown={(e) => onPointerDown(e, true)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={() => onDetentChange(detent === "full" ? "peek" : nextDetent(detent))}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onDetentChange(nextDetent(detent));
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onDetentChange(prevDetent(detent));
            }
          }}
          className="sheet-handle relative grid h-11 w-full shrink-0 cursor-grab touch-none place-items-center rounded-t-2xl active:cursor-grabbing"
        >
          <span className="sr-only">Drag or use the arrow keys to resize</span>
          <span
            aria-hidden="true"
            className="sheet-grip flex h-1.5 w-10 items-center justify-center rounded-full bg-muted-foreground/40"
          />
          <ChevronUp
            aria-hidden="true"
            className={`absolute right-3 h-4 w-4 text-muted-foreground transition-transform duration-200 ${
              detent === "full" ? "rotate-180" : ""
            }`}
          />
        </button>

        {/* The peek line is the sheet's biggest target and the obvious place
            to pull up from, so it drags too — it has nothing to scroll, so
            unlike the body it takes the gesture in both directions. */}
        {header && (
          <div
            onPointerDown={(e) => {
              // A press on a control in the peek line belongs to the control:
              // capturing the pointer here would retarget its click to this
              // div and the button would simply never fire.
              if ((e.target as HTMLElement).closest("button,a,input,select,textarea")) return;
              onPointerDown(e, true);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            className="shrink-0 touch-none border-b border-border/60 px-4 pb-3"
          >
            {header}
          </div>
        )}

        <div
          ref={bodyRef}
          data-scroll-root=""
          onPointerDown={(e) => onPointerDown(e, false)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          style={bodyHeightPx != null ? { height: bodyHeightPx } : undefined}
          className={`min-h-0 shrink-0 grow-0 overscroll-contain px-4 ${
            scrollable ? "overflow-y-auto" : "overflow-hidden"
          }`}
        >
          {children}
        </div>
      </section>
    </>
  );
}
