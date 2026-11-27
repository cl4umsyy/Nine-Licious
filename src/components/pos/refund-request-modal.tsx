"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChefHat,
  Clock3,
  FileImage,
  Info,
  Loader2,
  Package,
  RotateCcw,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { formatRupiah } from "@/lib/menu/format";
import {
  attachRefundEvidenceAction,
  getOrderRefundContextAction,
  requestOrderRefundAction,
} from "@/lib/refunds/actions";
import {
  calculateRefundBreakdownPreview,
  getDefaultInventoryAction,
} from "@/lib/refunds/calculations";
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  COMPENSATION_SEVERITIES,
  COMPENSATION_SEVERITY_LABELS,
  INVENTORY_ACTION_LABELS,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
  REFUND_REASON_CATEGORIES,
  REFUND_REASON_CATEGORY_LABELS,
  REFUND_RESOLUTION_LABELS,
  REFUND_RESOLUTION_TYPES,
  type OrderRefundContextData,
} from "@/lib/refunds/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  CompensationSeverity,
  RefundInventoryAction,
  RefundPayoutMethod,
  RefundReasonCategory,
  RefundResolutionType,
} from "@/types/database";

type RefundRequestModalProps = {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
  userRole: string;
  onSuccess?: () => void;
};

type SelectedItemState = {
  selected: boolean;
  quantity: number;
  compensationSeverity: CompensationSeverity;
  inventoryAction: RefundInventoryAction;
  reason: string;
};

function createIdempotencyKey(orderId: string): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `req-ref-${orderId.slice(0, 8)}-${Date.now()}-${rand}`;
}

function sanitizeUploadFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "evidence";
}

