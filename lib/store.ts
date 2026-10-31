import { getSqliteStore } from "./sqlite-store";
import { getSupabaseStore } from "./supabase-store";
import type { Store } from "./types";

export function getStore(): Store {
  if (process.env.STORE === "supabase") return getSupabaseStore();
  return getSqliteStore();
}
