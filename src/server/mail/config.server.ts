import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackendId } from "../../lib/mail/backend.ts";
import {
  headerModeOf,
  toBotConnectionView,
  type BotConnectionView,
  type HeaderMode,
} from "../../lib/mail/bot-connection.ts";
import { demoMode } from "../../lib/env.server.ts";
import { DEMO_ADDRESS, aliasesFor, type Alias } from "../../lib/mail/model.ts";
import { demoMailbox } from "../../lib/mail/demo-mailbox.ts";
import { demoPublicConfig, type PublicMailConfig } from "../../lib/mail/public-config.ts";
import { readDemoConnection, writeDemoConnection } from "./demo-state.server.ts";

export type MailSecrets = {
  webhookUrl: string;
  webhookKey: string;
  headerMode?: HeaderMode;
};

export type LoadedConfig = PublicMailConfig & {
  secrets: MailSecrets | null;
  delivery: BotConnectionView;
};

type MailboxSpec = {
  webhookUrl: string;
  webhookKey: string;
  headerMode: HeaderMode;
};

type SqlRunner = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

const CONFIG_ID = "config";
const URL_MAX = 2000;
const KEY_MAX = 2000;

const EMPTY_DELIVERY: BotConnectionView = { webhookUrl: "", headerMode: "bearer", keySet: false };

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAliases(value: unknown, address: string, displayName: string): Alias[] {
  if (!Array.isArray(value)) return aliasesFor(address, displayName);
  const aliases: Alias[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const email = asString(row.email);
    if (!email.includes("@")) continue;
    const tag = asString(row.tag);
    aliases.push({
      email,
      tag: tag || null,
      name: asString(row.name) || (tag ? tag : displayName || "Primary"),
    });
  }
  return aliases.length > 0 ? aliases : aliasesFor(address, displayName);
}

function specFromRow(row: Record<string, unknown>): MailboxSpec {
  return {
    webhookUrl: asString(row.webhookUrl),
    webhookKey: asString(row.webhookKey),
    headerMode: headerModeOf(row.headerMode),
  };
}

export function parseMailboxSpec(raw: unknown): MailboxSpec {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { webhookUrl: "", webhookKey: "", headerMode: "bearer" };
  }
  return specFromRow(value as Record<string, unknown>);
}

function secretsFrom(spec: MailboxSpec): MailSecrets | null {
  if (!spec.webhookUrl || !spec.webhookKey) return null;
  return { webhookUrl: spec.webhookUrl, webhookKey: spec.webhookKey, headerMode: spec.headerMode };
}

function withDelivery(base: LoadedConfig, spec: MailboxSpec): LoadedConfig {
  return {
    ...base,
    secrets: secretsFrom(spec),
    delivery: toBotConnectionView(spec),
  };
}

export function parseConfig(raw: unknown): LoadedConfig {
  const demo = demoPublicConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...demo, secrets: null, delivery: EMPTY_DELIVERY };
  }
  const row = raw as Record<string, unknown>;
  const backend: BackendId = "bot-bridge";
  const displayName = asString(row.displayName) || demo.displayName;
  const address = asString(row.address) || DEMO_ADDRESS;
  const spec = specFromRow(row);
  return withDelivery(
    {
      backend,
      displayName,
      address,
      aliases: parseAliases(row.aliases, address, displayName),
      configured: true,
      secrets: null,
      delivery: EMPTY_DELIVERY,
    },
    spec,
  );
}

export function toPublicConfig(loaded: LoadedConfig): PublicMailConfig {
  return {
    backend: loaded.backend,
    displayName: loaded.displayName,
    address: loaded.address,
    aliases: loaded.aliases,
    configured: loaded.configured,
  };
}

