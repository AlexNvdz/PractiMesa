"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "./auth";

export interface LiveEvent {
  type: "order" | "table";
  id: string;
}

const RETRY_MS = 3000;

/**
 * Live changes of the current location (GET /api/events, server-sent events over fetch so the access token
 * travels in a header). Events are not replayed: onSync runs on every (re)connect so the screen reloads what
 * it shows, then onEvent names each row that changed. The server ends the stream when the token expires and
 * this reconnects with the renewed one.
 */
export function useLive(onSync: () => void, onEvent: (event: LiveEvent) => void, enabled = true) {
  const { apiFetch, me } = useAuth();
  const handlers = useRef({ onSync, onEvent });
  useEffect(() => {
    handlers.current = { onSync, onEvent };
  });
  const locationId = me?.current_location_id;

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        let failed = true;
        try {
          const res = await apiFetch("/api/events", { signal: abort.signal });
          if (res.ok && res.body) {
            handlers.current.onSync();
            // reader.read() rather than for-await: Safari (iPad terminals) cannot iterate streams.
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += value;
              const blocks = buffer.split("\n\n");
              buffer = blocks.pop() ?? "";
              for (const block of blocks) {
                const type = /^event: (\w+)$/m.exec(block)?.[1];
                const data = /^data: (.+)$/m.exec(block)?.[1];
                if ((type === "order" || type === "table") && data) {
                  handlers.current.onEvent({ type, id: (JSON.parse(data) as { id: string }).id });
                }
              }
            }
            failed = false;
          }
        } catch {
          // Network drop or unmount; the loop decides.
        }
        // A stream the server ended (token expiry) reconnects at once; a failure waits.
        if (failed && !abort.signal.aborted) await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    })();
    return () => abort.abort();
  }, [apiFetch, locationId, enabled]);
}
