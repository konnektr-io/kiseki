import { useEffect } from "react";

/** Set document.title (and keep it in sync) for the current page. */
export function usePageTitle(title: string | null) {
  useEffect(() => {
    document.title = title ? `${title} · Kiseki` : "Kiseki — living trip documents";
  }, [title]);
}
