import type { OrderWithDetails } from "@/lib/orders/types";

export type OrderActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  data?: OrderWithDetails;
};

export type OrderActionResult = {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
  data?: OrderWithDetails;
};

