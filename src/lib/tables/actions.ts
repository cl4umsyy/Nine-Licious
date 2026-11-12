"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/auth/audit";
import {
  getAdminActor,
  type AuthenticatedSession,
} from "@/lib/auth/session";
import {
  FLOOR_PLAN_HEIGHT,
  FLOOR_PLAN_WIDTH,
  tableDimensions,
} from "@/lib/tables/constants";
import type { TableActionState } from "@/lib/tables/action-types";
import {
  diningTableSchema,
  fieldErrorsFrom,
  firstZodError,
  formBoolean,
  tableIdSchema,
  tablePositionsSchema,
  zoneSchema,
} from "@/lib/tables/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ActionContext = {
  actor: AuthenticatedSession;
  supabase: SupabaseClient;
};

type ZoneRow = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
};

type TableRow = {
  id: string;
  zone_id: string;
  name: string;
  capacity: number;
  position_x: number;
  position_y: number;
  shape: "rectangle" | "round";
  status: string;
  is_active: boolean;
};

const zoneDuplicate = {
  constraint: "table_zones_name_unique_idx",
  field: "name",
  message: "Nama area sudah digunakan.",
};

const tableDuplicate = {
  constraint: "dining_tables_name_unique_idx",
  field: "name",
  message: "Nomor/nama meja sudah digunakan.",
};

function errorState(
  message: string,
  fieldErrors?: Record<string, string>,
): TableActionState {
  return { status: "error", message, fieldErrors };
}

function successState(message: string): TableActionState {
  return { status: "success", message };
}

async function getActionContext(): Promise<
  { ok: true; context: ActionContext } | { ok: false; state: TableActionState }
> {
  const actor = await getAdminActor();

  if (!actor.ok) {
    return { ok: false, state: errorState(actor.message) };
  }

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return {
      ok: false,
      state: errorState("Supabase belum dikonfigurasi."),
    };
  }

  return {
    ok: true,
    context: { actor: actor.session, supabase },
  };
}

function parseId(value: string): string | null {
  const parsed = tableIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function dbErrorState(
  error: { code?: string; message: string },
  entityLabel: string,
  duplicates: Array<{
    constraint: string;
    field: string;
    message: string;
  }> = [],
  foreignKeyMessage?: string,
): TableActionState {
  if (error.code === "23505") {
    const duplicate = duplicates.find((item) =>
      error.message.includes(item.constraint),
    );

    if (duplicate) {
      return errorState(duplicate.message, {
        [duplicate.field]: duplicate.message,
      });
    }

    return errorState(`Data ${entityLabel} sudah digunakan.`);
  }

  if (error.code === "23503") {
    return errorState(
      foreignKeyMessage ??
        `${entityLabel} masih dipakai data lain dan tidak dapat dihapus.`,
    );
  }

  if (error.code === "23514") {
    return errorState(`Data ${entityLabel} tidak valid.`);
  }

  if (error.message.includes("meja aktif")) {
    return errorState(error.message);
  }

  console.error(`[tables] Gagal memproses ${entityLabel}:`, error.message);

  return errorState(`Gagal memproses ${entityLabel}. Silakan coba lagi.`);
}

async function writeAudit(
  context: ActionContext,
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    userId: context.actor.user.id,
    username: context.actor.profile.username,
    entity,
    entityId,
    details,
  });
}