/** Empty is allowed. Anything else must be http(s) with no userinfo, so a key cannot hide in the URL. */
export function webhookUrlAllowed(value: string): boolean {
  if (!value) return true;
  if (value.length > URL_MAX) return false;
  try {
    const url = new URL(value);
    // https only, so the webhook key never travels in cleartext.
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

async function readFileConfig(root: string): Promise<LoadedConfig> {
  try {
    const text = await readFile(join(root, "data", "config.json"), "utf8");
    return parseConfig(JSON.parse(text) as unknown);
  } catch {
    return { ...demoPublicConfig(), secrets: null, delivery: EMPTY_DELIVERY };
  }
}

async function openSql(): Promise<SqlRunner | null> {
  try {
    const { getSql } = await import("@/lib/db");
    return await getSql();
  } catch {
    return null;
  }
}

async function readMailboxSpec(sql: SqlRunner): Promise<MailboxSpec | "missing"> {
  const rows = await sql<{
    spec: unknown;
  }>`select spec from mail_mailbox_config where id = ${CONFIG_ID}`;
  const row = rows[0];
  if (!row) return "missing";
  return parseMailboxSpec(row.spec);
}

/**
 * File config, then the mailbox row when it exists.
 * A present row wins for the webhook URL, key, and header, even when those are blank.
 * Pass `sql` to use that connection. Pass `null` to skip the database. Omit it to open one.
 */
export async function loadMailConfig(
  root = process.cwd(),
  sql?: SqlRunner | null,
): Promise<LoadedConfig> {
  if (sql === undefined && demoMode()) {
    const mail = demoMailbox();
    return {
      ...demoPublicConfig(),
      displayName: mail.settings.displayName,
      address: mail.settings.defaultFrom,
      aliases: mail.aliases,
      configured: false,
      secrets: null,
      delivery: readDemoConnection(),
    };
  }
  const file = await readFileConfig(root);
  const resolved = sql === undefined ? await openSql() : sql;
  if (!resolved) return file;
  try {
    const spec = await readMailboxSpec(resolved);
    if (spec === "missing") return file;
    return withDelivery(file, spec);
  } catch {
    return file;
  }
}

export async function publicMailConfig(root = process.cwd()): Promise<PublicMailConfig> {
  return toPublicConfig(await loadMailConfig(root));
}

export async function webhookTarget(root = process.cwd()): Promise<MailSecrets | null> {
  const loaded = await loadMailConfig(root);
  return loaded.secrets;
}

/** Same resolution as `webhookTarget`, using the caller's database instead of opening another. */
export async function webhookTargetUsing(
  sql: SqlRunner,
  root = process.cwd(),
): Promise<MailSecrets | null> {
  const loaded = await loadMailConfig(root, sql);
  return loaded.secrets;
}

export async function readBotConnection(root = process.cwd()): Promise<BotConnectionView> {
  const loaded = await loadMailConfig(root);
  return loaded.delivery;
}

export async function saveMailboxConnection(
  sql: SqlRunner,
  input: { webhookUrl: string; webhookKey: string; headerMode: HeaderMode },
  root = process.cwd(),
): Promise<BotConnectionView> {
  const webhookUrl = input.webhookUrl.trim();
  if (!webhookUrlAllowed(webhookUrl)) throw new Error("invalid");
  const typed = input.webhookKey.trim();
  if (typed.length > KEY_MAX) throw new Error("invalid");
  const headerMode = headerModeOf(input.headerMode);
  const current = await readMailboxSpec(sql);
  let previousKey = "";
  if (current === "missing") {
    const file = await readFileConfig(root);
    previousKey = file.secrets?.webhookKey ?? "";
  } else {
    previousKey = current.webhookKey;
  }
  const spec: MailboxSpec = {
    webhookUrl,
    webhookKey: typed || previousKey,
    headerMode,
  };
  const body = JSON.stringify(spec);
  await sql`insert into mail_mailbox_config (id, spec) values (${CONFIG_ID}, ${body})
    on conflict (id) do update set spec = excluded.spec`;
  return toBotConnectionView(spec);
}

export async function saveBotConnection(
  input: { webhookUrl: string; webhookKey: string; headerMode: HeaderMode },
  root = process.cwd(),
): Promise<BotConnectionView> {
  if (demoMode()) {
    const webhookUrl = input.webhookUrl.trim();
    if (!webhookUrlAllowed(webhookUrl)) throw new Error("invalid");
    const typed = input.webhookKey.trim();
    if (typed.length > KEY_MAX) throw new Error("invalid");
    const current = readDemoConnection();
    const view: BotConnectionView = {
      webhookUrl,
      headerMode: headerModeOf(input.headerMode),
      keySet: webhookUrl.length > 0 && (typed.length > 0 || current.keySet),
    };
    writeDemoConnection(view);
    return view;
  }
  const sql = await openSql();
  if (!sql) throw new Error("invalid");
  return saveMailboxConnection(sql, input, root);
}
