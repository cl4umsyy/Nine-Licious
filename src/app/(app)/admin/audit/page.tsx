import type { Metadata } from "next";
import { AuditExplorer } from "@/components/admin/audit/audit-explorer";
import { getAdminAuditLogsAction } from "@/lib/audit/actions";
import { requireRole } from "@/lib/auth/guards";

export const metadata: Metadata = {
  title: "Audit Explorer | Admin Nine Licious",
  description: "Inspeksi log aktivitas pengguna, mutasi sistem, dan kepatuhan keamanan.",
};

export default async function AdminAuditPage() {
  await requireRole(["admin"]);

  const initialRes = await getAdminAuditLogsAction({
    page: 1,
    pageSize: 20,
  });

  const fallbackData = {
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
    summary: {
      totalEvents: 0,
      distinctUsers: 0,
      distinctActions: 0,
    },
  };

  const initialData = initialRes.ok && initialRes.data ? initialRes.data : fallbackData;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          Audit Explorer
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
          Inspeksi seluruh riwayat aktivitas pengguna, perubahan data sebelum dan sesudah (diff), serta catatan keamanan sistem.
        </p>
      </div>

      <AuditExplorer initialData={initialData} />
    </div>
  );
}
