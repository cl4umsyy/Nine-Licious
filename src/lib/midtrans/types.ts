export type {
  MidtransTransaction,
  OrderAllocation,
  MidtransWebhookEvent,
  MidtransSplitBillType,
} from "@/types/database";
import type { MidtransSplitBillType } from "@/types/database";

export type SnapItemDetail = {
  id: string;
  price: number;
  quantity: number;
  name: string;
};

export type CreateSnapTransactionParams = {
  orderId: string;
  orderNumber: string;
  grossAmount: number;
  idempotencyKey: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  isSplitBill?: boolean;
  splitBillType?: MidtransSplitBillType;
  itemAllocations?: {
    order_item_id: string;
    allocated_quantity: number;
    allocated_line_subtotal: number;
    allocated_discount_share: number;
    allocated_service_share: number;
    allocated_tax_share: number;
    allocated_final_amount: number;
  }[];
  expiryMinutes?: number;
};

export type CreateSnapTransactionResult = {
  ok: boolean;
  midtransTransactionId?: string;
  midtransOrderId?: string;
  snapToken?: string;
  snapRedirectUrl?: string;
  grossAmount?: number;
  error?: string;
  idempotentReplay?: boolean;
};

export type ProcessWebhookResult = {
  ok: boolean;
  fingerprint: string;
  orderId?: string;
  midtransOrderId?: string;
  transactionStatus?: string;
  processingResult: string;
  isDuplicate?: boolean;
  error?: string;
};
