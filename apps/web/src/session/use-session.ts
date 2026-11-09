import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { takeTokenFromUrl } from "./token-url.ts";

export type SessionState = "connecting" | "ready" | "invalid-link" | "failed";

let exchange: Promise<SessionState> | null = null;

/**
 * Exchanges the one-time `?token=` from the launch URL for a session cookie,
 * then removes the token from the address bar. Runs once per page load.
 */
function exchangeTokenOnce(): Promise<SessionState> {
  exchange ??= (async () => {
    const found = takeTokenFromUrl(window.location.href);
    if (!found) return "ready";

    window.history.replaceState(null, "", found.cleanUrl);
    if (found.token === null) return "invalid-link";

    try {
      const res = await api.session.$post({ json: { token: found.token } });
      return res.ok ? "ready" : "invalid-link";
    } catch {
      return "failed";
    }
  })();
  return exchange;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>("connecting");

  useEffect(() => {
    let active = true;
    exchangeTokenOnce().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
