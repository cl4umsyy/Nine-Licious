export type LoginActionState = {
  error?: string;
  values?: {
    username?: string;
  };
};

export type UserActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
};
