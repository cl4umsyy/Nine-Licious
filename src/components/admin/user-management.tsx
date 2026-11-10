"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  EllipsisVertical,
  KeyRound,
  LoaderCircle,
  Power,
  PowerOff,
  Search,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createUserAction,
  resetPasswordAction,
  setUserActiveAction,
} from "@/lib/auth/user-actions";
import { ROLE_LABELS, USER_ROLES, type UserRole } from "@/lib/auth/roles";
import type { UserActionState } from "@/lib/auth/action-types";
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

type UserManagementProps = {
  users: ManagedUser[];
  currentUserId: string;
};

type StatusTarget = {
  user: ManagedUser;
  nextActive: boolean;
};

const initialState: UserActionState = { status: "idle" };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatLastLogin(value: string | null): string {
  if (!value) {
    return "Belum pernah";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return <p className="text-xs text-destructive">{message}</p>;
}

function FormField({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-[0.7rem] text-muted-foreground">{hint}</p> : null}
      <FieldError message={error} />
    </div>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, isPending] = useActionState(
    createUserAction,
    initialState,
  );

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Nama lengkap"
          htmlFor="create-full-name"
          error={state.fieldErrors?.fullName}
        >
          <Input
            id="create-full-name"
            name="fullName"
            placeholder="Contoh: Rani Pratama"
            autoComplete="name"
            required
          />
        </FormField>
        <FormField
          label="Username"
          htmlFor="create-username"
          error={state.fieldErrors?.username}
          hint="Huruf kecil, angka, titik, garis bawah, atau tanda hubung."
        >
          <Input
            id="create-username"
            name="username"
            placeholder="contoh: rani"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </FormField>
      </div>

      <FormField
        label="Peran"
        htmlFor="create-role"
        error={state.fieldErrors?.role}
      >
        <Select name="role" defaultValue="kasir">
          <SelectTrigger id="create-role" className="w-full">
            <SelectValue placeholder="Pilih peran" />
          </SelectTrigger>
          <SelectContent>
            {USER_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABELS[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Password"
          htmlFor="create-password"
          error={state.fieldErrors?.password}
          hint="Minimal 8 karakter, mengandung huruf dan angka."
        >
          <Input
            id="create-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
        </FormField>
        <FormField
          label="Konfirmasi password"
          htmlFor="create-confirm-password"
          error={state.fieldErrors?.confirmPassword}
        >
          <Input
            id="create-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        </FormField>
      </div>

      {state.status === "error" && !state.fieldErrors ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Batal
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <LoaderCircle className="animate-spin" />
              Membuat akun...
            </>
          ) : (
            <>
              <UserPlus />
              Buat pengguna
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ResetPasswordForm({
  user,
  onDone,
}: {
  user: ManagedUser;
  onDone: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    resetPasswordAction,
    initialState,
  );

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="userId" value={user.id} />

      <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Akun <span className="font-medium text-foreground">@{user.username}</span>{" "}
        akan memakai password baru pada login berikutnya.
      </div>

      <FormField
        label="Password baru"
        htmlFor="reset-password"
        error={state.fieldErrors?.password}
        hint="Minimal 8 karakter, mengandung huruf dan angka."
      >
        <Input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
        />
      </FormField>
      <FormField
        label="Konfirmasi password"
        htmlFor="reset-confirm-password"
        error={state.fieldErrors?.confirmPassword}
      >
        <Input
          id="reset-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
        />
      </FormField>

      {state.status === "error" && !state.fieldErrors ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Batal
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <LoaderCircle className="animate-spin" />
              Menyimpan...
            </>
          ) : (
            <>
              <KeyRound />
              Reset password
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function StatusForm({
  target,
  onDone,
}: {
  target: StatusTarget;
  onDone: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    setUserActiveAction,
    initialState,
  );

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="userId" value={target.user.id} />
      <input
        type="hidden"
        name="active"
        value={target.nextActive ? "true" : "false"}
      />

      <div className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
        {target.nextActive ? (
          <>
            <span className="font-medium text-foreground">
              {target.user.full_name}
            </span>{" "}
            akan dapat masuk kembali dan memakai Nine Licious sesuai perannya.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {target.user.full_name}
            </span>{" "}
            tidak akan bisa masuk. Sesi aktif akan ditolak pada permintaan
            berikutnya.
          </>
        )}
      </div>

      {state.status === "error" ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Batal
        </Button>
        <Button
          type="submit"
          variant={target.nextActive ? "default" : "destructive"}
          disabled={isPending}
        >
          {isPending ? (
            <>
              <LoaderCircle className="animate-spin" />
              Memproses...
            </>
          ) : target.nextActive ? (
            <>
              <Power />
              Aktifkan pengguna
            </>
          ) : (
            <>
              <PowerOff />
              Nonaktifkan pengguna
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function roleBadgeVariant(role: UserRole) {
  if (role === "admin") return "default" as const;
  if (role === "kasir") return "secondary" as const;
  return "outline" as const;
}

export function UserManagement({
  users,
  currentUserId,
}: UserManagementProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<ManagedUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [query, setQuery] = useState("");

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return users;
    }

    return users.filter(
      (user) =>
        user.full_name.toLowerCase().includes(normalized) ||
        user.username.toLowerCase().includes(normalized),
    );
  }, [query, users]);

  return (
    <>
      <Card>
        <CardHeader className="gap-3 border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Daftar pengguna</CardTitle>
              <CardDescription>
                {users.length} akun terdaftar. Peran menentukan menu dan akses
                data.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus />
              Tambah pengguna
            </Button>
          </div>

          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cari nama atau username..."
              className="pl-8"
              aria-label="Cari pengguna"
            />
          </div>
        </CardHeader>

        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pengguna</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Terakhir masuk</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Aksi</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center">
                      <p className="text-sm font-medium text-foreground">
                        {users.length === 0
                          ? "Belum ada pengguna"
                          : "Tidak ada pengguna yang cocok"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {users.length === 0
                          ? "Tambahkan akun staf pertama untuk mulai bekerja."
                          : "Coba kata kunci lain."}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-[0.65rem] font-semibold text-primary">
                            {initials(user.full_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                              {user.full_name}
                              {user.id === currentUserId ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1 text-[0.55rem]"
                                >
                                  Anda
                                </Badge>
                              ) : null}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              @{user.username}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={roleBadgeVariant(user.role)}>
                          {ROLE_LABELS[user.role]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            user.is_active
                              ? "border-success/25 bg-success/10 text-success"
                              : "border-border bg-muted text-muted-foreground"
                          }
                        >
                          <span
                            className={
                              user.is_active
                                ? "size-1.5 rounded-full bg-success"
                                : "size-1.5 rounded-full bg-muted-foreground"
                            }
                          />
                          {user.is_active ? "Aktif" : "Nonaktif"}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatLastLogin(user.last_login_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Aksi untuk ${user.full_name}`}
                            >
                              <EllipsisVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuLabel>Aksi akun</DropdownMenuLabel>
                            <DropdownMenuItem
                              onSelect={() => setResetUser(user)}
                            >
                              <KeyRound />
                              Reset password
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {user.id === currentUserId ? (
                              <DropdownMenuItem disabled>
                                <ShieldCheck />
                                Akun Anda sendiri
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant={
                                  user.is_active ? "destructive" : "default"
                                }
                                onSelect={() =>
                                  setStatusTarget({
                                    user,
                                    nextActive: !user.is_active,
                                  })
                                }
                              >
                                {user.is_active ? <PowerOff /> : <Power />}
                                {user.is_active
                                  ? "Nonaktifkan"
                                  : "Aktifkan"}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tambah pengguna</DialogTitle>
            <DialogDescription>
              Buat akun staf baru. Password awal harus diganti melalui admin bila
              diperlukan.
            </DialogDescription>
          </DialogHeader>
          {createOpen ? (
            <CreateUserForm onDone={() => setCreateOpen(false)} />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(resetUser)}
        onOpenChange={(open) => {
          if (!open) setResetUser(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Tetapkan password baru untuk akun yang dipilih.
            </DialogDescription>
          </DialogHeader>
          {resetUser ? (
            <ResetPasswordForm
              user={resetUser}
              onDone={() => setResetUser(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(statusTarget)}
        onOpenChange={(open) => {
          if (!open) setStatusTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {statusTarget?.nextActive
                ? "Aktifkan pengguna"
                : "Nonaktifkan pengguna"}
            </DialogTitle>
            <DialogDescription>
              Perubahan status langsung berlaku dan dicatat di audit log.
            </DialogDescription>
          </DialogHeader>
          {statusTarget ? (
            <StatusForm
              target={statusTarget}
              onDone={() => setStatusTarget(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
