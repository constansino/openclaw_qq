import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./client.js";
import type { QQConfig } from "./config.js";

const clients = new Map<string, OneBotClient>();
const accountConfigs = new Map<string, QQConfig>();

function normalizeAccountLookupId(accountId: string | undefined | null): string {
  const raw = typeof accountId === "string" ? accountId.trim() : "";
  if (!raw) return DEFAULT_ACCOUNT_ID;
  if (raw === DEFAULT_ACCOUNT_ID) return raw;

  const noPrefix = raw.replace(/^qq:/i, "");
  if (noPrefix) return noPrefix;
  return DEFAULT_ACCOUNT_ID;
}

function getAccountKeyVariants(accountId: string | undefined | null): string[] {
  const lookupId = normalizeAccountLookupId(accountId);
  const variants = new Set<string>([lookupId]);
  const normalized = normalizeAccountId(lookupId);
  if (normalized) variants.add(normalized);
  if (lookupId.includes(":")) {
    const suffix = lookupId.split(":").pop();
    if (suffix) variants.add(suffix);
  }
  return Array.from(variants);
}

export function registerQQClient(accountId: string, client: OneBotClient): void {
  for (const key of getAccountKeyVariants(accountId)) {
    clients.set(key, client);
  }
}

export function registerQQConfig(accountId: string, config: QQConfig): void {
  for (const key of getAccountKeyVariants(accountId)) {
    accountConfigs.set(key, config);
  }
}

export function unregisterQQAccount(accountId: string): void {
  for (const key of getAccountKeyVariants(accountId)) {
    clients.delete(key);
    accountConfigs.delete(key);
  }
}

export function getRegisteredQQClient(accountId?: string | null): OneBotClient | undefined {
  for (const key of getAccountKeyVariants(accountId)) {
    const client = clients.get(key);
    if (client) return client;
  }
  if (clients.size === 1) {
    return Array.from(clients.values())[0];
  }
  return undefined;
}

export function getRegisteredQQConfig(accountId?: string | null): QQConfig | undefined {
  for (const key of getAccountKeyVariants(accountId)) {
    const config = accountConfigs.get(key);
    if (config) return config;
  }
  if (accountConfigs.size === 1) {
    return Array.from(accountConfigs.values())[0];
  }
  return undefined;
}
