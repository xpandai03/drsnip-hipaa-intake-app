import { useCallback, useEffect, type RefObject } from "react";
import { postEmbedHeight } from "@/lib/embed-frame";

/**
 * Auto-height for an embedded form (contract: lib/embed-frame.ts). Posts the
 * root's rendered height on mount and on every ResizeObserver callback — step
 * change, a revealed field, a file preview, the success screen, and shrinking
 * as well as growing. Returns the poster so a form can also re-post explicitly
 * on state that changes layout. A no-op outside an iframe, and when `enabled`
 * is false (a shared shell whose embed mode is opt-in per form).
 */
export function useEmbedHeight(
  rootRef: RefObject<HTMLElement | null>,
  enabled = true,
): () => void {
  const postHeight = useCallback(() => {
    if (!enabled) return;
    postEmbedHeight(
      rootRef.current?.getBoundingClientRect().height ??
        document.body.scrollHeight,
    );
  }, [rootRef, enabled]);

  useEffect(() => {
    if (!enabled) return;
    postHeight();
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => postHeight());
    ro.observe(el);
    return () => ro.disconnect();
  }, [postHeight, rootRef, enabled]);

  return postHeight;
}
