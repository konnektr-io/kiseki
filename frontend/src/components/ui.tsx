import { cva, type VariantProps } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";
import type { BlockStatus, Stage } from "../lib/types";

/* ---------- Button ---------- */

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        accent: "bg-accent text-accent-foreground hover:opacity-90",
        outline: "border border-border bg-card hover:bg-muted",
        ghost: "hover:bg-muted",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        icon: "h-10 w-10",
        // No box of its own — for buttons whose geometry is the layout (a
        // full-width day row, a split nav control). Keeps them inside the
        // primitive (focus ring, transition, disabled state) instead of
        // becoming another hand-rolled className string.
        auto: "",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof button>) {
  return <button className={twMerge(button({ variant, size }), className)} {...props} />;
}

/* ---------- Card ---------- */

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={twMerge("rounded-xl border border-border bg-card text-foreground", className)}
      {...props}
    />
  );
}

/* ---------- Floating ---------- */

/**
 * The four-layer floating recipe (DESIGN.md §2.4): translucent surface +
 * backdrop blur + hairline border + soft shadow. Anything sitting over a map
 * or a photograph needs all four — a plain shadow vanishes over satellite
 * imagery and looks dirty over paper.
 *
 * The class name is exported too, for the cases that already render their own
 * element (StageBadge is a Badge span, not a div).
 */
export const FLOATING = "floating";

export function Floating({ className, ...props }: ComponentProps<"div">) {
  return <div className={twMerge("rounded-lg", FLOATING, className)} {...props} />;
}

/* ---------- Badge ---------- */

const badge = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        accent: "bg-accent/10 text-accent",
        outline: "border border-border text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badge>) {
  return <span className={twMerge(badge({ variant }), className)} {...props} />;
}

/* ---------- Stage / status labels ---------- */

export const STAGE_LABELS: Record<Stage, string> = {
  idea: "Idea",
  options: "Options",
  shortlist: "Shortlist",
  planned: "Planned",
  booked: "Booked",
  live: "Live",
  archive: "Archived",
};

export const STATUS_LABELS: Record<BlockStatus, string> = {
  planned: "Planned",
  booked: "Booked",
  done: "Done",
};

export function StageBadge({ stage, className = "" }: { stage: Stage; className?: string }) {
  // DESIGN.md §5.3: booked = filled accent, live = primary. These are SOLID
  // fills, deliberately NOT the Badge soft variants (bg-accent/10): the wash
  // sorts AFTER .floating in the built stylesheet, so it won the cascade and
  // the photo showed straight through — dark-teal text on bare imagery. One
  // background source per branch, never two competing ones.
  if (stage === "booked" || stage === "live") {
    const solid = stage === "booked" ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground";
    return (
      <span
        className={twMerge(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap shadow-floating",
          solid,
          className,
        )}
      >
        {STAGE_LABELS[stage]}
      </span>
    );
  }
  if (stage === "planned") {
    // §5.3: planned = solid but muted — quiet grey fill, between the
    // provisional outlines and the confident booked/live fills.
    return (
      <span
        className={twMerge(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap bg-muted text-muted-foreground shadow-floating",
          className,
        )}
      >
        {STAGE_LABELS[stage]}
      </span>
    );
  }
  return (
    <Badge
      variant="outline"
      className={twMerge(
        // The badge always sits on top of imagery (cover photos, card
        // headers), so it takes the full floating recipe rather than the
        // translucent-backdrop half of the recipe it used to hand-roll.
        FLOATING,
        className,
      )}
    >
      {STAGE_LABELS[stage]}
    </Badge>
  );
}

export function StatusChip({ status }: { status?: BlockStatus }) {
  if (!status) return null;
  return <Badge variant="outline">{STATUS_LABELS[status]}</Badge>;
}

/* ---------- Separator ---------- */

export function Separator({ className }: { className?: string }) {
  return <div className={twMerge("h-px w-full bg-border", className)} />;
}
