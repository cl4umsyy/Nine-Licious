import { KdsBoard } from "@/components/kds/kds-board";
import { requireRole } from "@/lib/auth/guards";
import { getKdsBoardDataAction } from "@/lib/kds/actions";
import type { KdsBoardData } from "@/lib/kds/types";

export const dynamic = "force-dynamic";

const EMPTY_KDS_DATA: KdsBoardData = {
  tickets: [],
  refundAlerts: [],
  availableStations: ["kitchen", "bar", "dessert"],
  syncedAt: new Date(0).toISOString(),
};

export default async function KitchenPage() {
  const session = await requireRole(["admin", "kitchen"]);
  const result = await getKdsBoardDataAction();

  const initialData: KdsBoardData =
    result.ok && result.data
      ? result.data
      : {
          ...EMPTY_KDS_DATA,
          syncedAt: new Date().toISOString(),
        };

  return (
    <KdsBoard
      initialData={initialData}
      userRole={session.profile.role}
      initialError={result.ok ? null : result.message}
    />
  );
}
