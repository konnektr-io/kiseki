import { cva, type VariantProps } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";
import type { BlockStatus, Stage } from "../lib/types";

/* ---------- Button ---------- */

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
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
  const variant =
    stage === "booked" ? "accent" : stage === "live" ? "default" : ("outline" as const);
  return (
    <Badge variant={variant} className={className}>
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
