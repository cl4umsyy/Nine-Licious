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

export type ProcessRefundInput = {
  orderId: string;
  amount: number;
  refundType: "full" | "partial";
  refundMethod: "cash" | "transfer" | "midtrans" | "manual";
  reason: string;
  paymentId?: string | null;
  idempotencyKey: string;
};

export type RefundProcessingResult = {
  refund_id: string;
  refund_number: string;
  order_id: string;
  order_number: string;
  payment_id?: string | null;
  amount: number;
  refund_type: "full" | "partial";
  refund_method: "cash" | "transfer" | "midtrans" | "manual";
  status: "pending" | "completed" | "approved" | "rejected";
  new_order_status?: string;
  new_payment_status?: string;
  refunded_total?: number;
  kitchen_notified?: boolean;
  is_duplicate?: boolean;
  message?: string;
};

export type ReceiptData = {
  restaurant: {
    name: string;
    address: string | null;
    phone: string | null;
    logo_url: string | null;
    receipt_header: string | null;
    receipt_footer: string | null;
    receipt_width: number;
  };
  order: {
    id: string;
    order_number: string;
    order_type: string;
    table_name: string | null;
    customer_name: string | null;
    status: string;
    payment_status: string;
    queue_number: string | null;
    queue_date: string | null;
    cashier_name: string;
    created_at: string;
    subtotal: number;
    discount_product_total: number;
    discount_order_total: number;
    discount_manual_total: number;
    discount_total: number;
    tax_percent: number;
    tax_total: number;
    service_charge_percent: number;
    service_total: number;
    grand_total: number;
    paid_total: number;
    refunded_total: number;
    pending_refund_total: number;
    net_paid: number;
  };
  items: Array<{
    id: string;
    product_id: string;
    product_name: string;
    product_sku: string | null;
    unit_price: number;
    quantity: number;
    notes: string | null;
    modifier_total: number;
    subtotal: number;
    discount_amount: number;
    line_total: number;
    kitchen_station: string | null;
    modifiers: Array<{
      group_name: string;
      option_name: string;
      price_delta: number;
    }>;
  }>;
  discounts: Array<{
    id: string;
    name: string;
    scope: string;
    discount_type: string;
    discount_rate: number;
    discount_amount: number;
    reason: string | null;
    approved_by: string | null;
    approved_at: string | null;
    approver_name: string | null;
  }>;
  payments: Array<{
    id: string;
    payment_method: string;
    payment_source: string;
    amount: number;
    cash_received: number | null;
    change_amount: number;
    payment_status: string;
    reference_number: string | null;
    created_at: string;
  }>;
  refunds: Array<{
    id: string;
    refund_number: string;
    gateway_refund_id: string | null;
    refund_type: string;
    refund_method: string;
    amount: number;
    reason: string;
    status: string;
    created_at: string;
    approver_name: string | null;
  }>;
};


