"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChefHat,
  CreditCard,
  Eye,
  FileImage,
  FileWarning,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatRupiah } from "@/lib/menu/format";
import { confirmMidtransRefundAction } from "@/lib/payments/actions";
import {
  approveOrderRefundAction,
  attachRefundEvidenceAction,
  cancelOrderRefundAction,
  completeRefundManualFallbackAction,
  getRefundDetailAction,
  getRefundManagementListAction,
  recordRefundCorrectionAction,
  rejectOrderRefundAction,
  requestRefundEvidenceAction,
} from "@/lib/refunds/actions";
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  APPROVAL_STATUS_LABELS,
  INVENTORY_ACTION_LABELS,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
  PAYOUT_STATUS_LABELS,
  REFUND_REASON_CATEGORY_LABELS,
  REFUND_RESOLUTION_LABELS,
  REPLACEMENT_STATUS_LABELS,
  type RefundDetailData,
  type RefundListItem,
  type RefundQueueSummary,
} from "@/lib/refunds/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { RefundPayoutMethod } from "@/types/database";

type RefundManagementPanelProps = {
  userRole: string;
  currentUserId?: string;
  initialFocusRefundId?: string | null;
  onMutated?: () => void;
};

const WIB_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDateTimeWib(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${WIB_FORMATTER.format(d)} WIB`;
}

function getApprovalBadgeClass(status: string): string {
  switch (status) {
    case "pending_approval":
      return "bg-amber-50 text-amber-800 border-amber-300";
    case "approved":
      return "bg-emerald-50 text-emerald-700 border-emerald-300";
    case "rejected":
    case "cancelled":
      return "bg-rose-50 text-rose-700 border-rose-300";
    default:
      return "bg-muted text-foreground";
  }
}

function getPayoutBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-50 text-emerald-700 border-emerald-300";
    case "pending":
    case "processing":
      return "bg-blue-50 text-blue-700 border-blue-300";
    case "failed":
    case "reconciliation_required":
      return "bg-rose-50 text-rose-700 border-rose-300";
    default:
      return "bg-slate-100 text-slate-700 border-slate-300";
  }
}

function sanitizeFile(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "evidence";
}

export function RefundManagementPanel({
  userRole,
  currentUserId,
  initialFocusRefundId = null,
  onMutated,
}: RefundManagementPanelProps) {
  const isAdmin = userRole === "admin";

  const [items, setItems] = useState<RefundListItem[]>([]);
  const [summary, setSummary] = useState<RefundQueueSummary>({
    totalCount: 0,
    pendingApprovalCount: 0,
    midtransPendingCount: 0,
    replacementActiveCount: 0,
    completedFinancialTotal: 0,
  });
  const [approvalFilter, setApprovalFilter] = useState("all");
  const [resolutionFilter, setResolutionFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const [detailData, setDetailData] = useState<RefundDetailData | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await getRefundManagementListAction({
        approvalStatus: approvalFilter,
        resolutionType: resolutionFilter,
        search,
      });
      if (res.ok) {
        setItems(res.data.items);
        setSummary(res.data.summary);
      } else {
        toast.error(res.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [approvalFilter, resolutionFilter, search]);

  const openDetail = useCallback(async (refundId: string) => {
    setIsDetailOpen(true);
    setIsDetailLoading(true);
    try {
      const res = await getRefundDetailAction(refundId);
      if (res.ok) {
        setDetailData(res.data);
        setDetailRevision((v) => v + 1);
      } else {
        toast.error(res.message);
        setIsDetailOpen(false);
      }
    } finally {
      setIsDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getRefundManagementListAction({
      approvalStatus: approvalFilter,
      resolutionType: resolutionFilter,
      search,
    }).then((res) => {
      if (!active) return;
      setIsLoading(false);
      if (res.ok) {
        setItems(res.data.items);
        setSummary(res.data.summary);
      }
    });
    return () => {
      active = false;
    };
  }, [approvalFilter, resolutionFilter, search]);

  useEffect(() => {
    if (!initialFocusRefundId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      void openDetail(initialFocusRefundId);
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [initialFocusRefundId, openDetail]);

  const handleAfterMutation = async (refundId?: string) => {
    await loadList();
    if (refundId && isDetailOpen) {
      await openDetail(refundId);
    }
    onMutated?.();
  };

  return (
    <div className="space-y-4">
      {/* KPI Ringkas Antrean Refund */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="rounded-2xl border-amber-200 bg-amber-50/40">
          <CardHeader className="p-3.5 pb-1.5">
            <CardDescription className="text-xs font-semibold text-amber-900">
              Menunggu Persetujuan
            </CardDescription>
            <CardTitle className="text-xl font-bold font-mono text-amber-800">
              {summary.pendingApprovalCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-2xl border-blue-200 bg-blue-50/40">
          <CardHeader className="p-3.5 pb-1.5">
            <CardDescription className="text-xs font-semibold text-blue-900">
              Pending Gateway Midtrans
            </CardDescription>
            <CardTitle className="text-xl font-bold font-mono text-blue-800">
              {summary.midtransPendingCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-2xl border-primary/20 bg-primary/5">
          <CardHeader className="p-3.5 pb-1.5">
            <CardDescription className="text-xs font-semibold text-primary">
              Replacement Aktif
            </CardDescription>
            <CardTitle className="text-xl font-bold font-mono text-primary">
              {summary.replacementActiveCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="p-3.5 pb-1.5">
            <CardDescription className="text-xs font-medium">
              Refund Finansial Selesai
            </CardDescription>
            <CardTitle className="text-xl font-bold font-mono text-rose-600">
              {formatRupiah(summary.completedFinancialTotal)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filter Bar */}
      <Card className="rounded-2xl">
        <CardHeader className="p-4 pb-3 border-b space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nomor refund, order, atau pengaju..."
                className="pl-9 h-9 text-xs rounded-xl"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={approvalFilter}
                onValueChange={setApprovalFilter}
              >
                <SelectTrigger className="h-9 w-48 text-xs rounded-xl">
                  <SelectValue placeholder="Status Approval" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Status Approval</SelectItem>
                  <SelectItem value="pending_approval">
                    Menunggu Persetujuan
                  </SelectItem>
                  <SelectItem value="approved">Disetujui</SelectItem>
                  <SelectItem value="rejected">Ditolak</SelectItem>
                  <SelectItem value="cancelled">Dibatalkan</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={resolutionFilter}
                onValueChange={setResolutionFilter}
              >
                <SelectTrigger className="h-9 w-44 text-xs rounded-xl">
                  <SelectValue placeholder="Jenis Penyelesaian" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Semua Penyelesaian</SelectItem>
                  <SelectItem value="full_refund">Full Refund</SelectItem>
                  <SelectItem value="partial_refund">Partial Refund</SelectItem>
                  <SelectItem value="replacement">Replacement</SelectItem>
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadList()}
                disabled={isLoading}
                className="h-9 rounded-xl text-xs gap-1.5"
              >
                <RefreshCw
                  className={isLoading ? "size-3.5 animate-spin" : "size-3.5"}
                />
                Segarkan
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              Memuat antrean pengajuan refund...
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              Belum ada pengajuan refund atau replacement yang cocok dengan filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs bg-muted/30">
                    <TableHead>Nomor &amp; Waktu</TableHead>
                    <TableHead>Transaksi</TableHead>
                    <TableHead>Penyelesaian &amp; Alasan</TableHead>
                    <TableHead className="text-right">Nominal</TableHead>
                    <TableHead>Status Approval &amp; Pencairan</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs">
                  {items.map((item) => (
                    <TableRow key={item.id} className="hover:bg-muted/20">
                      <TableCell className="whitespace-nowrap">
                        <p className="font-mono font-bold text-foreground">
                          {item.refundNumber}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {formatDateTimeWib(item.createdAt)}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <p className="font-mono font-semibold text-primary">
                          #{item.orderNumber}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          Pengaju: {item.requesterName}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="flex flex-wrap items-center gap-1 mb-0.5">
                          <Badge variant="outline" className="text-[10px]">
                            {REFUND_RESOLUTION_LABELS[item.resolutionType]}
                          </Badge>
                          {item.evidenceCount > 0 ? (
                            <Badge
                              variant="secondary"
                              className="text-[10px] gap-1"
                            >
                              <FileImage className="size-2.5" />
                              {item.evidenceCount} bukti
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-foreground" title={item.reason}>
                          {item.reason}
                        </p>
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold whitespace-nowrap">
                        {item.resolutionType === "replacement" ? (
                          <span className="text-primary">Rp 0 (KDS)</span>
                        ) : (
                          <span className="text-rose-600">
                            {formatRupiah(item.amount)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="space-y-1">
                        <div>
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-semibold ${getApprovalBadgeClass(item.approvalStatus)}`}
                          >
                            {APPROVAL_STATUS_LABELS[item.approvalStatus]}
                          </Badge>
                        </div>
                        {item.resolutionType === "replacement" &&
                        item.replacementStatus ? (
                          <div>
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-primary/10 text-primary border-primary/30 gap-1"
                            >
                              <ChefHat className="size-2.5" />
                              {REPLACEMENT_STATUS_LABELS[item.replacementStatus]}
                              {item.replacementOrderNumber
                                ? ` · ${item.replacementOrderNumber}`
                                : ""}
                            </Badge>
                          </div>
                        ) : item.approvalStatus === "approved" ? (
                          <div>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${getPayoutBadgeClass(item.payoutStatus)}`}
                            >
                              {PAYOUT_STATUS_LABELS[item.payoutStatus]}
                            </Badge>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          type="button"
                          variant={
                            isAdmin &&
                            item.approvalStatus === "pending_approval"
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                          onClick={() => void openDetail(item.id)}
                          className="h-8 rounded-xl text-xs gap-1"
                        >
                          <Eye className="size-3.5" />
                          {isAdmin &&
                          item.approvalStatus === "pending_approval"
                            ? "Tinjau"
                            : "Detail"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog Detail & Tindakan Refund */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="w-[min(100%-1.5rem,900px)] sm:max-w-[900px] max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden rounded-2xl">
          <RefundDetailDialogBody
            key={`${detailData?.id ?? "loading"}-${detailRevision}`}
            isLoading={isDetailLoading}
            detail={detailData}
            isAdmin={isAdmin}
            currentUserId={currentUserId}
            onClose={() => setIsDetailOpen(false)}
            onMutated={(id) => void handleAfterMutation(id)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RefundDetailDialogBody({
  isLoading,
  detail,
  isAdmin,
  currentUserId,
  onClose,
  onMutated,
}: {
  isLoading: boolean;
  detail: RefundDetailData | null;
  isAdmin: boolean;
  currentUserId?: string;
  onClose: () => void;
  onMutated: (refundId?: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  // Admin approval state
  const [approvalNotes, setApprovalNotes] = useState("");
  const [shiftId, setShiftId] = useState("auto");
  const [actionMode, setActionMode] = useState<
    | "view"
    | "approve"
    | "reject"
    | "cancel"
    | "request_evidence"
    | "confirm_midtrans"
    | "manual_fallback"
    | "correct"
  >("view");
  const [reasonInput, setReasonInput] = useState("");
  const [gatewayRefundId, setGatewayRefundId] = useState("");
  const [payoutRef, setPayoutRef] = useState("");

  // Correction state
  const [expectedAmt, setExpectedAmt] = useState(() =>
    detail ? String(detail.amount) : ""
  );
  const [actualAmt, setActualAmt] = useState("");
  const [createSupp, setCreateSupp] = useState(false);
  const [suppMethod, setSuppMethod] =
    useState<RefundPayoutMethod>("cash");

  if (isLoading || !detail) {
    return (
      <>
        <DialogHeader className="p-5 border-b">
          <DialogTitle className="text-base">Memuat Detail Refund...</DialogTitle>
        </DialogHeader>
        <div className="p-12 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          Mengambil data refund, alokasi, dan bukti...
        </div>
      </>
    );
  }

  const isOwnerKasir =
    !isAdmin &&
    currentUserId !== undefined &&
    detail.requestedBy === currentUserId;
  const canKasirCancelOwn =
    isOwnerKasir && detail.approvalStatus === "pending_approval";
  const canAdminCancel =
    isAdmin &&
    (detail.approvalStatus === "pending_approval" ||
      (detail.approvalStatus === "approved" &&
        detail.payoutStatus !== "completed" &&
        detail.payoutStatus !== "processing" &&
        detail.payoutStatus !== "reconciliation_required"));

  const pendingMidtransAllocs = detail.allocations.filter(
    (a) =>
      a.payoutMethod === "midtrans" &&
      ["pending", "processing", "failed", "reconciliation_required"].includes(
        a.payoutStatus,
      ),
  );

  const handleUploadEvidence = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Sesi pengguna tidak valid.");
        return;
      }
      for (const file of Array.from(files)) {
        if (
          !(ALLOWED_EVIDENCE_MIME_TYPES as readonly string[]).includes(
            file.type,
          )
        ) {
          toast.error(`Format "${file.name}" tidak didukung.`);
          continue;
        }
        if (file.size <= 0 || file.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
          toast.error(`Ukuran "${file.name}" melebihi 50 MB.`);
          continue;
        }
        const path = `${user.id}/${detail.id}/${Date.now()}-${sanitizeFile(file.name)}`;
        const { error: upErr } = await supabase.storage
          .from("refund-evidence")
          .upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) {
          toast.error(`Gagal unggah ${file.name}: ${upErr.message}`);
          continue;
        }
        const att = await attachRefundEvidenceAction({
          refundId: detail.id,
          filePath: path,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        });
        if (!att.ok) {
          toast.error(att.message);
        } else {
          toast.success(`Bukti ${file.name} berhasil dilampirkan.`);
        }
      }
      onMutated(detail.id);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async () => {
    setBusy(true);
    try {
      if (actionMode === "approve") {
        const res = await approveOrderRefundAction({
          refundId: detail.id,
          shiftId: shiftId === "auto" ? null : shiftId,
          approvalNotes: approvalNotes.trim() || null,
          idempotencyKey: `apr-${detail.id}-${Date.now()}`,
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "reject") {
        const res = await rejectOrderRefundAction({
          refundId: detail.id,
          rejectionReason: reasonInput.trim(),
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "cancel") {
        const res = await cancelOrderRefundAction({
          refundId: detail.id,
          cancellationReason: reasonInput.trim(),
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "request_evidence") {
        const res = await requestRefundEvidenceAction({
          refundId: detail.id,
          note: reasonInput.trim(),
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "confirm_midtrans") {
        const targetLeg = pendingMidtransAllocs[0];
        const res = await confirmMidtransRefundAction({
          refundId: detail.id,
          gatewayRefundId: gatewayRefundId.trim(),
          expectedAmount: targetLeg ? targetLeg.amount : detail.amount,
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "manual_fallback") {
        const targetLeg = pendingMidtransAllocs[0];
        const res = await completeRefundManualFallbackAction({
          refundId: detail.id,
          allocationId: targetLeg?.id ?? null,
          payoutReference: payoutRef.trim(),
          reason: reasonInput.trim(),
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      } else if (actionMode === "correct") {
        const res = await recordRefundCorrectionAction({
          refundId: detail.id,
          expectedAmount: Number.parseInt(expectedAmt || "0", 10),
          actualAmount: Number.parseInt(actualAmt || "0", 10),
          reason: reasonInput.trim(),
          createSupplementalRefund: createSupp,
          supplementalMethod: suppMethod,
          shiftId: shiftId === "auto" ? null : shiftId,
          idempotencyKey: `corr-${detail.id}-${Date.now()}`,
        });
        if (!res.ok) toast.error(res.message);
        else {
          toast.success(res.message);
          setActionMode("view");
          onMutated(detail.id);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader className="p-4 sm:p-5 border-b bg-muted/20 shrink-0 text-left pr-12">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2">
              <RotateCcw className="size-5 text-primary" />
              {detail.refundNumber} · Order #{detail.orderNumber}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Diajukan oleh {detail.requesterName} (@{detail.requesterUsername}) pada{" "}
              {formatDateTimeWib(detail.createdAt)}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={`text-[11px] font-semibold ${getApprovalBadgeClass(detail.approvalStatus)}`}
            >
              {APPROVAL_STATUS_LABELS[detail.approvalStatus]}
            </Badge>
            <Badge
              variant="outline"
              className={`text-[11px] ${getPayoutBadgeClass(detail.payoutStatus)}`}
            >
              {PAYOUT_STATUS_LABELS[detail.payoutStatus]}
            </Badge>
          </div>
        </div>
      </DialogHeader>

      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5 text-xs">
        {/* Ringkasan Keuangan & Kronologi */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border p-3.5 space-y-1.5 bg-muted/20">
            <p className="font-bold text-foreground">Rincian Komplain</p>
            <p>
              <span className="text-muted-foreground">Penyelesaian:</span>{" "}
              <strong>{REFUND_RESOLUTION_LABELS[detail.resolutionType]}</strong>
            </p>
            <p>
              <span className="text-muted-foreground">Kategori:</span>{" "}
              {REFUND_REASON_CATEGORY_LABELS[detail.reasonCategory]}
            </p>
            <p>
              <span className="text-muted-foreground">Alasan:</span>{" "}
              {detail.reason}
            </p>
            <p>
              <span className="text-muted-foreground">Kronologi:</span>{" "}
              {detail.chronology || "-"}
            </p>
            {detail.rejectionReason ? (
              <p className="text-rose-600 font-semibold">
                Alasan Penolakan: {detail.rejectionReason}
              </p>
            ) : null}
            {detail.cancellationReason ? (
              <p className="text-rose-600 font-semibold">
                Alasan Pembatalan: {detail.cancellationReason}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border p-3.5 space-y-1.5 bg-muted/20 font-mono">
            <p className="font-sans font-bold text-foreground">
              Komponen Pembukuan &amp; Nilai
            </p>
            <div className="flex justify-between">
              <span className="font-sans text-muted-foreground">
                Total Dikembalikan
              </span>
              <strong className="text-sm text-rose-600">
                {detail.resolutionType === "replacement"
                  ? "Rp 0 (Replacement)"
                  : formatRupiah(detail.amount)}
              </strong>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-sans text-muted-foreground">
                Service &amp; Pajak Dikembalikan
              </span>
              <span>
                {formatRupiah(detail.serviceChargeAmount + detail.taxAmount)}
              </span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-sans text-muted-foreground">
                Ref Service + Pajak (Pembukuan)
              </span>
              <span>
                {formatRupiah(
                  detail.referenceServiceChargeAmount + detail.referenceTaxAmount,
                )}
              </span>
            </div>
            {detail.replacementOrderNumber ? (
              <div className="flex justify-between text-[11px] text-primary">
                <span className="font-sans">Tiket Replacement KDS</span>
                <strong>{detail.replacementOrderNumber}</strong>
              </div>
            ) : null}
          </div>
        </div>

        {/* Item Breakdown */}
        {detail.items.length > 0 ? (
          <div className="space-y-1.5">
            <p className="font-bold text-foreground">Item yang Diajukan</p>
            <div className="border rounded-xl overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-[11px] bg-muted/30">
                    <TableHead>Menu</TableHead>
                    <TableHead className="text-center">Qty</TableHead>
                    <TableHead className="text-center">Kompensasi</TableHead>
                    <TableHead>Stok</TableHead>
                    <TableHead className="text-right">Nominal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="text-xs">
                  {detail.items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-semibold">
                        {it.productName}
                      </TableCell>
                      <TableCell className="text-center font-mono">
                        {it.quantity}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className="text-[10px]">
                          {it.compensationPercentage}% ({it.compensationSeverity})
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">
                        {INVENTORY_ACTION_LABELS[it.inventoryAction]}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatRupiah(it.refundAmount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        {/* Split Bill Payout Allocations */}
        {detail.allocations.length > 0 ? (
          <div className="space-y-1.5">
            <p className="font-bold text-foreground flex items-center gap-1.5">
              <CreditCard className="size-3.5 text-primary" />
              Alokasi Pencairan per Pembayaran
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {detail.allocations.map((al) => (
                <div
                  key={al.id}
                  className="rounded-xl border p-2.5 flex items-center justify-between gap-2"
                >
                  <div>
                    <p className="font-bold uppercase">
                      {al.payoutMethod}{" "}
                      <span className="text-muted-foreground font-normal">
                        ({al.paymentSource ?? al.paymentMethod ?? "-"})
                      </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      {al.gatewayRefundId
                        ? `Gateway: ${al.gatewayRefundId}`
                        : al.payoutReference
                          ? `Ref: ${al.payoutReference}`
                          : "Belum ada ref"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-bold">
                      {formatRupiah(al.amount)}
                    </p>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${getPayoutBadgeClass(al.payoutStatus)}`}
                    >
                      {al.payoutStatus}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Bukti Komplain */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-bold text-foreground flex items-center gap-1.5">
              <FileImage className="size-3.5 text-primary" />
              Bukti Foto &amp; Video ({detail.evidence.length})
            </p>
            {isOwnerKasir || isAdmin ? (
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold hover:bg-muted">
                <Upload className="size-3" />
                Unggah Bukti
                <input
                  type="file"
                  multiple
                  disabled={busy}
                  accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  onChange={(e) => void handleUploadEvidence(e.target.files)}
                />
              </label>
            ) : null}
          </div>
          {detail.evidence.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Belum ada lampiran bukti foto/video.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {detail.evidence.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-xl border overflow-hidden bg-muted/20 p-2 space-y-1.5"
                >
                  {ev.signedUrl ? (
                    ev.evidenceKind === "video" ? (
                      <video
                        src={ev.signedUrl}
                        controls
                        className="w-full max-h-48 rounded-lg bg-black"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={ev.signedUrl}
                        alt={ev.fileName}
                        className="w-full max-h-48 object-cover rounded-lg"
                      />
                    )
                  ) : null}
                  <p className="text-[11px] font-medium truncate">
                    {ev.fileName}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Riwayat Koreksi */}
        {detail.corrections.length > 0 ? (
          <div className="space-y-1.5">
            <p className="font-bold text-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 text-amber-600" />
              Catatan Koreksi Audit
            </p>
            {detail.corrections.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-amber-300 bg-amber-50/50 p-2.5 text-[11px] space-y-0.5"
              >
                <div className="flex justify-between font-bold">
                  <span className="uppercase">{c.correctionType}</span>
                  <span className="font-mono">
                    Selisih: {c.differenceAmount > 0 ? "+" : ""}
                    {formatRupiah(c.differenceAmount)}
                  </span>
                </div>
                <p>
                  Seharusnya {formatRupiah(c.expectedAmount)} · Aktual{" "}
                  {formatRupiah(c.actualAmount)} · Alasan: {c.reason}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        {/* Form Aksi Kontekstual */}
        {actionMode !== "view" ? (
          <>
            <Separator />
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 space-y-3">
              {actionMode === "approve" ? (
                <>
                  <p className="font-bold text-primary">
                    Konfirmasi Persetujuan Admin
                  </p>
                  {detail.resolutionType !== "replacement" ? (
                    <div className="space-y-1">
                      <Label className="text-[11px]">
                        Shift Kasir (untuk payout Tunai)
                      </Label>
                      <Select value={shiftId} onValueChange={setShiftId}>
                        <SelectTrigger className="h-8 text-xs bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            Otomatis (Shift aktif saya / out-of-shift)
                          </SelectItem>
                          {detail.openShifts.map((sh) => (
                            <SelectItem key={sh.id} value={sh.id}>
                              {sh.cashierName} · Kas{" "}
                              {formatRupiah(sh.expectedCash)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <div className="space-y-1">
                    <Label className="text-[11px]">
                      Catatan Persetujuan (opsional)
                    </Label>
                    <Input
                      value={approvalNotes}
                      onChange={(e) => setApprovalNotes(e.target.value)}
                      placeholder="Catatan internal persetujuan..."
                      className="h-8 text-xs bg-background"
                    />
                  </div>
                </>
              ) : null}

              {actionMode === "confirm_midtrans" ? (
                <div className="space-y-1.5">
                  <p className="font-bold text-blue-800">
                    Konfirmasi Refund Gateway Midtrans
                  </p>
                  <Label className="text-[11px]">
                    Gateway Refund ID / Reference Key dari Midtrans
                  </Label>
                  <Input
                    value={gatewayRefundId}
                    onChange={(e) => setGatewayRefundId(e.target.value)}
                    placeholder="Contoh: RF-MIDTRANS-..."
                    className="h-8 text-xs font-mono bg-background"
                  />
                </div>
              ) : null}

              {actionMode === "manual_fallback" ? (
                <div className="space-y-2">
                  <p className="font-bold text-rose-700">
                    Fallback Transfer Bank Manual Pengganti Midtrans
                  </p>
                  <div className="space-y-1">
                    <Label className="text-[11px]">
                      Nomor Referensi Transfer Bank *
                    </Label>
                    <Input
                      value={payoutRef}
                      onChange={(e) => setPayoutRef(e.target.value)}
                      placeholder="Nomor bukti/referensi mutasi bank..."
                      className="h-8 text-xs font-mono bg-background"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Alasan Fallback *</Label>
                    <Textarea
                      value={reasonInput}
                      onChange={(e) => setReasonInput(e.target.value)}
                      placeholder="Alasan tidak melalui gateway Midtrans..."
                      className="text-xs bg-background min-h-[60px]"
                    />
                  </div>
                </div>
              ) : null}

              {actionMode === "correct" ? (
                <div className="space-y-2">
                  <p className="font-bold text-amber-800">
                    Catat Koreksi Selisih Refund (Audit Ledger)
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px]">Nominal Seharusnya</Label>
                      <Input
                        type="number"
                        value={expectedAmt}
                        onChange={(e) => setExpectedAmt(e.target.value)}
                        className="h-8 text-xs font-mono bg-background"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">
                        Nominal Aktual Terbayar
                      </Label>
                      <Input
                        type="number"
                        value={actualAmt}
                        onChange={(e) => setActualAmt(e.target.value)}
                        className="h-8 text-xs font-mono bg-background"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="create-supp"
                      checked={createSupp}
                      onCheckedChange={(v) => setCreateSupp(Boolean(v))}
                    />
                    <label htmlFor="create-supp" className="text-xs cursor-pointer">
                      Jika kurang bayar (under_refund), buat refund tambahan sekarang
                    </label>
                  </div>
                  {createSupp ? (
                    <Select
                      value={suppMethod}
                      onValueChange={(v) =>
                        setSuppMethod(v as RefundPayoutMethod)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">Tunai</SelectItem>
                        <SelectItem value="transfer">Transfer Bank</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div>
                    <Label className="text-[11px]">Alasan Koreksi *</Label>
                    <Textarea
                      value={reasonInput}
                      onChange={(e) => setReasonInput(e.target.value)}
                      placeholder="Jelaskan selisih nominal..."
                      className="text-xs bg-background min-h-[60px]"
                    />
                  </div>
                </div>
              ) : null}

              {actionMode === "reject" ||
              actionMode === "cancel" ||
              actionMode === "request_evidence" ? (
                <div className="space-y-1">
                  <Label className="text-[11px] font-bold">
                    {actionMode === "reject"
                      ? "Alasan Penolakan Wajib *"
                      : actionMode === "cancel"
                        ? "Alasan Pembatalan Wajib *"
                        : "Pesan Permintaan Bukti Tambahan *"}
                  </Label>
                  <Textarea
                    value={reasonInput}
                    onChange={(e) => setReasonInput(e.target.value)}
                    placeholder="Masukkan keterangan minimal 3 karakter..."
                    className="text-xs bg-background min-h-[60px]"
                  />
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setActionMode("view")}
                  className="h-8 rounded-xl text-xs"
                >
                  Batal Aksi
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runAction()}
                  className="h-8 rounded-xl text-xs gap-1.5"
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Simpan Keputusan
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      <DialogFooter className="p-4 border-t bg-muted/20 shrink-0 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {isAdmin && detail.approvalStatus === "pending_approval" ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => setActionMode("approve")}
                className="h-8 rounded-xl text-xs gap-1 bg-emerald-700 hover:bg-emerald-800 text-white"
              >
                <ShieldCheck className="size-3.5" />
                Setujui
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setActionMode("reject")}
                className="h-8 rounded-xl text-xs gap-1"
              >
                <XCircle className="size-3.5" />
                Tolak
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setActionMode("request_evidence")}
                className="h-8 rounded-xl text-xs gap-1"
              >
                <FileWarning className="size-3.5" />
                Minta Bukti
              </Button>
            </>
          ) : null}

          {isAdmin && pendingMidtransAllocs.length > 0 ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => setActionMode("confirm_midtrans")}
                className="h-8 rounded-xl text-xs gap-1 bg-blue-700 hover:bg-blue-800 text-white"
              >
                <CheckCircle2 className="size-3.5" />
                Konfirmasi Midtrans
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setActionMode("manual_fallback")}
                className="h-8 rounded-xl text-xs gap-1"
              >
                <CreditCard className="size-3.5" />
                Fallback Transfer Manual
              </Button>
            </>
          ) : null}

          {isAdmin &&
          detail.approvalStatus === "approved" &&
          detail.payoutStatus === "completed" &&
          detail.resolutionType !== "replacement" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setActionMode("correct")}
              className="h-8 rounded-xl text-xs gap-1"
            >
              <Wrench className="size-3.5" />
              Koreksi Nominal
            </Button>
          ) : null}

          {canKasirCancelOwn || canAdminCancel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setActionMode("cancel")}
              className="h-8 rounded-xl text-xs gap-1 text-destructive border-destructive/30"
            >
              <Ban className="size-3.5" />
              Batalkan Pengajuan
            </Button>
          ) : null}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          className="h-8 rounded-xl text-xs"
        >
          Tutup
        </Button>
      </DialogFooter>
    </>
  );
}
