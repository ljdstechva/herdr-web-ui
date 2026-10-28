import { useEffect, useRef, useState } from "react";
import type { SignInRequest } from "../../shared/sign-in.ts";
import { fetchSignIn } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/** after a failed read (server restarting, offline): before the next one */
const RETRY_MS = 5_000;
/** with no broker on this PC: how often to look again for one */
const OFFLINE_MS = 60_000;

/**
 * The open sign-in requests of this PC's broker, kept current by a long poll while the page is
 * visible. Off (`enabled` false) it holds nothing and asks nothing.
 */
export function useSignInRequests(enabled: boolean): { requests: SignInRequest[]; broker: "online" | "offline" | "unknown" } {
  const [requests, setRequests] = useState<SignInRequest[]>([]);
  const [broker, setBroker] = useState<"online" | "offline" | "unknown">("unknown");
  const visible = usePageVisible();
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled || !visible) { generation.current++; if (!enabled) setRequests([]); return; }
    const current = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async (wait: boolean) => {
      if (current !== generation.current) return;
      let delay = 0;
      try {
        const list = await fetchSignIn(wait, controller.signal);
        if (current !== generation.current) return;
        setBroker(list.broker);
        setRequests((previous) => JSON.stringify(previous) === JSON.stringify(list.requests) ? previous : list.requests);
        delay = list.broker === "offline" ? OFFLINE_MS : 0;
      } catch {
        if (current !== generation.current) return;
        delay = RETRY_MS;
      }
      timer = setTimeout(() => void loop(true), delay);
    };
    void loop(false);
    return () => { generation.current++; controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [enabled, visible]);

  return { requests, broker };
}
