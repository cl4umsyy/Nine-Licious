import type {
  Payment,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentSource,
} from "@/types/database";

export type { Payment, PaymentMethod, PaymentRecordStatus, PaymentSource };

export type ProcessManualPaymentInput = {
  orderId: string;
  paymentMethod: "cash" | "qris" | "bank_transfer";
  paymentSource: "cash" | "qris_manual" | "bank_transfer";
  amount: number;
  cashReceived?: number | null;
  changeAmount?: number;
  referenceNumber?: string | null;
  idempotencyKey: string;
  notes?: string | null;
};

export type PaymentProcessingResult = {
  payment_id: string;
  order_id: string;
  order_number: string;
  amount: number;
  cash_received: number | null;
  change_amount: number;
  payment_status: PaymentRecordStatus;
  paid_total: number;
  grand_total: number;
  is_settled: boolean;
  queue_number?: string | null;
  queue_date?: string | null;
  idempotent_replay?: boolean;
};

export type PaymentActionResult<T = unknown> =
  | {
      ok: true;
      message: string;
      data: T;
    }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string>;
    };

