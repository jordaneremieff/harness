export const scopes = ["reply", "document", "commit", "comment", "code"] as const;
export const domains = ["prose", "code", "ui"] as const;
export const proseKinds = ["reply", "document", "commit"] as const;
export const idPattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
