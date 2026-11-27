"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  ChefHat,
  Clock3,
  FileWarning,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UserRole } from "@/lib/auth/roles";
import {
  getMyNotificationsAction,
  markNotificationsReadAction,
} from "@/lib/notifications/actions";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { NotificationRecord, NotificationType } from "@/types/database";

type NotificationBellProps = {
  userId: string;
  role: UserRole;
};

const WIB_TIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTimeWib(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "-";
  return `${WIB_TIME_FORMATTER.format(dt)} WIB`;
}

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case "refund_approved":
    case "refund_payout_completed":
      return <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />;
    case "refund_rejected":
    case "refund_cancelled":
    case "refund_payout_failed":
      return <XCircle className="size-4 text-destructive shrink-0 mt-0.5" />;
    case "refund_evidence_requested":
      return <FileWarning className="size-4 text-amber-600 shrink-0 mt-0.5" />;
    case "kds_item_cancelled":
    case "kds_replacement_ticket":
      return <ChefHat className="size-4 text-primary shrink-0 mt-0.5" />;
    case "refund_corrected":
      return <AlertTriangle className="size-4 text-amber-600 shrink-0 mt-0.5" />;
    default:
      return <RotateCcw className="size-4 text-primary shrink-0 mt-0.5" />;
  }
}

export function NotificationBell({ userId, role }: NotificationBellProps) {
  const router = useRouter();
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const syncNotifications = useCallback(async (manual = false) => {
    if (manual) setIsRefreshing(true);
    try {
      const res = await getMyNotificationsAction();
      if (!mountedRef.current) return;
      if (res.ok) {
        setItems(res.data.items);
        setUnreadCount(res.data.unreadCount);
      }
    } finally {
      if (mountedRef.current && manual) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;

    getMyNotificationsAction().then((res) => {
      if (!active || !mountedRef.current) return;
      if (res.ok) {
        setItems(res.data.items);
        setUnreadCount(res.data.unreadCount);
      }
    });

    let supabase: ReturnType<typeof createSupabaseBrowserClient> | null = null;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      supabase = null;
    }

    const channel = supabase
      ? supabase
          .channel(`staff-notifications-${userId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "notifications",
              filter: `recipient_id=eq.${userId}`,
            },
            () => {
              void syncNotifications(false);
            },
          )
          .subscribe()
      : null;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncNotifications(false);
      }
    }, 30_000);

    return () => {
      active = false;
      mountedRef.current = false;
      clearInterval(timer);
      if (supabase && channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [syncNotifications, userId]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      void syncNotifications(false);
    }
  };

  const handleClickItem = async (item: NotificationRecord) => {
    if (!item.is_read) {
      setItems((prev) =>
        prev.map((row) =>
          row.id === item.id ? { ...row, is_read: true } : row,
        ),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      await markNotificationsReadAction(item.id);
    }

    setIsOpen(false);
    if (role === "kitchen") {
      router.push("/kitchen");
      return;
    }
    if (item.reference_type === "refund") {
      const target =
        role === "admin"
          ? `/admin/transactions?tab=refunds&refundId=${encodeURIComponent(item.reference_id)}`
          : `/pos/orders?tab=refunds&refundId=${encodeURIComponent(item.reference_id)}`;
      router.push(target);
      return;
    }
    if (role === "admin") {
      router.push("/admin/transactions");
    } else {
      router.push("/pos/orders");
    }
  };

  const handleMarkAllRead = async () => {
    const res = await markNotificationsReadAction(null);
    if (res.ok) {
      setItems((prev) => prev.map((row) => ({ ...row, is_read: true })));
      setUnreadCount(0);
    }
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative rounded-lg"
          aria-label="Notifikasi"
        >
          <Bell className="size-4" />
          {unreadCount > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-white tabular-nums">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 sm:w-96 p-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <DropdownMenuLabel className="p-0 text-xs font-bold flex items-center gap-1.5">
            <Bell className="size-3.5 text-primary" />
            Notifikasi
            {unreadCount > 0 ? (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {unreadCount} baru
              </Badge>
            ) : null}
          </DropdownMenuLabel>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={() => void syncNotifications(true)}
              title="Muat ulang notifikasi"
            >
              <RefreshCw
                className={cn("size-3.5", isRefreshing && "animate-spin")}
              />
            </Button>
            {unreadCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] font-semibold text-primary"
                onClick={() => void handleMarkAllRead()}
              >
                <CheckCheck className="size-3.5 mr-1" />
                Tandai dibaca
              </Button>
            ) : null}
          </div>
        </div>
        <DropdownMenuSeparator className="m-0" />

        <div className="max-h-80 overflow-y-auto divide-y">
          {items.length === 0 ? (
            <div className="py-10 px-4 text-center text-xs text-muted-foreground">
              Belum ada notifikasi.
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleClickItem(item)}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60",
                  !item.is_read && "bg-primary/5",
                )}
              >
                {getNotificationIcon(item.type)}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={cn(
                        "text-xs truncate",
                        !item.is_read
                          ? "font-bold text-foreground"
                          : "font-medium text-foreground",
                      )}
                    >
                      {item.title}
                    </p>
                    {!item.is_read ? (
                      <span className="size-2 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">
                    {item.message}
                  </p>
                  <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock3 className="size-2.5" />
                    {formatTimeWib(item.created_at)}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
