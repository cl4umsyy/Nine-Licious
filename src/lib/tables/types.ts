import type { DiningTable, TableZone } from "@/types/database";

export type ZoneWithTableCount = TableZone & {
  table_count: number;
  active_table_count: number;
};

export type PublishedPlanByZone = Record<string, string | null>;

export type TablePosition = {
  id: string;
  x: number;
  y: number;
};

export type FloorPlanTable = Pick<
  DiningTable,
  | "id"
  | "zone_id"
  | "name"
  | "capacity"
  | "position_x"
  | "position_y"
  | "shape"
  | "status"
  | "is_active"
>;
