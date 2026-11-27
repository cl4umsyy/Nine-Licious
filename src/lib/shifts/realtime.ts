"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export const GLOBAL_SHIFT_SYNC_CHANNEL = "nine-licious-global-shift-sync";
export const GLOBAL_SHIFT_SYNC_EVENT = "shift_changed";

/**
 * Mengirim sinyal broadcast ke tab/browser POS dan admin lain ketika shift
 * dibuka atau ditutup, sehingga UI kasir lain langsung tersinkronisasi tanpa
 * perlu membuka tabel finansial shifts milik kasir lain lewat RLS.
 */
export async function broadcastGlobalShiftChanged(): Promise<void> {
  let supabase: ReturnType<typeof createSupabaseBrowserClient> | null = null;
  try {
    supabase = createSupabaseBrowserClient();
  } catch {
    return;
  }
  if (!supabase) return;

  const channel: RealtimeChannel = supabase.channel(GLOBAL_SHIFT_SYNC_CHANNEL);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 600);
      channel.subscribe((status) => {
        if (
          status === "SUBSCRIBED" ||
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await channel.send({
      type: "broadcast",
      event: GLOBAL_SHIFT_SYNC_EVENT,
      payload: { at: Date.now() },
    });
  } catch {
    // Fallback polling dan visibilitychange tetap menjamin sinkronisasi
  } finally {
    void supabase.removeChannel(channel);
  }
}
