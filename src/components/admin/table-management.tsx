"use client";

import { useMemo, useState } from "react";
import {
  Grid2X2,
  Layers,
  MapPin,
  Table as TableIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FloorPlanCanvas } from "@/components/tables/floor-plan-canvas";
import { TableFormDialog, TableManager } from "@/components/admin/table-manager";
import { ZoneManager } from "@/components/admin/zone-manager";
import {
  publishLayoutAction,
  saveLayoutPositionsAction,
} from "@/lib/tables/actions";
import type { TablePosition, ZoneWithTableCount } from "@/lib/tables/types";
import type { DiningTable, FloorPlan, TableZone } from "@/types/database";

type TableManagementProps = {
  zones: TableZone[];
  tables: DiningTable[];
  floorPlans: FloorPlan[];
};

type TableTab = "floor-plan" | "tables" | "zones";

const TABS: Array<{
  id: TableTab;
  label: string;
  icon: typeof Grid2X2;
}> = [
  { id: "floor-plan", label: "Denah Meja", icon: MapPin },
  { id: "tables", label: "Daftar Meja", icon: TableIcon },
  { id: "zones", label: "Area / Zona", icon: Layers },
];

export function TableManagement({
  zones,
  tables,
  floorPlans,
}: TableManagementProps) {
  const [activeTab, setActiveTab] = useState<TableTab>("floor-plan");
  const [activeZoneId, setActiveZoneId] = useState<string>(
    zones[0]?.id ?? "",
  );
  const [editingTableFromFloor, setEditingTableFromFloor] =
    useState<DiningTable | null>(null);

  const publishedMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const plan of floorPlans) {
      map.set(plan.zone_id, plan.published_at);
    }
    return map;
  }, [floorPlans]);

  const zonesWithCount: ZoneWithTableCount[] = useMemo(() => {
    const totalCountMap = new Map<string, number>();
    const activeCountMap = new Map<string, number>();

    for (const table of tables) {
      totalCountMap.set(
        table.zone_id,
        (totalCountMap.get(table.zone_id) ?? 0) + 1,
      );
      if (table.is_active) {
        activeCountMap.set(
          table.zone_id,
          (activeCountMap.get(table.zone_id) ?? 0) + 1,
        );
      }
    }

    return zones.map((zone) => ({
      ...zone,
      table_count: totalCountMap.get(zone.id) ?? 0,
      active_table_count: activeCountMap.get(zone.id) ?? 0,
    }));
  }, [zones, tables]);

  const stats = useMemo(() => {
    const activeTables = tables.filter((t) => t.is_active);
    const totalCapacity = activeTables.reduce((sum, t) => sum + t.capacity, 0);
    const activeZones = zones.filter((z) => z.is_active);
    const publishedZones = zones.filter((z) => Boolean(publishedMap.get(z.id)));

    return {
      activeTableCount: activeTables.length,
      totalTableCount: tables.length,
      totalCapacity,
      activeZoneCount: activeZones.length,
      totalZoneCount: zones.length,
      publishedZoneCount: publishedZones.length,
    };
  }, [tables, zones, publishedMap]);

  const handleSavePositions = async (
    zoneId: string,
    positions: TablePosition[],
  ) => {
    const result = await saveLayoutPositionsAction(zoneId, positions);
    return {
      ok: result.status === "success",
      message: result.message,
    };
  };

  const handlePublishLayout = async (zoneId: string) => {
    const result = await publishLayoutAction(zoneId);
    return {
      ok: result.status === "success",
      message: result.message,
    };
  };

  return (
    <div className="space-y-5">
      {/* KPI Stats Summary */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Meja aktif</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.activeTableCount}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {stats.totalTableCount} meja
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Meja siap digunakan untuk kunjungan dine-in kasir.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Kapasitas dine-in</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.totalCapacity}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                kursi
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Total daya tampung tamu dari seluruh meja aktif.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Area / Zona</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.activeZoneCount}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {stats.totalZoneCount} area
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Zona meja aktif untuk pengelompokan denah restoran.
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Denah terbit</CardDescription>
            <CardTitle className="font-display text-2xl">
              {stats.publishedZoneCount}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {stats.activeZoneCount} area
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Denah yang sudah diterbitkan dapat dilihat langsung oleh kasir.
          </CardContent>
        </Card>
      </div>

      {/* Tabs navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          let countBadge: number | null = null;
          if (tab.id === "tables") countBadge = tables.length;
          if (tab.id === "zones") countBadge = zones.length;

          return (
            <Button
              key={tab.id}
              type="button"
              variant={isActive ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveTab(tab.id)}
              className={`h-9 px-3.5 text-xs font-medium ${
                isActive
                  ? "bg-primary/10 text-primary font-semibold hover:bg-primary/15"
                  : "text-muted-foreground"
              }`}
            >
              <Icon className="size-4 mr-1.5" />
              {tab.label}
              {countBadge !== null && (
                <Badge
                  variant={isActive ? "default" : "secondary"}
                  className="ml-1.5 h-4 px-1.5 text-[10px]"
                >
                  {countBadge}
                </Badge>
              )}
            </Button>
          );
        })}
      </div>

      {/* Tab Panels */}
      {activeTab === "floor-plan" && (
        <FloorPlanCanvas
          tables={tables}
          zones={zones}
          activeZoneId={activeZoneId}
          onZoneChange={setActiveZoneId}
          publishedAt={publishedMap.get(activeZoneId)}
          interactive={true}
          onSavePositions={handleSavePositions}
          onPublishLayout={handlePublishLayout}
          onEditTable={setEditingTableFromFloor}
        />
      )}

      {activeTab === "tables" && (
        <TableManager tables={tables} zones={zones} />
      )}

      {activeTab === "zones" && <ZoneManager zones={zonesWithCount} />}

      {/* Edit table dialog when triggered from Floor Plan Canvas */}
      {editingTableFromFloor && (
        <TableFormDialog
          table={editingTableFromFloor}
          zones={zones}
          onClose={() => setEditingTableFromFloor(null)}
        />
      )}
    </div>
  );
}
