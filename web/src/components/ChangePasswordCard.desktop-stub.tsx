/**
 * Desktop stand-in for `ChangePasswordCard.tsx`.
 *
 * `web/vite.config.ts` aliases the module specifier ending in
 * `/ChangePasswordCard` to this file when the bundle is built with
 * `--mode desktop`. The point is that the desktop artifact contains no
 * change-password UI, no `settings.password.*` strings and no
 * `useChangePassword` mutation at all — a single-machine install has no login
 * screen, and its password is managed by the launcher (`config.json`).
 *
 * Keep it that small: it has to build with no dependencies on the module it
 * replaces (importing from it would pull the card back into the bundle).
 */
export default function ChangePasswordCard(_props: { session?: unknown }) {
  return null;
}