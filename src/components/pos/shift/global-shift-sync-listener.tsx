"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  GLOBAL_SHIFT_SYNC_CHANNEL,
  GLOBAL_SHIFT_SYNC_EVENT,
} from "@/lib/shifts/realtime";

const SYNC_DEBOUNCE_MS = 250;
const FALLBACK_POLL_INTERVAL_MS = 10_000;

/**
 * Listener realtime + fallback polling untuk menyegarkan status shift global
 * secara otomatis ketika shift dibuka atau ditutup di tab/perangkat kasir lain.
 */
export function GlobalShiftSyncListener({
  channelSuffix = "pos",
}: {
  channelSuffix?: string;
}) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        router.refresh();
      }, SYNC_DEBOUNCE_MS);
    };

    let supabase: ReturnType<typeof createSupabaseBrowserClient> | null = null;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      supabase = null;
    }

    let broadcastChannel: RealtimeChannel | null = null;
    let dbChannel: RealtimeChannel | null = null;

    if (supabase) {
      broadcastChannel = supabase
        .channel(GLOBAL_SHIFT_SYNC_CHANNEL)
        .on(
          "broadcast",
          { event: GLOBAL_SHIFT_SYNC_EVENT },
          scheduleRefresh,
        )
        .subscribe();

      dbChannel = supabase
        .channel(`shifts-db-${channelSuffix}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "shifts",
          },
          scheduleRefresh,
        )
        .subscribe();
    }

    const pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, FALLBACK_POLL_INTERVAL_MS);

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        scheduleRefresh();
      }
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      clearInterval(pollTimer);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (supabase && broadcastChannel) {
        void supabase.removeChannel(broadcastChannel);
      }
      if (supabase && dbChannel) {
        void supabase.removeChannel(dbChannel);
      }
    };
  }, [channelSuffix, router]);

  return null;
}
