import { useEffect } from "react";
import Plyr from "plyr-react";
import type { PlyrOptions, PlyrSource } from "plyr-react";
import "plyr/dist/plyr.css";
import { X } from "lucide-react";
import { useT } from "../i18n";
import type { Media } from "../types";
import { formatClock } from "../lib/format";

export interface VideoPlayerProps {
  media: Media;
  onClose: () => void;
}

export default function VideoPlayer({ media, onClose }: VideoPlayerProps) {
  const t = useT();
  const source: PlyrSource = {
    type: "video",
    title: media.fileName,
    sources: [{ src: media.streamUrl, type: media.mimeType }],
    poster: media.coverUrl ?? undefined,
  };

  const options: PlyrOptions = {
    controls: [
      "play-large",
      "play",
      "progress",
      "current-time",
      "duration",
      "mute",
      "volume",
      "settings",
      "fullscreen",
      "pip",
    ],
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2, 4] },
    keyboard: { focused: true, global: true },
    clickToPlay: true,
    fullscreen: { enabled: true, fallback: true, iosNative: false },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("media.playTitle", { name: media.fileName })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-zinc-100">{media.fileName}</h3>
            {media.durationSeconds != null && (
              <p className="mt-0.5 text-xs text-zinc-400">{formatClock(media.durationSeconds)}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("action.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black shadow-2xl">
          <Plyr source={source} options={options} />
        </div>
      </div>
    </div>
  );
}