import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { FloorPlanCanvas } from "@/components/tables/floor-plan-canvas";
import { requireRole } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { DiningTable, FloorPlan, TableZone } from "@/types/database";

export default async function PosFloorPage() {
  const session = await requireRole(["admin", "kasir"]);
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
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("dining_tables")
        .select(
          "id, zone_id, name, capacity, position_x, position_y, shape, status, is_active, created_at, updated_at",
        )
        .eq("is_active", true)
        .order("name", { ascending: true }),
      supabase
        .from("floor_plans")
        .select("zone_id, published_at, published_by, created_at, updated_at"),
    ]);

    const firstError =
      zonesResult.error ?? tablesResult.error ?? floorPlansResult.error;

    if (firstError) {
      loadError =
        "Data denah meja belum dapat dibaca. Pastikan migration F1.2 sudah dijalankan.";
    } else {
      zones = (zonesResult.data ?? []) as TableZone[];
      tables = (tablesResult.data ?? []) as DiningTable[];
      floorPlans = (floorPlansResult.data ?? []) as FloorPlan[];
    }
  }

  const publishedMap = new Map<string, string | null>();
  for (const plan of floorPlans) {
    publishedMap.set(plan.zone_id, plan.published_at);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kasir & denah"
        title="Denah Meja Restoran"
        description="Pantau denah meja, kapasitas tamu, dan status ketersediaan meja dine-in secara visual."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/pos">
                <ArrowLeft className="size-3.5 mr-1.5" />
                Kembali ke POS
              </Link>
            </Button>
            <Badge variant="outline" className="h-7 px-3">
              {ROLE_LABELS[session.profile.role]} · {tables.length} meja aktif
            </Badge>
          </div>
        }
      />

      {loadError ? (
        <Alert variant="destructive">
          <Database className="size-4" />
          <AlertTitle>Denah meja belum tersedia</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : zones.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground space-y-2">
          <p className="font-medium text-sm">Belum ada area meja aktif.</p>
          <p className="text-xs">
            Admin belum mengonfigurasi area atau meja untuk restoran.
          </p>
        </div>
      ) : (
        <FloorPlanCanvas
          tables={tables}
          zones={zones}
          publishedAt={publishedMap.get(zones[0]?.id ?? "")}
          interactive={false}
        />
      )}
    </div>
  );
}
