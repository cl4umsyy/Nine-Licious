import { Database, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { UserManagement } from "@/components/admin/user-management";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { requireRole } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

type ManagedUser = Pick<
  Profile,
  | "id"
  | "username"
  | "full_name"
  | "role"
  | "is_active"
  | "last_login_at"
  | "created_at"
>;

export default async function AdminUsersPage() {
  const session = await requireRole("admin");
  const supabase = await createSupabaseServerClient();

  let users: ManagedUser[] = [];
  let loadError: string | null = null;

  if (!supabase) {
    loadError = "Supabase belum dikonfigurasi.";
  } else {
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "id, username, full_name, role, is_active, last_login_at, created_at",
      )
      .order("created_at", { ascending: true });

    if (error) {
      loadError =
        "Daftar pengguna belum dapat dibaca. Pastikan migrasi database sudah dijalankan.";
    } else {
      users = (data ?? []) as ManagedUser[];
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administrasi"
        title="Pengguna & akses"
        description="Buat akun staf, atur peran, reset password, dan nonaktifkan akses tanpa menghapus riwayat audit."
        actions={
          <Badge variant="outline" className="h-7 px-3">
            {users.length} akun
          </Badge>
        }
      />

      <Alert>
        <ShieldCheck />
        <AlertTitle>Aturan keamanan akun</AlertTitle>
        <AlertDescription>
          Admin tidak dapat menonaktifkan akunnya sendiri, dan admin aktif
          terakhir tidak dapat dinonaktifkan. Semua perubahan dicatat di audit
          log.
        </AlertDescription>
      </Alert>

      {loadError ? (
        <Alert variant="destructive">
          <Database />
          <AlertTitle>Data pengguna tidak tersedia</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : (
        <UserManagement users={users} currentUserId={session.user.id} />
      )}
    </div>
  );
}
