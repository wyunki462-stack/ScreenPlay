import { useState } from "react";
import { cn, nameGradient } from "../lib/utils";

export interface PosterImageProps {
  src: string | null;
  name: string;
  alt?: string;
  className?: string;
}

/** Poster image with a deterministic gradient + initial fallback. */
export default function PosterImage({ src, name, alt, className }: PosterImageProps) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt ?? name}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("h-full w-full object-cover", className)}
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      role="img"
      aria-label={name}
      className={cn("flex h-full w-full items-center justify-center bg-gradient-to-br", nameGradient(name), className)}
    >
      <span className="select-none text-5xl font-black text-white/90 drop-shadow-md">{initial}</span>
    </div>
  );
}