export function RefundRequestModal({
  orderId,
  isOpen,
  onClose,
  userRole,
  onSuccess,
}: RefundRequestModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(100%-1.5rem,780px)] sm:max-w-[780px] max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden rounded-2xl">
        {isOpen && orderId ? (
          <RefundRequestModalContent
            orderId={orderId}
            userRole={userRole}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RefundRequestModalContent({
  orderId,
  userRole,
  onClose,
  onSuccess,
}: {
  orderId: string;
  userRole: string;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const isAdmin = userRole === "admin";

  const [context, setContext] = useState<OrderRefundContextData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [resolutionType, setResolutionType] =
    useState<RefundResolutionType>("partial_refund");
  const [reasonCategory, setReasonCategory] =
    useState<RefundReasonCategory>("wrong_order");
  const [useDuplicatePaymentMode, setUseDuplicatePaymentMode] = useState(false);
  const [duplicatePaymentAmount, setDuplicatePaymentAmount] = useState("");
  const [reason, setReason] = useState("");
  const [chronology, setChronology] = useState("");
  const [receiptVerified, setReceiptVerified] = useState(false);
  const [preferredMethod, setPreferredMethod] = useState<string>("auto");
  const [selectedItems, setSelectedItems] = useState<
    Record<string, SelectedItemState>
  >({});

  // Admin-only self-approval options
  const [autoApprove, setAutoApprove] = useState(false);
  const [shiftId, setShiftId] = useState<string>("auto");
  const [splitAllocations, setSplitAllocations] = useState<
    Record<string, { amount: string; method: RefundPayoutMethod }>
  >({});

  // Optional photo/video evidence
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [evidenceNotes, setEvidenceNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey] = useState(() => createIdempotencyKey(orderId));

  useEffect(() => {
    let active = true;
    getOrderRefundContextAction(orderId).then((res) => {
      if (!active) return;
      setIsLoading(false);
      if (!res.ok) {
        setLoadError(res.message);
        return;
      }

      const data = res.data;
      setContext(data);
      setLoadError(null);

      const initialItems: Record<string, SelectedItemState> = {};
      for (const item of data.items) {
        initialItems[item.orderItemId] = {
          selected: false,
          quantity: Math.max(1, item.remainingQuantity),
          compensationSeverity: "heavy",
          inventoryAction: getDefaultInventoryAction({
            resolutionType: "partial_refund",
            reasonCategory: "wrong_order",
            kdsStatus: item.kdsStatus,
          }),
          reason: "",
        };
      }
      setSelectedItems(initialItems);

      const initialAllocs: Record<
        string,
        { amount: string; method: RefundPayoutMethod }
      > = {};
      for (const pay of data.payments) {
        initialAllocs[pay.id] = {
          amount: "0",
          method: pay.suggestedPayoutMethod,
        };
      }
      setSplitAllocations(initialAllocs);
    });

    return () => {
      active = false;
    };
  }, [orderId]);

  const handleResolutionChange = (nextRes: RefundResolutionType) => {
    setResolutionType(nextRes);
    if (nextRes === "replacement") {
      setUseDuplicatePaymentMode(false);
    }
    if (!context) return;

    setSelectedItems((prev) => {
      const next: Record<string, SelectedItemState> = {};
      for (const item of context.items) {
        const current = prev[item.orderItemId];
        const canSelect = !item.isExhausted && item.remainingQuantity > 0;
        const defaultAction = getDefaultInventoryAction({
          resolutionType: nextRes,
          reasonCategory,
          kdsStatus: item.kdsStatus,
        });
        next[item.orderItemId] = {
          selected:
            nextRes === "full_refund"
              ? canSelect
              : (current?.selected ?? false),
          quantity:
            nextRes === "full_refund"
              ? Math.max(1, item.remainingQuantity)
              : (current?.quantity ?? Math.max(1, item.remainingQuantity)),
          compensationSeverity:
            nextRes === "full_refund"
              ? "heavy"
              : (current?.compensationSeverity ?? "heavy"),
          inventoryAction:
            nextRes === "replacement"
              ? "none"
              : defaultAction === "replace"
                ? "none"
                : defaultAction,
          reason: current?.reason ?? "",
        };
      }
      return next;
    });
  };

  const handleReasonCategoryChange = (nextCat: RefundReasonCategory) => {
    setReasonCategory(nextCat);
    if (nextCat !== "payment_issue") {
      setUseDuplicatePaymentMode(false);
    }
    if (!context) return;

    setSelectedItems((prev) => {
      const next: Record<string, SelectedItemState> = {};
      for (const item of context.items) {
        const current = prev[item.orderItemId];
        const defaultAction = getDefaultInventoryAction({
          resolutionType,
          reasonCategory: nextCat,
          kdsStatus: item.kdsStatus,
        });
        next[item.orderItemId] = {
          ...(current ?? {
            selected: false,
            quantity: Math.max(1, item.remainingQuantity),
            compensationSeverity: "heavy",
            inventoryAction: "none",
            reason: "",
          }),
          inventoryAction:
            defaultAction === "replace" ? "none" : defaultAction,
        };
      }
      return next;
    });
  };

  const breakdown = useMemo(() => {
    if (!context) return null;
    const selectedPayload = context.items
      .filter((item) => selectedItems[item.orderItemId]?.selected)
      .map((item) => {
        const state = selectedItems[item.orderItemId];
        return {
          orderItemId: item.orderItemId,
          quantity: state?.quantity ?? item.remainingQuantity,
          compensationSeverity: state?.compensationSeverity ?? "heavy",
          reason: state?.reason ?? "",
        };
      });

    const dupNum = useDuplicatePaymentMode
      ? Number.parseInt(duplicatePaymentAmount.replace(/\D/g, ""), 10) || 0
      : null;

    return calculateRefundBreakdownPreview({
      baselines: context.items,
      availableRefundable: context.order.availableRefundable,
      resolutionType,
      reasonCategory,
      duplicatePaymentAmount: dupNum,
      selectedItems: selectedPayload,
    });
  }, [
    context,
    duplicatePaymentAmount,
    reasonCategory,
    resolutionType,
    selectedItems,
    useDuplicatePaymentMode,
  ]);

  const supportsPartialSeverity =
    resolutionType === "partial_refund" &&
    (reasonCategory === "wrong_order" || reasonCategory === "food_quality");

  const hasSplitBillPayments = (context?.payments.length ?? 0) > 1;

  const handleFilePick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted: File[] = [];
    for (const file of Array.from(files)) {
      if (
        !(ALLOWED_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)
      ) {
        toast.error(
          `Format "${file.name}" tidak didukung. Gunakan JPG, PNG, WebP, MP4, WebM, atau MOV.`,
        );
        continue;
      }
      if (file.size <= 0 || file.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
        toast.error(
          `Ukuran "${file.name}" melebihi batas maksimal 50 MB.`,
        );
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) {
      setEvidenceFiles((prev) => [...prev, ...accepted].slice(0, 5));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!context || isSubmitting) return;

    if (!context.order.isEligibleForNewRequest) {
      toast.error(
        context.order.ineligibilityReason ||
          "Pesanan tidak memenuhi syarat pengajuan refund.",
      );
      return;
    }

    if (!receiptVerified) {
      toast.error("Verifikasi struk transaksi wajib dicentang terlebih dahulu.");
      return;
    }

    if (breakdown?.validationError) {
      toast.error(breakdown.validationError);
      return;
    }

    const dupAmt = useDuplicatePaymentMode
      ? Number.parseInt(duplicatePaymentAmount.replace(/\D/g, ""), 10) || 0
      : null;

    const chosenItems = useDuplicatePaymentMode
      ? []
      : context.items
          .filter((item) => selectedItems[item.orderItemId]?.selected)
          .map((item) => {
            const st = selectedItems[item.orderItemId]!;
            return {
              orderItemId: item.orderItemId,
              quantity: st.quantity,
              compensationSeverity: st.compensationSeverity,
              inventoryAction:
                resolutionType === "replacement"
                  ? undefined
                  : st.inventoryAction,
              reason: st.reason.trim() || null,
            };
          });

    let customAllocations:
      | Array<{
          paymentId: string;
          amount: number;
          payoutMethod: RefundPayoutMethod;
        }>
      | undefined;

    if (
      isAdmin &&
      autoApprove &&
      resolutionType !== "replacement" &&
      hasSplitBillPayments
    ) {
      const filled = context.payments
        .map((p) => {
          const entry = splitAllocations[p.id];
          const amt = Number.parseInt(entry?.amount || "0", 10) || 0;
          return {
            paymentId: p.id,
            amount: amt,
            payoutMethod: entry?.method ?? p.suggestedPayoutMethod,
          };
        })
        .filter((x) => x.amount > 0);

      if (filled.length > 0) {
        const sum = filled.reduce((s, x) => s + x.amount, 0);
        if (sum !== (breakdown?.totalRefundAmount ?? 0)) {
          toast.error(
            `Total alokasi Split Bill (${formatRupiah(sum)}) harus sama persis dengan total refund (${formatRupiah(breakdown?.totalRefundAmount ?? 0)}).`,
          );
          return;
        }
        customAllocations = filled;
      }
    }

    setIsSubmitting(true);
    try {
      const res = await requestOrderRefundAction({
        orderId: context.order.id,
        resolutionType,
        reasonCategory,
        reason: reason.trim(),
        chronology: chronology.trim(),
        items: chosenItems,
        preferredPayoutMethod:
          preferredMethod === "auto"
            ? null
            : (preferredMethod as RefundPayoutMethod | "mixed"),
        receiptVerified: true,
        duplicatePaymentAmount: dupAmt,
        autoApprove: isAdmin ? autoApprove : false,
        payoutAllocations: customAllocations ?? null,
        shiftId: isAdmin && autoApprove && shiftId !== "auto" ? shiftId : null,
        idempotencyKey,
      });

      if (!res.ok) {
        toast.error(res.message);
        return;
      }

      const refundId = String(res.data.refund_id ?? "");
      // Unggah bukti opsional langsung ke private bucket refund-evidence
      if (evidenceFiles.length > 0 && refundId) {
        const browserSupabase = createSupabaseBrowserClient();
        const {
          data: { user },
        } = await browserSupabase.auth.getUser();

        if (user) {
          let failedUploads = 0;
          for (const file of evidenceFiles) {
            const path = `${user.id}/${refundId}/${Date.now()}-${sanitizeUploadFilename(file.name)}`;
            const { error: uploadErr } = await browserSupabase.storage
              .from("refund-evidence")
              .upload(path, file, {
                contentType: file.type,
                upsert: false,
              });

            if (uploadErr) {
              failedUploads += 1;
              continue;
            }

            const attachRes = await attachRefundEvidenceAction({
              refundId,
              filePath: path,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size,
              notes: evidenceNotes.trim() || null,
            });
            if (!attachRes.ok) {
              failedUploads += 1;
            }
          }
          if (failedUploads > 0) {
            toast.warning(
              `Pengajuan tercatat, namun ${failedUploads} file bukti gagal diunggah.`,
            );
          }
        }
      }

      toast.success(res.message);
      onSuccess?.();
      onClose();
    } catch {
      toast.error("Gagal mengirim pengajuan refund.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader className="p-4 sm:p-5 border-b bg-muted/20 shrink-0 text-left pr-10">
        <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2">
          <RotateCcw className="size-5 text-primary shrink-0" />
          Pengajuan Refund / Replacement Komplain
        </DialogTitle>
        <DialogDescription className="text-xs">
          {context
            ? `Pesanan #${context.order.orderNumber} · Total Dibayar ${formatRupiah(context.order.paidTotal)} · Sisa Refundable ${formatRupiah(context.order.availableRefundable)}`
            : "Memuat kelayakan dan breakdown pesanan..."}
        </DialogDescription>
      </DialogHeader>

      {isLoading ? (
        <div className="p-12 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-6 animate-spin text-primary" />
          Memuat rincian item dan klaim sebelumnya...
        </div>
      ) : loadError || !context ? (
        <div className="p-8 text-center text-xs text-destructive">
          {loadError || "Gagal memuat data pesanan."}
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
            {!context.order.isEligibleForNewRequest ? (
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertTitle>Pesanan Tidak Memenuhi Syarat</AlertTitle>
                <AlertDescription className="text-xs">
                  {context.order.ineligibilityReason}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Clock3 className="size-3.5 text-emerald-700" />
                  Dalam batas 24 jam pengajuan (
                  {context.order.hoursSincePaid !== null
                    ? `${context.order.hoursSincePaid} jam sejak lunas`
                    : "tervalidasi"}
                  )
                </span>
                <Badge variant="outline" className="bg-white text-[11px] font-mono">
                  Sisa Refundable: {formatRupiah(context.order.availableRefundable)}
                </Badge>
              </div>
            )}

            {!isAdmin ? (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
                <Info className="size-4 shrink-0 text-blue-700 mt-0.5" />
                <span>
                  Pengajuan dari Kasir akan berstatus{" "}
                  <strong>Menunggu Persetujuan Admin (pending_approval)</strong>{" "}
                  dan belum memotong saldo maupun membuka pengembalian dana sebelum Admin menyetujui.
                </span>
              </div>
            ) : null}

            {/* Verifikasi Struk */}
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50/70 p-3">
              <Checkbox
                id="receipt-verified"
                checked={receiptVerified}
                onCheckedChange={(checked) =>
                  setReceiptVerified(Boolean(checked))
                }
              />
              <label
                htmlFor="receipt-verified"
                className="text-xs leading-relaxed cursor-pointer text-amber-950 font-medium"
              >
                Saya telah memverifikasi struk fisik atau struk digital resmi
                Nine Licious untuk transaksi{" "}
                <span className="font-mono font-bold">
                  #{context.order.orderNumber}
                </span>{" "}
                bersama pelanggan.
              </label>
            </div>

            {/* Jenis Penyelesaian & Kategori Alasan */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  Jenis Penyelesaian
                </Label>
                <Select
                  value={resolutionType}
                  onValueChange={(v) =>
                    handleResolutionChange(v as RefundResolutionType)
                  }
                >
                  <SelectTrigger className="h-9 text-xs rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REFUND_RESOLUTION_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {REFUND_RESOLUTION_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  Kategori Komplain
                </Label>
                <Select
                  value={reasonCategory}
                  onValueChange={(v) =>
                    handleReasonCategoryChange(v as RefundReasonCategory)
                  }
                >
                  <SelectTrigger className="h-9 text-xs rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REFUND_REASON_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {REFUND_REASON_CATEGORY_LABELS[cat]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {reasonCategory === "payment_issue" &&
            resolutionType !== "replacement" ? (
              <div className="rounded-xl border p-3 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="dup-pay-mode"
                    checked={useDuplicatePaymentMode}
                    onCheckedChange={(v) =>
                      setUseDuplicatePaymentMode(Boolean(v))
                    }
                  />
                  <label
                    htmlFor="dup-pay-mode"
                    className="text-xs font-semibold cursor-pointer"
                  >
                    Kompensasi Pembayaran Ganda (tanpa memilih item spesifik)
                  </label>
                </div>
                {useDuplicatePaymentMode ? (
                  <div className="space-y-1">
                    <Label className="text-[11px]">
                      Nominal Kelebihan Pembayaran (Rp)
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={context.order.availableRefundable}
                      value={duplicatePaymentAmount}
                      onChange={(e) =>
                        setDuplicatePaymentAmount(e.target.value)
                      }
                      placeholder={`Maksimal ${context.order.availableRefundable}`}
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Pilihan Item Pesanan */}
            {!useDuplicatePaymentMode ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">
                    Pilih Item &amp; Tingkat Kompensasi
                  </Label>
                  {supportsPartialSeverity ? (
                    <span className="text-[11px] text-amber-700 font-medium">
                      25%/50% murni dari DPP bersih (pajak &amp; service tidak dikembalikan)
                    </span>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {context.items.map((item) => {
                    const st = selectedItems[item.orderItemId];
                    const disabledItem =
                      item.isExhausted || item.remainingQuantity <= 0;
                    const canRestock =
                      item.kdsStatus !== "preparing" &&
                      item.kdsStatus !== "ready";

                    return (
                      <div
                        key={item.orderItemId}
                        className="rounded-xl border p-3 space-y-2 bg-card"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2.5">
                            <Checkbox
                              id={`item-${item.orderItemId}`}
                              disabled={
                                disabledItem || resolutionType === "full_refund"
                              }
                              checked={Boolean(st?.selected)}
                              onCheckedChange={(checked) =>
                                setSelectedItems((prev) => ({
                                  ...prev,
                                  [item.orderItemId]: {
                                    ...prev[item.orderItemId]!,
                                    selected: Boolean(checked),
                                  },
                                }))
                              }
                            />
                            <div>
                              <label
                                htmlFor={`item-${item.orderItemId}`}
                                className="text-xs font-bold cursor-pointer"
                              >
                                {item.productName}{" "}
                                <span className="font-mono text-muted-foreground">
                                  ({item.quantity}x)
                                </span>
                              </label>
                              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground font-mono mt-0.5">
                                <span>DPP: {formatRupiah(item.netDpp)}</span>
                                <span>
                                  Svc+Pajak:{" "}
                                  {formatRupiah(
                                    item.serviceShare + item.taxShare,
                                  )}
                                </span>
                                {item.priorRefundTotal > 0 ? (
                                  <span className="text-amber-700 font-semibold">
                                    Sudah diklaim:{" "}
                                    {formatRupiah(item.priorRefundTotal)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          {disabledItem ? (
                            <Badge variant="secondary" className="text-[10px]">
                              Batas 100% Tercapai
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] font-mono">
                              Sisa porsi: {item.remainingQuantity}
                            </Badge>
                          )}
                        </div>

                        {st?.selected && !disabledItem ? (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-dashed">
                            <div>
                              <Label className="text-[11px]">
                                Qty Komplain
                              </Label>
                              <Input
                                type="number"
                                min={1}
                                max={item.remainingQuantity}
                                disabled={resolutionType === "full_refund"}
                                value={st.quantity}
                                onChange={(e) => {
                                  const q = Math.max(
                                    1,
                                    Math.min(
                                      item.remainingQuantity,
                                      Number.parseInt(e.target.value, 10) || 1,
                                    ),
                                  );
                                  setSelectedItems((prev) => ({
                                    ...prev,
                                    [item.orderItemId]: {
                                      ...prev[item.orderItemId]!,
                                      quantity: q,
                                    },
                                  }));
                                }}
                                className="h-8 text-xs font-mono mt-0.5"
                              />
                            </div>

                            {supportsPartialSeverity ? (
                              <div>
                                <Label className="text-[11px]">
                                  Tingkat Kompensasi
                                </Label>
                                <Select
                                  value={st.compensationSeverity}
                                  onValueChange={(v) =>
                                    setSelectedItems((prev) => ({
                                      ...prev,
                                      [item.orderItemId]: {
                                        ...prev[item.orderItemId]!,
                                        compensationSeverity:
                                          v as CompensationSeverity,
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs mt-0.5">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {COMPENSATION_SEVERITIES.map((sev) => (
                                      <SelectItem key={sev} value={sev}>
                                        {COMPENSATION_SEVERITY_LABELS[sev]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}

                            {resolutionType !== "replacement" ? (
                              <div>
                                <Label className="text-[11px] flex items-center gap-1">
                                  <Package className="size-3" />
                                  Tindakan Stok
                                </Label>
                                <Select
                                  value={st.inventoryAction}
                                  onValueChange={(v) =>
                                    setSelectedItems((prev) => ({
                                      ...prev,
                                      [item.orderItemId]: {
                                        ...prev[item.orderItemId]!,
                                        inventoryAction:
                                          v as RefundInventoryAction,
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs mt-0.5">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">
                                      {INVENTORY_ACTION_LABELS.none}
                                    </SelectItem>
                                    <SelectItem value="waste">
                                      {INVENTORY_ACTION_LABELS.waste}
                                    </SelectItem>
                                    <SelectItem
                                      value="restock"
                                      disabled={!canRestock}
                                    >
                                      {INVENTORY_ACTION_LABELS.restock}
                                      {!canRestock ? " (Dapur aktif)" : ""}
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : (
                              <div className="flex items-end pb-1 text-[11px] text-primary font-medium gap-1">
                                <ChefHat className="size-3.5 shrink-0" />
                                Bahan item awal dicatat Waste + potong bahan pengganti
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Live Canonical Breakdown Preview */}
            {breakdown ? (
              <div className="rounded-xl border bg-muted/30 p-3.5 space-y-1.5 text-xs">
                <div className="flex items-center justify-between font-bold text-foreground">
                  <span>Pratinjau Perhitungan Server-Side</span>
                  <span className="font-mono text-sm text-primary">
                    {resolutionType === "replacement"
                      ? "Rp 0 (Replacement KDS)"
                      : formatRupiah(breakdown.totalRefundAmount)}
                  </span>
                </div>

                {resolutionType !== "replacement" ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px] text-muted-foreground font-mono">
                    <div>
                      DPP Bersih: {formatRupiah(breakdown.totalRefundAmount - breakdown.serviceChargeAmount - breakdown.taxAmount - breakdown.roundingAdjustment)}
                    </div>
                    <div>
                      Service Kembali:{" "}
                      {formatRupiah(breakdown.serviceChargeAmount)}
                    </div>
                    <div>
                      Pajak Kembali: {formatRupiah(breakdown.taxAmount)}
                    </div>
                    <div>
                      Ref Pajak/Svc:{" "}
                      {formatRupiah(
                        breakdown.referenceServiceChargeAmount +
                          breakdown.referenceTaxAmount,
                      )}
                    </div>
                  </div>
                ) : null}

                {breakdown.validationError ? (
                  <p className="text-[11px] font-semibold text-destructive pt-1 flex items-center gap-1">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {breakdown.validationError}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Alasan & Kronologi */}
            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-1">
                <Label htmlFor="refund-reason" className="text-xs font-semibold">
                  Ringkasan Alasan Komplain <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="refund-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Contoh: Nasi goreng terlalu asin / salah topping"
                  className="h-9 text-xs"
                  required
                />
              </div>

              <div className="space-y-1">
                <Label
                  htmlFor="refund-chronology"
                  className="text-xs font-semibold"
                >
                  Kronologi Kejadian <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="refund-chronology"
                  value={chronology}
                  onChange={(e) => setChronology(e.target.value)}
                  placeholder="Jelaskan kronologi komplain pelanggan (minimal 5 karakter)..."
                  className="text-xs min-h-[70px]"
                  required
                />
              </div>
            </div>

            {resolutionType !== "replacement" ? (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  Preferensi Metode Pengembalian Dana
                </Label>
                <Select
                  value={preferredMethod}
                  onValueChange={setPreferredMethod}
                >
                  <SelectTrigger className="h-9 text-xs rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      Otomatis Sesuai Pembayaran Asli (FIFO / Midtrans)
                    </SelectItem>
                    <SelectItem value="cash">Tunai (Cash Drawer)</SelectItem>
                    <SelectItem value="transfer">
                      Transfer Bank Manual
                    </SelectItem>
                    <SelectItem value="midtrans">Midtrans Gateway</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/* Upload Bukti Foto/Video Opsional */}
            <div className="rounded-xl border border-dashed p-3 space-y-2 bg-muted/10">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs font-semibold flex items-center gap-1.5">
                  <FileImage className="size-3.5 text-primary" />
                  Bukti Foto / Video (Opsional, maks 50 MB/file)
                </Label>
                <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold hover:bg-muted">
                  <Upload className="size-3" />
                  Pilih File
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                    className="hidden"
                    onChange={(e) => handleFilePick(e.target.files)}
                  />
                </label>
              </div>
              {evidenceFiles.length > 0 ? (
                <div className="space-y-1.5">
                  {evidenceFiles.map((file, idx) => (
                    <div
                      key={`${file.name}-${idx}`}
                      className="flex items-center justify-between rounded-lg bg-card border px-2.5 py-1.5 text-[11px]"
                    >
                      <span className="truncate max-w-xs font-medium">
                        {file.name} ({(file.size / (1024 * 1024)).toFixed(2)}{" "}
                        MB)
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setEvidenceFiles((prev) =>
                            prev.filter((_, i) => i !== idx),
                          )
                        }
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <Input
                    value={evidenceNotes}
                    onChange={(e) => setEvidenceNotes(e.target.value)}
                    placeholder="Catatan singkat bukti (opsional)"
                    className="h-8 text-xs"
                  />
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  JPG, PNG, WebP, MP4, WebM, atau MOV. Admin dapat meminta bukti
                  tambahan kapan saja.
                </p>
              )}
            </div>

            {/* Panel Khusus Admin: Langsung Setujui + Split Bill + Shift */}
            {isAdmin ? (
              <>
                <Separator />
                <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="admin-auto-approve"
                      checked={autoApprove}
                      onCheckedChange={(v) => setAutoApprove(Boolean(v))}
                    />
                    <label
                      htmlFor="admin-auto-approve"
                      className="text-xs font-bold cursor-pointer text-primary"
                    >
                      Langsung Setujui &amp; Eksekusi Sekarang (Self-Approval Admin)
                    </label>
                  </div>

                  {autoApprove && resolutionType !== "replacement" ? (
                    <div className="space-y-2.5 pt-1">
                      <div className="space-y-1">
                        <Label className="text-[11px] font-semibold">
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
                            {context.openShifts.map((sh) => (
                              <SelectItem key={sh.id} value={sh.id}>
                                {sh.cashierName} · Kas{" "}
                                {formatRupiah(sh.expectedCash)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {hasSplitBillPayments ? (
                        <div className="space-y-1.5">
                          <Label className="text-[11px] font-semibold">
                            Alokasi Split Bill Kustom (opsional — kosongkan
                            semua 0 untuk FIFO otomatis)
                          </Label>
                          <div className="space-y-1.5">
                            {context.payments.map((p) => {
                              const entry = splitAllocations[p.id];
                              return (
                                <div
                                  key={p.id}
                                  className="grid grid-cols-12 gap-2 items-center rounded-lg border bg-background p-2 text-[11px]"
                                >
                                  <div className="col-span-5">
                                    <p className="font-bold uppercase">
                                      {p.paymentMethod} ({p.paymentSource})
                                    </p>
                                    <p className="text-muted-foreground font-mono">
                                      Sisa:{" "}
                                      {formatRupiah(p.remainingRefundable)}
                                    </p>
                                  </div>
                                  <div className="col-span-4">
                                    <Input
                                      type="number"
                                      min={0}
                                      max={p.remainingRefundable}
                                      value={entry?.amount ?? "0"}
                                      onChange={(e) =>
                                        setSplitAllocations((prev) => ({
                                          ...prev,
                                          [p.id]: {
                                            method:
                                              prev[p.id]?.method ??
                                              p.suggestedPayoutMethod,
                                            amount: e.target.value,
                                          },
                                        }))
                                      }
                                      className="h-7 text-xs font-mono"
                                    />
                                  </div>
                                  <div className="col-span-3">
                                    <Select
                                      value={
                                        entry?.method ?? p.suggestedPayoutMethod
                                      }
                                      onValueChange={(val) =>
                                        setSplitAllocations((prev) => ({
                                          ...prev,
                                          [p.id]: {
                                            amount: prev[p.id]?.amount ?? "0",
                                            method: val as RefundPayoutMethod,
                                          },
                                        }))
                                      }
                                    >
                                      <SelectTrigger className="h-7 text-[11px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="cash">cash</SelectItem>
                                        <SelectItem value="transfer">
                                          transfer
                                        </SelectItem>
                                        <SelectItem value="midtrans">
                                          midtrans
                                        </SelectItem>
                                        <SelectItem value="manual">
                                          manual
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20 shrink-0 gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={onClose}
              className="rounded-xl text-xs"
            >
              Batal
            </Button>
            <Button
              type="submit"
              disabled={
                isSubmitting ||
                !context.order.isEligibleForNewRequest ||
                !receiptVerified ||
                Boolean(breakdown?.validationError)
              }
              className="rounded-xl text-xs gap-1.5"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Memproses...
                </>
              ) : isAdmin && autoApprove ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  Ajukan &amp; Setujui Sekarang
                </>
              ) : (
                <>
                  <RotateCcw className="size-3.5" />
                  Kirim Pengajuan Refund
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}
