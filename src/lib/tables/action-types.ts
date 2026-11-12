export type TableActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
};

export type TableActionResult = {
  status: "success" | "error";
  message: string;
};
