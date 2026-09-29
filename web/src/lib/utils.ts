export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export type MetacriticTone = "green" | "yellow" | "red" | "none";

export function metacriticTone(score: number | null | undefined): MetacriticTone {
  if (score == null) return "none";
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

const GRADIENTS = [
  "from-violet-600 via-purple-600 to-fuchsia-600",
  "from-cyan-500 via-sky-600 to-blue-600",
  "from-emerald-500 via-teal-600 to-cyan-600",
  "from-fuchsia-600 via-pink-600 to-rose-600",
  "from-amber-500 via-orange-600 to-red-600",
  "from-indigo-500 via-violet-600 to-purple-600",
];

/** Deterministic gradient class derived from a name (used for poster placeholder). */
export function nameGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}