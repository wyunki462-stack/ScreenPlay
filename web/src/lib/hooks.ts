/**
 * Small hooks shared by the dialogs and the carousels.
 *
 * The two carousels drive different rotations — the homepage card advances only
 * when the user turns card slideshow on, while the detail page's large image
 * always rotates through every official poster — but they share the same timing
 * rule ("advance every N ms, but hold off while the user is looking at a slide"),
 * and both dialogs close on Escape in the same way. The per-component copies of
 * these two pieces had already drifted once.
 */
import { useEffect, useRef } from "react";

/** Close a dialog when the user presses Escape. */
export function useEscapeClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/**
 * Advance a carousel on a timer.
 *
 * @param active      run the timer only while this holds (slideshow mode with
 *                    more than one image)
 * @param paused      a hover/interaction pause; while set, no timer runs
 * @param resumeAt    timestamp before which a tick is skipped, so a manual step
 *                    is not immediately undone by the timer
 * @param intervalMs  tick length
 * @param advance     called on every tick; read through a ref, so an inline
 *                    closure does not restart the timer on every render
 * @param restartKey  primitive that changes when the rotation set changes: it
 *                    restarts the countdown, as the per-component deps used to
 */
export function useRotationTimer(options: {
  active: boolean;
  paused: boolean;
  resumeAt: { current: number };
  intervalMs: number;
  advance: () => void;
  restartKey?: string | number;
}): void {
  const { active, paused, resumeAt, intervalMs, advance, restartKey } = options;
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  useEffect(() => {
    if (!active || paused) return;
    const timer = setInterval(() => {
      if (Date.now() < resumeAt.current) return;
      advanceRef.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, paused, intervalMs, resumeAt, restartKey]);
}