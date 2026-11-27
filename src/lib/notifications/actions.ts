"use server";

import { z } from "zod";
import { getSessionState } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { NotificationRecord } from "@/types/database";

export type NotificationsResult<T = undefined> =
  | { ok: true; message: string; data: T }
  | { ok: false; message: string };

const optionalUuidSchema = z.string().uuid().optional().nullable();

export async function getMyNotificationsAction(): Promise<
  NotificationsResult<{
    items: NotificationRecord[];
    unreadCount: number;
  }>
> {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    return { ok: false, message: "Sesi pengguna tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const [listRes, countRes] = await Promise.all([
    supabase
      .from("notifications")
      .select("*")
      .eq("recipient_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", session.user.id)
      .eq("is_read", false),
  ]);

  if (listRes.error) {
    return {
      ok: false,
      message: "Gagal memuat daftar notifikasi.",
    };
  }

  return {
    ok: true,
    message: "Notifikasi berhasil dimuat.",
    data: {
      items: (listRes.data ?? []) as NotificationRecord[],
      unreadCount: countRes.count ?? 0,
    },
  };
}

export async function markNotificationsReadAction(
  notificationId?: string | null,
): Promise<NotificationsResult<{ updatedCount: number }>> {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    return { ok: false, message: "Sesi pengguna tidak valid." };
  }

  const parsed = optionalUuidSchema.safeParse(notificationId ?? null);
  if (!parsed.success) {
    return { ok: false, message: "ID notifikasi tidak valid." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, message: "Koneksi database tidak tersedia." };
  }

  const { data, error } = await supabase.rpc(
    "mark_notifications_read_atomic",
    {
      p_notification_id: parsed.data ?? null,
    },
  );

  if (error) {
    return {
      ok: false,
      message: error.message || "Gagal memperbarui status notifikasi.",
    };
  }

  return {
    ok: true,
    message: "Notifikasi telah ditandai sudah dibaca.",
    data: {
      updatedCount: Number(data) || 0,
    },
  };
}
