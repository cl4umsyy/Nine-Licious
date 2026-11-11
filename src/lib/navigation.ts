import {
  ChefHat,
  LayoutDashboard,
  MonitorPlay,
  ShoppingCart,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import type { UserRole } from "@/lib/auth/roles";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  roles: UserRole[];
  newTab?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/admin",
    label: "Ringkasan",
    description: "Kondisi sistem dan aktivitas hari ini.",
    icon: LayoutDashboard,
    roles: ["admin"],
  },
  {
    href: "/admin/menu",
    label: "Menu",
    description: "Kategori, produk, modifier, dan ketersediaan.",
    icon: UtensilsCrossed,
    roles: ["admin"],
  },
  {
    href: "/admin/users",
    label: "Pengguna",
    description: "Kelola akun dan hak akses staf.",
    icon: Users,
    roles: ["admin"],
  },
  {
    href: "/pos",
    label: "Kasir",
    description: "Transaksi, meja, dan pembayaran.",
    icon: ShoppingCart,
    roles: ["admin", "kasir"],
  },
  {
    href: "/kitchen",
    label: "Dapur",
    description: "Antrean pesanan dan status masak.",
    icon: ChefHat,
    roles: ["admin", "kitchen"],
  },
  {
    href: "/queue",
    label: "Papan Antrean",
    description: "Tampilan publik untuk pelanggan.",
    icon: MonitorPlay,
    roles: ["admin", "kasir", "kitchen"],
    newTab: true,
  },
];

export function navItemsForRole(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export function pageMetaForPath(pathname: string): NavItem | null {
  const matches = NAV_ITEMS.filter(
    (item) =>
      pathname === item.href || pathname.startsWith(`${item.href}/`),
  ).sort((a, b) => b.href.length - a.href.length);

  return matches[0] ?? null;
}
