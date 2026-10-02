/**
 * Authentication hooks.
 *
 * Sessions live in an httpOnly cookie the backend manages; this module only asks
 * "am I signed in?" and drives login/logout. Nothing here contacts a cloud
 * service — the backend verifies against the NAS host accounts or app-local ones.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface SessionUser {
  username: string;
  displayName: string;
  provider: "system" | "local";
  uid?: number;
}

export interface AuthSession {
  /** false when AUTH_DISABLED=1 — the app then runs without a login screen. */
  enabled: boolean;
  mode: "system" | "local";
  /** Provider a login would actually use right now. */
  provider: "system" | "local";
  systemAvailable: boolean;
  /** Why the system provider is unavailable, when applicable. */
  reason: string | null;
  users: Array<{ username: string; gecos: string; uid: number }>;
  authenticated: boolean;
  user: SessionUser | null;
}

const SESSION_KEY = ["auth-session"] as const;

export function useAuthSession() {
  const queryClient = useQueryClient();

  // Any 401 from any request drops the cached session so the login screen
  // appears immediately, without waiting for the next poll.
  useEffect(() => {
    const onUnauthorized = () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    };
    window.addEventListener("screenplay:unauthorized", onUnauthorized);
    return () => window.removeEventListener("screenplay:unauthorized", onUnauthorized);
  }, [queryClient]);

  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => apiFetch<AuthSession>("/auth/session"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string; remember?: boolean }) =>
      apiFetch<{ ok: boolean; user: SessionUser; expiresAt: number }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Signed in: refetch the session and everything the login gate hid.
      void queryClient.invalidateQueries();
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}

/** Business outcome of `POST /auth/password`; the backend always answers 200. */
export interface ChangePasswordResult {
  ok: boolean;
  /** Stable reason code, e.g. "wrong_current", "too_short", "not_local". */
  code?: string;
  /** Human-readable (Chinese) reason, already translated by the backend. */
  error?: string;
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { current: string; next: string }) =>
      apiFetch<ChangePasswordResult>("/auth/password", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}