function revalidateFloorPaths(): void {
  revalidatePath("/admin/tables");
  revalidatePath("/pos/floor");
  revalidatePath("/pos");
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Zona/area
// ---------------------------------------------------------------------------

export async function saveZoneAction(
  _previousState: TableActionState,
  formData: FormData,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const zoneId = idValue ? parseId(idValue) : null;

  if (idValue && !zoneId) {
    return errorState("Area tidak valid.");
  }

  const parsed = zoneSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    sortOrder: String(formData.get("sortOrder") ?? "0"),
    isActive: formBoolean(formData.get("isActive")),
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const payload = {
    name: parsed.data.name,
    sort_order: parsed.data.sortOrder,
    is_active: parsed.data.isActive,
  };

  if (zoneId) {
    const { data, error } = await context.supabase
      .from("table_zones")
      .update(payload)
      .eq("id", zoneId)
      .select("id, name")
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      return dbErrorState(error, "area", [zoneDuplicate]);
    }

    if (!data) {
      return errorState("Area tidak ditemukan.");
    }

    await writeAudit(context, "table_zone.update", "table_zone", data.id, {
      name: data.name,
      sort_order: payload.sort_order,
      is_active: payload.is_active,
    });

    revalidateFloorPaths();
    return successState(`Area ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("table_zones")
    .insert(payload)
    .select("id, name")
    .single<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(error, "area", [zoneDuplicate]);
  }

  await writeAudit(context, "table_zone.create", "table_zone", data.id, {
    name: data.name,
    sort_order: payload.sort_order,
    is_active: payload.is_active,
  });

  revalidateFloorPaths();
  return successState(`Area ${data.name} berhasil dibuat.`);
}

export async function setZoneActiveAction(
  zoneId: string,
  isActive: boolean,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(zoneId);

  if (!id || typeof isActive !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;

  if (!isActive) {
    const { count, error: countError } = await context.supabase
      .from("dining_tables")
      .select("id", { count: "exact", head: true })
      .eq("zone_id", id)
      .eq("is_active", true);

    if (countError) {
      return dbErrorState(countError, "area");
    }

    if ((count ?? 0) > 0) {
      return errorState(
        `Area masih memiliki ${count} meja aktif. Nonaktifkan atau pindahkan meja terlebih dahulu.`,
      );
    }
  }

  const { data, error } = await context.supabase
    .from("table_zones")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, is_active")
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (error) {
    return dbErrorState(error, "status area");
  }

  if (!data) {
    return errorState("Area tidak ditemukan.");
  }

  await writeAudit(context, "table_zone.status", "table_zone", data.id, {
    name: data.name,
    is_active: data.is_active,
  });

  revalidateFloorPaths();
  return successState(
    `Area ${data.name} ${data.is_active ? "diaktifkan" : "dinonaktifkan"}.`,
  );
}

export async function moveZoneAction(
  zoneId: string,
  direction: "up" | "down",
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(zoneId);

  if (!id || (direction !== "up" && direction !== "down")) {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("table_zones")
    .select("id, name, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return dbErrorState(error, "urutan area");
  }

  const zones = (data ?? []) as ZoneRow[];
  const index = zones.findIndex((zone) => zone.id === id);

  if (index === -1) {
    return errorState("Area tidak ditemukan.");
  }

  const neighborIndex = direction === "up" ? index - 1 : index + 1;

  if (neighborIndex < 0 || neighborIndex >= zones.length) {
    return successState(
      `Area sudah berada di urutan paling ${direction === "up" ? "atas" : "bawah"}.`,
    );
  }

  const current = zones[index];
  const neighbor = zones[neighborIndex];
  let currentOrder = neighbor.sort_order;
  let neighborOrder = current.sort_order;

  if (currentOrder === neighborOrder) {
    currentOrder = (neighborIndex + 1) * 10;
    neighborOrder = (index + 1) * 10;
  }

  const { error: currentError } = await context.supabase
    .from("table_zones")
    .update({ sort_order: currentOrder })
    .eq("id", current.id);

  if (currentError) {
    return dbErrorState(currentError, "urutan area");
  }

  const { error: neighborError } = await context.supabase
    .from("table_zones")
    .update({ sort_order: neighborOrder })
    .eq("id", neighbor.id);

  if (neighborError) {
    return dbErrorState(neighborError, "urutan area");
  }

  await writeAudit(context, "table_zone.reorder", "table_zone", current.id, {
    name: current.name,
    direction,
    swapped_with: neighbor.name,
    sort_order: currentOrder,
  });

  revalidateFloorPaths();
  return successState(`Urutan area ${current.name} diperbarui.`);
}

export async function deleteZoneAction(
  zoneId: string,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(zoneId);

  if (!id) {
    return errorState("Area tidak valid.");
  }

  const { context } = contextResult;

  const { count: totalZones, error: totalZonesError } = await context.supabase
    .from("table_zones")
    .select("id", { count: "exact", head: true });

  if (totalZonesError) {
    return dbErrorState(totalZonesError, "area");
  }

  if ((totalZones ?? 0) <= 1) {
    return errorState("Restoran harus memiliki minimal satu area aktif.");
  }

  const { count, error: countError } = await context.supabase
    .from("dining_tables")
    .select("id", { count: "exact", head: true })
    .eq("zone_id", id);

  if (countError) {
    return dbErrorState(countError, "area");
  }

  if ((count ?? 0) > 0) {
    return errorState(
      `Area masih memiliki ${count} meja. Pindahkan atau hapus meja terlebih dahulu.`,
    );
  }

  const { data, error } = await context.supabase
    .from("table_zones")
    .delete()
    .eq("id", id)
    .select("id, name")
    .maybeSingle<{ id: string; name: string }>();

  if (error) {
    return dbErrorState(
      error,
      "area",
      [],
      "Area masih dipakai meja dan tidak dapat dihapus.",
    );
  }

  if (!data) {
    return errorState("Area tidak ditemukan.");
  }

  await writeAudit(context, "table_zone.delete", "table_zone", data.id, {
    name: data.name,
  });

  revalidateFloorPaths();
  return successState(`Area ${data.name} dihapus.`);
}

// ---------------------------------------------------------------------------
// Meja
// ---------------------------------------------------------------------------

export async function saveTableAction(
  _previousState: TableActionState,
  formData: FormData,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const { context } = contextResult;
  const idValue = String(formData.get("id") ?? "").trim();
  const tableId = idValue ? parseId(idValue) : null;

  if (idValue && !tableId) {
    return errorState("Meja tidak valid.");
  }

  const parsed = diningTableSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    zoneId: String(formData.get("zoneId") ?? ""),
    capacity: String(formData.get("capacity") || "2"),
    positionX: String(formData.get("positionX") || "0"),
    positionY: String(formData.get("positionY") || "0"),
    shape: String(formData.get("shape") || "rectangle"),
    isActive: formBoolean(formData.get("isActive")),
  });

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error), fieldErrorsFrom(parsed.error));
  }

  const { data: zone, error: zoneError } = await context.supabase
    .from("table_zones")
    .select("id, name, is_active")
    .eq("id", parsed.data.zoneId)
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (zoneError) {
    return dbErrorState(zoneError, "area");
  }

  if (!zone) {
    return errorState("Area tidak ditemukan.", {
      zoneId: "Pilih area yang tersedia.",
    });
  }

  if (!zone.is_active) {
    return errorState("Area tidak aktif. Aktifkan area terlebih dahulu.", {
      zoneId: "Area tidak aktif.",
    });
  }

  const payload = {
    zone_id: parsed.data.zoneId,
    name: parsed.data.name,
    capacity: parsed.data.capacity,
    position_x: parsed.data.positionX,
    position_y: parsed.data.positionY,
    shape: parsed.data.shape,
    is_active: parsed.data.isActive,
  };

  if (tableId) {
    const { data, error } = await context.supabase
      .from("dining_tables")
      .update(payload)
      .eq("id", tableId)
      .select("id, name, zone_id")
      .maybeSingle<{ id: string; name: string; zone_id: string }>();

    if (error) {
      return dbErrorState(error, "meja", [tableDuplicate]);
    }

    if (!data) {
      return errorState("Meja tidak ditemukan.");
    }

    await writeAudit(context, "dining_table.update", "dining_table", data.id, {
      name: data.name,
      zone_id: data.zone_id,
      zone_name: zone.name,
      capacity: payload.capacity,
      position_x: payload.position_x,
      position_y: payload.position_y,
      shape: payload.shape,
      is_active: payload.is_active,
    });

    revalidateFloorPaths();
    return successState(`Meja ${data.name} berhasil diperbarui.`);
  }

  const { data, error } = await context.supabase
    .from("dining_tables")
    .insert(payload)
    .select("id, name, zone_id")
    .single<{ id: string; name: string; zone_id: string }>();

  if (error) {
    return dbErrorState(error, "meja", [tableDuplicate]);
  }

  await writeAudit(context, "dining_table.create", "dining_table", data.id, {
    name: data.name,
    zone_id: data.zone_id,
    zone_name: zone.name,
    capacity: payload.capacity,
    position_x: payload.position_x,
    position_y: payload.position_y,
    shape: payload.shape,
    is_active: payload.is_active,
  });

  revalidateFloorPaths();
  return successState(`Meja ${data.name} berhasil dibuat.`);
}

export async function setTableActiveAction(
  tableId: string,
  isActive: boolean,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(tableId);

  if (!id || typeof isActive !== "boolean") {
    return errorState("Permintaan tidak valid.");
  }

  const { context } = contextResult;
  const { data, error } = await context.supabase
    .from("dining_tables")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, is_active")
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();

  if (error) {
    return dbErrorState(error, "status meja");
  }

  if (!data) {
    return errorState("Meja tidak ditemukan.");
  }

  await writeAudit(context, "dining_table.status", "dining_table", data.id, {
    name: data.name,
    is_active: data.is_active,
  });

  revalidateFloorPaths();
  return successState(
    `Meja ${data.name} ${data.is_active ? "diaktifkan" : "dinonaktifkan"}.`,
  );
}

export async function deleteTableAction(
  tableId: string,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(tableId);

  if (!id) {
    return errorState("Meja tidak valid.");
  }

  const { context } = contextResult;

  const { data: existingTable, error: fetchError } = await context.supabase
    .from("dining_tables")
    .select("id, name, status, zone_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; status: string; zone_id: string }>();

  if (fetchError) {
    return dbErrorState(fetchError, "meja");
  }

  if (!existingTable) {
    return errorState("Meja tidak ditemukan.");
  }

  if (existingTable.status !== "empty") {
    return errorState(
      `Meja ${existingTable.name} sedang digunakan dan tidak dapat dihapus. Kosongkan meja terlebih dahulu.`,
    );
  }

  const { data, error } = await context.supabase
    .from("dining_tables")
    .delete()
    .eq("id", id)
    .select("id, name, zone_id")
    .maybeSingle<{ id: string; name: string; zone_id: string }>();

  if (error) {
    return dbErrorState(
      error,
      "meja",
      [],
      "Meja sudah memiliki riwayat transaksi dan tidak dapat dihapus. Nonaktifkan meja agar riwayat tetap utuh.",
    );
  }

  if (!data) {
    return errorState("Meja tidak ditemukan.");
  }

  await writeAudit(context, "dining_table.delete", "dining_table", data.id, {
    name: data.name,
    zone_id: data.zone_id,
  });

  revalidateFloorPaths();
  return successState(`Meja ${data.name} dihapus.`);
}

// ---------------------------------------------------------------------------
// Denah
// ---------------------------------------------------------------------------

export async function saveLayoutPositionsAction(
  zoneId: string,
  positions: Array<{ id: string; x: number; y: number }>,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(zoneId);

  if (!id) {
    return errorState("Area tidak valid.");
  }

  const parsed = tablePositionsSchema.safeParse(positions);

  if (!parsed.success) {
    return errorState(firstZodError(parsed.error));
  }

  const uniqueIds = new Set(parsed.data.map((position) => position.id));
  if (uniqueIds.size !== parsed.data.length) {
    return errorState("Terdapat duplikasi ID meja dalam posisi yang dikirim.");
  }

  const { context } = contextResult;
  const { data: zone, error: zoneError } = await context.supabase
    .from("table_zones")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string }>();

  if (zoneError) {
    return dbErrorState(zoneError, "area");
  }

  if (!zone) {
    return errorState("Area tidak ditemukan.");
  }

  const tableIds = parsed.data.map((position) => position.id);
  const { data: tableData, error: tableError } = await context.supabase
    .from("dining_tables")
    .select("id, name, capacity, shape, zone_id")
    .eq("zone_id", zone.id)
    .in("id", tableIds);

  if (tableError) {
    return dbErrorState(tableError, "meja");
  }

  const tables = (tableData ?? []) as TableRow[];
  const tableById = new Map(tables.map((table) => [table.id, table]));

  for (const position of parsed.data) {
    const table = tableById.get(position.id);

    if (!table) {
      return errorState(
        "Ada meja yang bukan bagian dari area ini. Muat ulang denah lalu coba lagi.",
      );
    }

    const size = tableDimensions(table.capacity, table.shape);

    if (
      position.x + size.width > FLOOR_PLAN_WIDTH ||
      position.y + size.height > FLOOR_PLAN_HEIGHT
    ) {
      return errorState(
        `Posisi meja ${table.name} melewati batas denah.`,
      );
    }
  }

  // Coba eksekusi pembaruan posisi secara atomik via RPC function PostgreSQL.
  // Memastikan transaksi all-or-nothing (tidak terjadi partial update bila terjadi kegagalan).
  const { error: rpcError } = await context.supabase.rpc(
    "update_table_positions",
    {
      p_zone_id: zone.id,
      p_positions: parsed.data,
    },
  );

  if (rpcError) {
    // Fallback: Jika migration function belum diterapkan (PGRST202), gunakan per-baris
    if (
      rpcError.code === "PGRST202" ||
      rpcError.message.includes("update_table_positions")
    ) {
      for (const position of parsed.data) {
        const { error } = await context.supabase
          .from("dining_tables")
          .update({
            position_x: position.x,
            position_y: position.y,
          })
          .eq("id", position.id)
          .eq("zone_id", zone.id);

        if (error) {
          return dbErrorState(error, "posisi meja");
        }
      }
    } else {
      return dbErrorState(rpcError, "posisi meja");
    }
  }

  await writeAudit(context, "floor_layout.save", "floor_layout", zone.id, {
    zone_name: zone.name,
    table_count: parsed.data.length,
    table_ids: tableIds,
  });

  revalidateFloorPaths();
  return successState(
    `Posisi ${parsed.data.length} meja di area ${zone.name} disimpan.`,
  );
}

export async function publishLayoutAction(
  zoneId: string,
): Promise<TableActionState> {
  const contextResult = await getActionContext();

  if (!contextResult.ok) {
    return contextResult.state;
  }

  const id = parseId(zoneId);

  if (!id) {
    return errorState("Area tidak valid.");
  }

  const { context } = contextResult;
  const { data: zone, error: zoneError } = await context.supabase
    .from("table_zones")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string }>();

  if (zoneError) {
    return dbErrorState(zoneError, "area");
  }

  if (!zone) {
    return errorState("Area tidak ditemukan.");
  }

  const { count, error: countError } = await context.supabase
    .from("dining_tables")
    .select("id", { count: "exact", head: true })
    .eq("zone_id", zone.id)
    .eq("is_active", true);

  if (countError) {
    return dbErrorState(countError, "meja");
  }

  if ((count ?? 0) === 0) {
    return errorState(
      "Area belum memiliki meja aktif. Tambahkan meja sebelum menerbitkan layout.",
    );
  }

  const { error } = await context.supabase.from("floor_plans").upsert(
    {
      zone_id: zone.id,
      published_at: new Date().toISOString(),
      published_by: context.actor.user.id,
    },
    { onConflict: "zone_id" },
  );

  if (error) {
    return dbErrorState(error, "layout");
  }

  await writeAudit(context, "floor_layout.publish", "floor_layout", zone.id, {
    zone_name: zone.name,
    table_count: count,
  });

  revalidateFloorPaths();
  return successState(`Layout area ${zone.name} diterbitkan.`);
}
