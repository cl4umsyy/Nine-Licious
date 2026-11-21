/**
 * NINE LICIOUS POS — CSV EXPORT CONTRACTS
 * File: src/lib/export/types.ts
 */

export type CsvExportResult = {
  ok: boolean;
  message?: string;
  filename?: string;
  csvContent?: string;
  totalMatching?: number;
  exportedCount?: number;
  isTruncated?: boolean;
};

export type SalesExportSection =
  | "all"
  | "summary"
  | "daily"
  | "products"
  | "categories"
  | "payments"
  | "split_and_refund";
