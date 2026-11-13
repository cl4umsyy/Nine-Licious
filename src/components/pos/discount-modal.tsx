"use client";

import { useState, useTransition } from "react";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Trash2,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { requestDiscountApprovalAction } from "@/lib/discounts/actions";
import { formatRupiah } from "@/lib/menu/format";
import type { Discount, DiscountType } from "@/types/database";

export type ManualDiscountState = {
  type: DiscountType;
  value: number;
  reason: string;
  nonce: string;
  approverName: string;
};

export type DiscountModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cartSubtotal: number;
  availableDiscounts: Discount[];
  selectedOrderPromo: Discount | null;
  onSelectOrderPromo: (promo: Discount | null) => void;
  manualDiscount: ManualDiscountState | null;
  onApplyManualDiscount: (discount: ManualDiscountState | null) => void;
  idempotencyKey: string;
};

export function DiscountModal({
  isOpen,
  onClose,
  cartSubtotal,
  availableDiscounts,
  selectedOrderPromo,
  onSelectOrderPromo,
  manualDiscount,
  onApplyManualDiscount,
  idempotencyKey,
}: DiscountModalProps) {
  const [activeTab, setActiveTab] = useState<"promo" | "manual">("promo");

  // Manual Discount Form State
  const [manualType, setManualType] = useState<DiscountType>("percentage");
  const [manualValue, setManualValue] = useState<number>(10);
  const [manualReason, setManualReason] = useState<string>("");

  // Admin Auth Dialog State
  const [isAdminAuthOpen, setIsAdminAuthOpen] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const [isAuthorizing, startAuthorizing] = useTransition();

  const orderPromos = availableDiscounts.filter(
    (d) => d.is_active && d.scope === "order",
  );

  // Trigger Admin Auth Dialog
  const handleRequestApproval = () => {
    if (!manualValue || manualValue <= 0) {
      toast.error("Nilai diskon manual harus lebih dari 0.");
      return;
    }
    if (manualType === "percentage" && manualValue > 100) {
      toast.error("Persentase diskon tidak boleh melebihi 100%.");
      return;
    }
    if (!manualReason.trim() || manualReason.trim().length < 3) {
      toast.error("Alasan diskon manual wajib diisi (minimal 3 karakter).");
      return;
    }

    setAuthError(null);
    setAdminEmail("");
    setAdminPassword("");
    setIsAdminAuthOpen(true);
  };

  // Submit Admin Verification
  const handleSubmitAdminAuth = () => {
    if (!adminEmail.trim() || !adminPassword) {
      setAuthError("Email dan kata sandi Admin wajib diisi.");
      return;
    }

    setAuthError(null);

    startAuthorizing(async () => {
      const result = await requestDiscountApprovalAction({
        adminEmail: adminEmail.trim(),
        adminPassword,
        discountType: manualType,
        discountValue: Number(manualValue),
        reason: manualReason.trim(),
        idempotencyKey,
      });

      // Clear password field immediately from memory
      setAdminPassword("");

      if (result.ok && result.data) {
        toast.success(result.message);
        onApplyManualDiscount({
          type: result.data.discountType,
          value: result.data.discountValue,
          reason: result.data.reason,
          nonce: result.data.nonce,
          approverName: result.data.approverName,
        });
        setIsAdminAuthOpen(false);
        onClose();
      } else {
        setAuthError(result.message || "Otorisasi Admin gagal.");
      }
    });
  };

  const handleRemoveManual = () => {
    onApplyManualDiscount(null);
    setManualReason("");
    toast.info("Diskon manual dilepas.");
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-md sm:max-w-lg p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Tag className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold font-display">
                  Kelola Diskon & Promo
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Pilih promo pesanan atau minta persetujuan Admin untuk diskon manual.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-muted/60 border">
              <Button
                type="button"
                variant={activeTab === "promo" ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("promo")}
                className={`h-8 text-xs font-semibold rounded-lg ${
                  activeTab === "promo"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : ""
                }`}
              >
                Promo Pesanan ({orderPromos.length})
              </Button>
              <Button
                type="button"
                variant={activeTab === "manual" ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("manual")}
                className={`h-8 text-xs font-semibold rounded-lg ${
                  activeTab === "manual"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : ""
                }`}
              >
                Diskon Manual {manualDiscount ? "✓" : ""}
              </Button>
            </div>

            {/* Tab 1: Promo Pesanan */}
            {activeTab === "promo" && (
              <div className="space-y-3">
                {orderPromos.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-6 text-center text-muted-foreground space-y-1">
                    <p className="font-semibold text-xs">Belum Ada Promo Pesanan Aktif</p>
                    <p className="text-[11px]">
                      Admin belum mengaktifkan promo pesanan di master data.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                    {orderPromos.map((promo) => {
                      const isSelected = selectedOrderPromo?.id === promo.id;
                      const meetsMin =
                        !promo.min_order_amount ||
                        cartSubtotal >= promo.min_order_amount;

                      return (
                        <div
                          key={promo.id}
                          className={`flex items-start justify-between p-3 rounded-xl border text-xs transition-all ${
                            isSelected
                              ? "border-primary bg-primary/5 shadow-sm"
                              : meetsMin
                                ? "bg-card hover:bg-muted/30"
                                : "opacity-60 bg-muted/20"
                          }`}
                        >
                          <div className="space-y-1 flex-1 pr-3">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-foreground">
                                {promo.name}
                              </span>
                              {isSelected && (
                                <Badge className="text-[10px] h-4 bg-primary text-primary-foreground">
                                  Terpilih
                                </Badge>
                              )}
                            </div>

                            <div className="flex items-center gap-2 text-muted-foreground text-[11px]">
                              <span className="font-semibold font-mono text-primary">
                                {promo.discount_type === "percentage"
                                  ? `${promo.discount_value}%`
                                  : formatRupiah(promo.discount_value)}
                              </span>
                              {promo.min_order_amount > 0 && (
                                <span>· Min. {formatRupiah(promo.min_order_amount)}</span>
                              )}
                              {promo.max_discount_amount && (
                                <span>· Maks. {formatRupiah(promo.max_discount_amount)}</span>
                              )}
                            </div>

                            {!meetsMin && (
                              <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                                <AlertCircle className="size-3" />
                                Subtotal belum mencapai minimum {formatRupiah(promo.min_order_amount)}
                              </p>
                            )}
                          </div>

                          <Button
                            type="button"
                            size="sm"
                            variant={isSelected ? "outline" : "default"}
                            disabled={!meetsMin && !isSelected}
                            onClick={() => {
                              if (isSelected) {
                                onSelectOrderPromo(null);
                                toast.info("Promo pesanan dilepas.");
                              } else {
                                onSelectOrderPromo(promo);
                                toast.success(`Promo diterapkan: ${promo.name}`);
                              }
                            }}
                            className={`h-7 text-xs font-semibold shrink-0 ${
                              isSelected
                                ? "text-destructive hover:bg-destructive/10"
                                : ""
                            }`}
                          >
                            {isSelected ? "Lepas" : "Terapkan"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Tab 2: Diskon Manual */}
            {activeTab === "manual" && (
              <div className="space-y-4 text-xs">
                {manualDiscount ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
                        <div>
                          <h4 className="font-bold text-sm text-foreground">
                            Diskon Manual Disetujui
                          </h4>
                          <p className="text-[11px] text-muted-foreground">
                            Disetujui oleh{" "}
                            <strong className="text-foreground">
                              {manualDiscount.approverName}
                            </strong>
                          </p>
                        </div>
                      </div>

                      <Badge
                        variant="outline"
                        className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300 font-mono font-bold"
                      >
                        {manualDiscount.type === "percentage"
                          ? `${manualDiscount.value}%`
                          : formatRupiah(manualDiscount.value)}
                      </Badge>
                    </div>

                    <div className="rounded-lg bg-background/80 border p-2.5 space-y-1">
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">
                        Alasan Persetujuan:
                      </span>
                      <p className="text-xs italic text-foreground">
                        &ldquo;{manualDiscount.reason}&rdquo;
                      </p>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[10px] font-mono text-muted-foreground">
                        Token: {manualDiscount.nonce.slice(0, 8)}...
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleRemoveManual}
                        className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5 mr-1" />
                        Hapus Diskon Manual
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-xl border p-3.5 bg-muted/20 space-y-3">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
                        <h4 className="font-bold text-xs text-foreground">
                          Otorisasi Admin Diperlukan
                        </h4>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Pemberian diskon manual di luar promo master mewajibkan verifikasi kredensial Admin langsung di POS. Token berlaku 5 menit dan terikat pada keranjang pesanan ini.
                      </p>

                      {/* Pilihan Jenis Diskon */}
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="space-y-1">
                          <Label className="text-[11px] font-semibold">Jenis</Label>
                          <RadioGroup
                            value={manualType}
                            onValueChange={(val: DiscountType) => setManualType(val)}
                            className="flex items-center gap-3 h-8"
                          >
                            <div className="flex items-center space-x-1.5">
                              <RadioGroupItem value="percentage" id="manual-pct" />
                              <Label htmlFor="manual-pct" className="text-xs cursor-pointer">
                                Persen (%)
                              </Label>
                            </div>
                            <div className="flex items-center space-x-1.5">
                              <RadioGroupItem value="fixed" id="manual-fix" />
                              <Label htmlFor="manual-fix" className="text-xs cursor-pointer">
                                Rupiah (Rp)
                              </Label>
                            </div>
                          </RadioGroup>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[11px] font-semibold">
                            Nilai {manualType === "percentage" ? "(%)" : "(Rp)"}
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            max={manualType === "percentage" ? 100 : undefined}
                            value={manualValue || ""}
                            onChange={(e) => setManualValue(Number(e.target.value))}
                            className="h-8 text-xs font-mono"
                          />
                        </div>
                      </div>

                      {/* Alasan */}
                      <div className="space-y-1">
                        <Label className="text-[11px] font-semibold">
                          Alasan Diskon (Wajib)
                        </Label>
                        <Input
                          type="text"
                          placeholder="Contoh: Tamu VIP Owner, Kompensasi Meja, Diskon Karyawan"
                          value={manualReason}
                          onChange={(e) => setManualReason(e.target.value)}
                          maxLength={200}
                          className="h-8 text-xs"
                        />
                      </div>

                      <Button
                        type="button"
                        onClick={handleRequestApproval}
                        className="w-full h-8 text-xs font-bold bg-primary text-primary-foreground shadow"
                      >
                        <ShieldCheck className="size-3.5 mr-1.5" />
                        Minta Persetujuan Admin
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              className="text-xs w-full sm:w-auto"
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog Verifikasi Kredensial Admin */}
      <Dialog
        open={isAdminAuthOpen}
        onOpenChange={(open) => !open && !isAuthorizing && setIsAdminAuthOpen(false)}
      >
        <DialogContent className="max-w-sm p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b bg-muted/20">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <KeyRound className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold font-display">
                  Autentikasi Admin
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Masukkan email dan kata sandi Admin untuk menyetujui diskon{" "}
                  <strong>
                    {manualType === "percentage"
                      ? `${manualValue}%`
                      : formatRupiah(manualValue)}
                  </strong>
                  .
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="p-5 space-y-3.5 text-xs">
            {authError && (
              <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-start gap-2">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span className="leading-tight">{authError}</span>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Email Admin</Label>
              <Input
                type="email"
                placeholder="admin@ninelicious.com"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                disabled={isAuthorizing}
                autoFocus
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Kata Sandi Admin</Label>
              <Input
                type="password"
                placeholder="••••••••"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                disabled={isAuthorizing}
                className="h-8 text-xs"
              />
            </div>

            <p className="text-[10px] text-muted-foreground leading-tight">
              Sesi kasir Anda tidak akan terganggu. Verifikasi dilakukan secara aman di server tanpa menyimpan kredensial Admin.
            </p>
          </div>

          <DialogFooter className="p-4 border-t bg-muted/20 flex-row justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isAuthorizing}
              onClick={() => setIsAdminAuthOpen(false)}
              className="text-xs"
            >
              Batal
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isAuthorizing || !adminEmail.trim() || !adminPassword}
              onClick={handleSubmitAdminAuth}
              className="text-xs font-bold bg-primary text-primary-foreground"
            >
              {isAuthorizing ? (
                <>
                  <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                  Memverifikasi...
                </>
              ) : (
                <>
                  <UserCheck className="size-3.5 mr-1.5" />
                  Setujui Diskon
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
