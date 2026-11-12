import { Database } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { TableManagement } from "@/components/admin/table-management";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { DiningTable, FloorPlan, TableZone } from "@/types/database";

export default async function AdminTablesPage() {
  await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  let zones: TableZone[] = [];
  let tables: DiningTable[] = [];
  let floorPlans: FloorPlan[] = [];
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    const [zonesResult, tablesResult, floorPlansResult] = await Promise.all([
      supabase
        .from("table_zones")
        .select("id, name, sort_order, is_active, created_at, updated_at")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("dining_tables")
        .select(
          "id, zone_id, name, capacity, position_x, position_y, shape, status, is_active, created_at, updated_at",
        )
        .order("name", { ascending: true }),
      supabase
        .from("floor_plans")
        .select("zone_id, published_at, published_by, created_at, updated_at"),
    ]);

    const firstError =
      zonesResult.error ?? tablesResult.error ?? floorPlansResult.error;

    if (firstError) {
      loadError =
        "Data meja dan denah belum dapat dibaca. Pastikan migration F1.2 (20261111000200_tables_layout.sql) sudah dijalankan di Supabase.";
    } else {
      zones = (zonesResult.data ?? []) as TableZone[];
      tables = (tablesResult.data ?? []) as DiningTable[];
      floorPlans = (floorPlansResult.data ?? []) as FloorPlan[];
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Master data & denah"
        title="Meja & Denah"
        description="Kelola area, nomor meja, kapasitas, bentuk, dan susun denah restoran interaktif dengan drag-and-drop. Layout yang diterbitkan dapat langsung dilihat kasir."
        actions={
          <Badge variant="outline" className="h-7 px-3">
            {tables.length} meja · {zones.length} area
          </Badge>
        }
      />

      {loadError ? (
        <Alert variant="destructive">
          <Database className="size-4" />
          <AlertTitle>Data meja & denah tidak tersedia</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : (
        <TableManagement
          zones={zones}
          tables={tables}
          floorPlans={floorPlans}
        />
      )}
    </div>
  );
}
