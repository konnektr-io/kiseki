import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTripState } from "./theme";
import { roleAtLeast } from "../lib/editing";

/**
 * Trip edit mode — the reading/editor split for trip surfaces.
 *
 * Editors used to get every pencil, ghost button, block-chrome row and
 * "ask the agent" shortcut inline at all times, which crowded the reading
 * surface (notably on phones). Now the surfaces read clean by default and an
 * editor opts into the chrome per trip via the trip menu in the header.
 *
 * - Default OFF, persisted per trip in localStorage (`kiseki:edit-mode:<id>`).
 * - `useCanEdit()` is the ONE gate call sites use: role editor+ AND edit
 *   mode on. `InlineField`/`DayBlocks` keep their prop-driven trees, so the
 *   #104 two-tree contract is unchanged — the callers just pass a narrower
 *   `canEdit`/`editable`.
 * - Outside a provider (SSR tests that predate the provider, the booklet)
 *   the mode reads OFF — reading is the safe default.
 */

const STORAGE_PREFIX = "kiseki:edit-mode:";

function readStored(tripId: string): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(STORAGE_PREFIX + tripId) === "1";
  } catch {
    return false;
  }
}

interface EditModeState {
  editMode: boolean;
  setEditMode: (next: boolean) => void;
}

const EditModeContext = createContext<EditModeState | null>(null);

export function EditModeProvider({
  tripId,
  initial,
  children,
}: {
  tripId: string;
  /** Test seam — when set, skips the localStorage read for the initial state. */
  initial?: boolean;
  children: ReactNode;
}) {
  const [editMode, setEditModeState] = useState<boolean>(() =>
    initial !== undefined ? initial : readStored(tripId),
  );
  const setEditMode = useCallback(
    (next: boolean) => {
      setEditModeState(next);
      try {
        window.localStorage.setItem(STORAGE_PREFIX + tripId, next ? "1" : "0");
      } catch {
        // Private-mode storage (or SSR) — the toggle still works in memory.
      }
    },
    [tripId],
  );
  return <EditModeContext.Provider value={{ editMode, setEditMode }}>{children}</EditModeContext.Provider>;
}

export function useEditMode(): EditModeState {
  const ctx = useContext(EditModeContext);
  if (!ctx) return { editMode: false, setEditMode: () => {} };
  return ctx;
}

/** The editor-chrome gate: role editor+ AND edit mode enabled for this trip. */
export function useCanEdit(): boolean {
  const { trip } = useTripState();
  const { editMode } = useEditMode();
  return editMode && roleAtLeast(trip.myRole, "editor");
}
