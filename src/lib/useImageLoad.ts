import { useCallback, useEffect, useRef, useState } from "react";

/**
 * An image in the chat, from the first try to the answer the chat can give about it. A phone's
 * connection comes and goes (the app in the background, mobile data, Tailscale reconnecting) and an
 * <img> that failed once never asks again, so it stayed a broken picture until the chat was reopened.
 */
export type ImageLoad =
  | "loading"
  | "shown"
  /** the server has no such file: it may be written yet, so a return to the app asks again */
  | "missing"
  /** a bare name several files have: the file viewer lists them */
  | "ambiguous"
  /** every try failed: a tap tries again */
  | "failed";

/** Waits before each new try after a failure. Three tries over 15 s see out a connection coming back. */
export const IMAGE_RETRY_MS = [1500, 4000, 10000];

/** What the server says about a file an <img> could not show. A dead connection is a status of 0. */
export async function imageStatus(src: string): Promise<number> {
  try {
    return (await fetch(src, { method: "HEAD" })).status;
  } catch {
    return 0;
  }
}

/** `attempt` keys the <img>: a new element is what makes a browser ask again. */
export function useImageLoad(src: string): { load: ImageLoad; attempt: number; onLoad: () => void; onError: () => void; retry: () => void } {
  const [load, setLoad] = useState<ImageLoad>("loading");
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(src);
  current.current = src;
  const loadNow = useRef(load);
  loadNow.current = load;

  const retry = useCallback(() => {
    clearTimeout(timer.current);
    failures.current = 0;
    setLoad("loading");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    failures.current = 0;
    setLoad("loading");
    setAttempt(0);
  }, [src]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // back in the app, or back online: anything not drawn is asked for again at once
  useEffect(() => {
    const wake = (): void => {
      if (document.visibilityState !== "visible") return;
      const state = loadNow.current;
      if (state === "failed" || state === "missing") retry();
      else if (state === "loading" && failures.current > 0) retry();
    };
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [retry]);

  const onLoad = useCallback(() => {
    clearTimeout(timer.current);
    failures.current = 0;
    setLoad("shown");
  }, []);

  const onError = useCallback(() => {
    const asked = current.current;
    void imageStatus(asked).then((status) => {
      if (current.current !== asked) return;
      if (status === 404) { setLoad("missing"); return; }
      if (status === 409) { setLoad("ambiguous"); return; }
      const wait = IMAGE_RETRY_MS[failures.current];
      if (wait === undefined) { setLoad("failed"); return; }
      failures.current += 1;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setAttempt((value) => value + 1), wait);
    });
  }, []);

  return { load, attempt, onLoad, onError, retry };
}
