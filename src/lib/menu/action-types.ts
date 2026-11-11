export type MenuActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
};

export type MenuActionResult = {
  status: "success" | "error";
  message: string;
};
