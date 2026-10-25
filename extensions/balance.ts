/**
 * Balance readout for API relays that expose GET {base}/v1/usage.
 *
 * DATA SOURCE
 *   `GET {base}/v1/usage` with the account's API key. The endpoint is common to
 *   several relay panels and returns:
 *     { balance, remaining, unit, planName, isValid, mode,
 *       usage, model_stats: [...], daily_usage: [...] }
 *   Relays that do not serve /v1/usage simply fail the probe and are skipped.
 *
 * WHERE KEYS COME FROM
 *   ~/.pi/agent/models.json — the provider list pi itself uses. Nothing else is
 *   needed: if pi can talk to a provider, that provider is already here.
 *
 * ZERO-CONFIG ONBOARDING
 *   A fresh install needs no JSON editing. With no balance.json the extension
 *   probes every provider that has a baseUrl + apiKey, keeps the ones that
 *   answer /v1/usage, collapses providers sharing one host (example.com vs
 *   www.example.com), and caches the result to ~/.pi/agent/balance.json.
 *   Nothing prompts and nothing needs the model.
 *
 *   To change the selection:
 *     /balance setup      detect everything, then tick what to show
 *     /balance probe      re-detect and keep every responsive account
 *     /balance add [p]    add one (picker when no argument)
 *     /balance remove p   drop one
 *     /balance list       show the current selection
 *
 * Env overrides:
 *   PI_BALANCE_API_KEY      use this key instead of models.json
 *   PI_BALANCE_BASE_URL     gateway base URL; required together with the key
 *   PI_BALANCE_PROVIDERS    comma-separated provider names
 *   PI_BALANCE_LOW          low-balance threshold, default 5
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const MODELS_JSON_PATH = join(AGENT_DIR, "models.json");
const BALANCE_JSON_PATH = join(AGENT_DIR, "balance.json");
const USAGE_PATH = "/v1/usage";

const NORMAL_REFRESH_MS = 5 * 60 * 1000;
const LOW_BALANCE_REFRESH_MS = 60 * 1000;
const LOW_BALANCE_THRESHOLD = Number.parseFloat(process.env.PI_BALANCE_LOW ?? "5");
const QUERY_TIMEOUT_MS = 20_000;
/** Discovery is best-effort; keep the first start snappy. */
const DISCOVERY_TIMEOUT_MS = 6_000;

type PiProvider = { baseUrl?: unknown; apiKey?: unknown };
type BalanceEntry = { name: string; label?: string };

type Target = {
  /** Provider name in models.json, also used as the stable key. */
  name: string;
  label: string;
  baseUrl: string;
  apiKey: string;
};

type UsageRecord = Record<string, unknown>;
type UsagePayload = {
  balance?: unknown;
  remaining?: unknown;
  unit?: unknown;
  planName?: unknown;
  isValid?: unknown;
  mode?: unknown;
  daily_usage?: unknown;
  model_stats?: unknown;
  usage?: unknown;
};

type AccountResult =
  | { ok: true; target: Target; payload: UsagePayload; balance?: number }
  | { ok: false; target: Target; error: string };

type Detected = { target: Target; ok: boolean; balance?: number; error?: string };

function readJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readProviders(): Record<string, PiProvider> {
  return readJson<{ providers?: Record<string, PiProvider> }>(MODELS_JSON_PATH)?.providers ?? {};
}

/** Normalise a gateway base URL so `base + "/v1/usage"` is correct. */
function normaliseBase(raw: string): string {
  return String(raw).trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

/** Host key used to collapse providers that point at one wallet. */
function hostKey(base: string): string {
  try {
    return new URL(base).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return base.toLowerCase();
  }
}

function labelFor(name: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  // "My Relay GPT" -> "My", "work account" -> "work", "BACKUP-A" -> "BACKUP"
  const first = String(name).trim().split(/[\s_-]+/)[0] || name;
  return first.length > 8 ? first.slice(0, 8) : first;
}

function buildTarget(name: string, explicitLabel?: string): Target | undefined {
  const provider = readProviders()[name];
  if (!provider) return undefined;
  const rawBase = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  if (!rawBase || !apiKey) return undefined;
  return {
    name,
    label: labelFor(name, explicitLabel),
    baseUrl: normaliseBase(rawBase),
    apiKey,
  };
}

/** Every provider that carries both a base URL and a key. */
function allCandidates(): Target[] {
  return Object.keys(readProviders())
    .map((name) => buildTarget(name))
    .filter((t): t is Target => Boolean(t));
}

function readConfig(): BalanceEntry[] | undefined {
  const parsed = readJson<{ providers?: unknown }>(BALANCE_JSON_PATH);
  if (!parsed || !Array.isArray(parsed.providers)) return undefined;
  const entries = parsed.providers.filter(
    (item): item is BalanceEntry =>
      Boolean(item) && typeof item === "object" && typeof (item as any).name === "string",
  );
  return entries.length > 0 ? entries : undefined;
}

function writeConfig(entries: BalanceEntry[]): void {
  writeFileSync(
    BALANCE_JSON_PATH,
    `${JSON.stringify({ providers: entries }, null, 2)}\n`,
    "utf8",
  );
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", USDT: "$", CNY: "¥", RMB: "¥" };

function formatMoney(value: unknown, unit?: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const code = typeof unit === "string" ? unit.toUpperCase() : undefined;
    if (!code) return `$${value.toFixed(2)}`;
    const symbol = CURRENCY_SYMBOLS[code];
    return symbol ? `${symbol}${value.toFixed(2)}` : `${value.toFixed(2)} ${String(unit)}`;
  }
  return value === undefined || value === null ? "-" : String(value);
}

function asRecords(value: unknown): UsageRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is UsageRecord => Boolean(item) && typeof item === "object");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function queryOne(target: Target, timeoutMs = QUERY_TIMEOUT_MS): Promise<AccountResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${target.baseUrl}${USAGE_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${target.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, target, error: `返回非 JSON (${response.status})` };
    }
    if (!response.ok) {
      return { ok: false, target, error: `HTTP ${response.status}: ${text.slice(0, 120)}` };
    }
    const typed = payload as UsagePayload;
    const balance = asNumber(typed.balance) ?? asNumber(typed.remaining);
    // No balance number means this is not a usable /v1/usage endpoint.
    if (balance === undefined) return { ok: false, target, error: "响应无 balance 字段" };
    return { ok: true, target, payload: typed, balance };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? "超时"
          : error.message
        : String(error);
    return { ok: false, target, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every candidate and report which ones actually answer. */
async function detectAll(): Promise<Detected[]> {
  return Promise.all(
    allCandidates().map(async (target) => {
      const result = await queryOne(target, DISCOVERY_TIMEOUT_MS);
      return result.ok
        ? { target, ok: true, balance: result.balance }
        : { target, ok: false, error: result.error };
    }),
  );
}

/** Keep the responsive ones, one row per host. */
function usableTargets(detected: Detected[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const item of detected) {
    if (!item.ok) continue;
    const host = hostKey(item.target.baseUrl);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(item.target);
  }
  return out;
}

/** Footer line: always `label $amount`, so it reads the same in any locale. */
function formatStatusLine(results: AccountResult[]): string {
  if (results.length === 0) return "balance: —";

  return results
    .map((r) =>
      r.ok ? `${r.target.label} ${formatMoney(r.balance, r.payload.unit)}` : `${r.target.label} ?`,
    )
    .join(" · ");
}

function formatUsage(payload: UsagePayload): string {
  const lines: string[] = [];

  const balance = asNumber(payload.balance);
  if (balance !== undefined) lines.push(`钱包余额：${formatMoney(balance, payload.unit)}`);

  // Wallet-mode accounts report the same number twice (remaining === balance)
  // and label the plan "钱包余额", so only show those when they add information.
  const remaining = asNumber(payload.remaining);
  if (remaining !== undefined && remaining !== balance) {
    lines.push(`套餐剩余：${formatMoney(remaining, payload.unit)}`);
  }

  const planName = payload.planName === undefined ? undefined : String(payload.planName);
  if (planName && planName !== "钱包余额") lines.push(`套餐：${planName}`);
  if (payload.mode) lines.push(`模式：${String(payload.mode)}`);
  if (payload.isValid !== undefined) lines.push(`Key 有效：${payload.isValid ? "是" : "否"}`);

  const daily = asRecords(payload.daily_usage);
  if (daily.length > 0) {
    lines.push("", `最近用量（共 ${daily.length} 天）：`);
    for (const day of daily.slice(-3).reverse()) {
      const cost = asNumber(day.actual_cost) ?? asNumber(day.cost);
      lines.push(
        `  ${String(day.date ?? "?")}  请求 ${String(day.requests ?? "-")}  ` +
          `token ${String(day.total_tokens ?? "-")}  ` +
          `花费 ${cost === undefined ? "-" : formatMoney(cost)}`,
      );
    }
  }

  const models = asRecords(payload.model_stats)
    .map((record) => ({ record, total: asNumber(record.total_tokens) ?? 0 }))
    .sort((a, b) => b.total - a.total);

  if (models.length > 0) {
    lines.push("", "模型用量 Top 3：");
    for (const { record, total } of models.slice(0, 3)) {
      lines.push(
        `  ${String(record.model ?? "?")}  请求 ${String(record.requests ?? "-")}  token ${total}`,
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") : "暂无用量数据";
}

function formatReport(results: AccountResult[]): string {
  if (results.length === 1) {
    const only = results[0];
    return only.ok
      ? `${only.target.name} (${only.target.baseUrl})\n${formatUsage(only.payload)}`
      : `${only.target.name}: ${only.error}`;
  }
  return results
    .map((r) =>
      r.ok
        ? `── ${r.target.name} (${r.target.baseUrl}) ──\n${formatUsage(r.payload)}`
        : `── ${r.target.name} (${r.target.baseUrl}) ──\n查询失败：${r.error}`,
    )
    .join("\n\n");
}

function trimPayload(payload: UsagePayload): UsagePayload {
  return {
    ...payload,
    daily_usage: Array.isArray(payload.daily_usage)
      ? payload.daily_usage.slice(-5)
      : payload.daily_usage,
    model_stats: Array.isArray(payload.model_stats)
      ? payload.model_stats.slice(0, 5)
      : payload.model_stats,
  };
}

export default function balanceExtension(pi: ExtensionAPI) {
  let lastStatusLine = "balance: —";
  let lastQueryAt = 0;
  let lowestBalance: number | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshInFlight = false;
  let latestCtx: any;
  /** Discovery writes the cache at most once per process. */
  let discoveryDone = false;

  /** Which accounts to show, in priority order. */
  const resolveTargets = async (): Promise<Target[]> => {
    // Explicit key override. Requires a base URL too — no gateway is hardcoded.
    const envKey = process.env.PI_BALANCE_API_KEY;
    const envBase = process.env.PI_BALANCE_BASE_URL;
    if (envKey && envBase) {
      return [
        {
          name: "env override",
          label: "env",
          baseUrl: normaliseBase(envBase),
          apiKey: envKey,
        },
      ];
    }

    const envList = process.env.PI_BALANCE_PROVIDERS;
    if (envList) {
      const targets = envList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => buildTarget(name))
        .filter((t): t is Target => Boolean(t));
      if (targets.length > 0) return targets;
    }

    const configured = readConfig();
    if (configured) {
      const targets = configured
        .map((entry) => buildTarget(entry.name, entry.label))
        .filter((t): t is Target => Boolean(t));
      if (targets.length > 0) return targets;
    }

    // No usable config: discover, then persist so later starts are instant.
    if (!discoveryDone) {
      discoveryDone = true;
      const found = usableTargets(await detectAll());
      if (found.length > 0) {
        writeConfig(found.map((t) => ({ name: t.name, label: t.label })));
        return found;
      }
    }

    throw new Error(
      "没有找到支持 /v1/usage 的账号。\n" +
        `确认 ${MODELS_JSON_PATH} 里有带 baseUrl + apiKey 的 provider，` +
        "然后运行 /balance setup 手动选择。",
    );
  };

  const applyResults = (ctx: any, results: AccountResult[]) => {
    lastStatusLine = formatStatusLine(results);
    ctx?.ui?.setStatus?.("balance", lastStatusLine);

    const balances = results
      .filter((r): r is Extract<AccountResult, { ok: true }> => r.ok)
      .map((r) => r.balance)
      .filter((v): v is number => v !== undefined);
    lowestBalance = balances.length > 0 ? Math.min(...balances) : undefined;
  };

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay =
      lowestBalance !== undefined && lowestBalance < LOW_BALANCE_THRESHOLD
        ? LOW_BALANCE_REFRESH_MS
        : NORMAL_REFRESH_MS;

    refreshTimer = setTimeout(async () => {
      refreshTimer = undefined;
      if (!latestCtx) return;
      await refresh(latestCtx, false, true).catch(() => undefined);
      scheduleRefresh();
    }, delay);
  };

  const runQuery = async (ctx: any): Promise<AccountResult[]> => {
    const targets = await resolveTargets();
    const results = await Promise.all(targets.map((target) => queryOne(target)));
    lastQueryAt = Date.now();
    applyResults(ctx, results);
    scheduleRefresh();
    return results;
  };

  const refresh = async (ctx: any, notify: boolean, force: boolean) => {
    latestCtx = ctx;
    if (!force && Date.now() - lastQueryAt < NORMAL_REFRESH_MS) return;
    if (refreshInFlight) return;

    refreshInFlight = true;
    try {
      const results = await runQuery(ctx);
      if (notify) {
        ctx.ui.notify(formatReport(results), results.some((r) => r.ok) ? "info" : "error");
      }
      return results;
    } catch (error) {
      lastStatusLine = "balance: —";
      ctx.ui.setStatus("balance", lastStatusLine);
      if (notify) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      scheduleRefresh();
      throw error;
    } finally {
      refreshInFlight = false;
    }
  };

  const saveAndRefresh = async (ctx: any, entries: BalanceEntry[], note: string) => {
    writeConfig(entries);
    discoveryDone = true;
    ctx.ui.notify(
      `${note}\n当前显示：${entries.length > 0 ? entries.map((e) => e.name).join("、") : "（空）"}`,
      "info",
    );
    await refresh(ctx, false, true).catch(() => undefined);
  };

  /** One line per detected provider, annotated with its balance or the failure. */
  const detectLine = (d: Detected): string =>
    `${d.target.name}  ${d.ok ? formatMoney(d.balance) : `✗ ${d.error ?? "不可用"}`}`;

  /** Detect everything, then let the user tick what to display. No JSON editing. */
  const runSetup = async (ctx: any) => {
    if (typeof ctx.ui.select !== "function") {
      ctx.ui.notify(
        "/balance setup 需要交互式终端。\n非交互场景请用 /balance add <provider> 或直接编辑 balance.json。",
        "warning",
      );
      return;
    }

    const detected = await detectAll();
    if (detected.length === 0) {
      ctx.ui.notify(
        `models.json 里没有带 baseUrl 和 API key 的 provider：\n${MODELS_JSON_PATH}`,
        "error",
      );
      return;
    }

    if (detected.every((d) => !d.ok)) {
      ctx.ui.notify(
        `检测到 ${detected.length} 个 provider，但没有一个支持 /v1/usage：\n` +
          detected.map(detectLine).join("\n"),
        "error",
      );
      return;
    }

    // Seed the ticks from the current config when it still resolves,
    // otherwise pre-tick everything that works.
    const existing = readConfig();
    const selected = new Set<string>(
      existing ? existing.map((e) => e.name) : detected.filter((d) => d.ok).map((d) => d.target.name),
    );

    for (;;) {
      const options = [
        ...detected.map((d) => `${selected.has(d.target.name) ? "[x]" : "[  ]"} ${detectLine(d)}`),
        "── 保存并关闭 ──",
      ];
      const picked = await ctx.ui.select(
        "勾选要显示余额的账号（可反复切换，不可用的会显示 ?）",
        options,
      );
      if (!picked || picked.startsWith("──")) break;

      const index = options.indexOf(picked);
      if (index < 0 || index >= detected.length) break;
      const name = detected[index].target.name;
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
    }

    const entries: BalanceEntry[] = detected
      .filter((d) => selected.has(d.target.name))
      .map((d) => ({ name: d.target.name, label: d.target.label }));

    await saveAndRefresh(ctx, entries, `已保存选择（${entries.length} 个账号）。`);
  };

  /** Re-scan every provider and keep the responsive ones. */
  const runProbe = async (ctx: any) => {
    ctx.ui.notify("正在探测各 provider 的 /v1/usage …", "info");
    const detected = await detectAll();
    const usable = usableTargets(detected);
    if (usable.length === 0) {
      ctx.ui.notify(
        `没有 provider 响应 /v1/usage：\n${detected.map(detectLine).join("\n")}`,
        "error",
      );
      return;
    }
    await saveAndRefresh(
      ctx,
      usable.map((t) => ({ name: t.name, label: t.label })),
      `探测完成：${detected.length} 个候选中 ${usable.length} 个可用。`,
    );
  };

  pi.registerCommand("balance", {
    description:
      "余额。直接输入看全部；setup 交互式勾选；probe 重新探测；list / add [p] / remove <p>",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === "setup") {
        await runSetup(ctx);
        return;
      }

      if (sub === "probe") {
        await runProbe(ctx);
        return;
      }

      if (sub === "list") {
        const entries = readConfig();
        const envList = process.env.PI_BALANCE_PROVIDERS;
        const source = envList
          ? `环境变量 PI_BALANCE_PROVIDERS=${envList}`
          : entries
            ? BALANCE_JSON_PATH
            : "尚未配置（下次刷新会自动探测）";
        const rows =
          entries?.map((e) => `  ${e.name}${e.label ? ` (${e.label})` : ""}`) ??
          ["  （无，将自动探测）"];
        ctx.ui.notify(`来源：${source}\n${rows.join("\n")}`, "info");
        return;
      }

      if (sub === "add" || sub === "remove") {
        let name = parts.slice(1).join(" ");

        if (sub === "add" && !name && typeof ctx.ui.select === "function") {
          const configured = new Set((readConfig() ?? []).map((e) => e.name));
          const available = (await detectAll()).filter((d) => !configured.has(d.target.name));
          if (available.length === 0) {
            ctx.ui.notify("没有可添加的新账号。", "info");
            return;
          }
          const labels = available.map(detectLine);
          const picked = await ctx.ui.select("添加哪个账号？", labels);
          if (!picked) return;
          const idx = labels.indexOf(picked);
          if (idx < 0) return;
          name = available[idx].target.name;
        }

        if (!name) {
          ctx.ui.notify(`用法：/balance ${sub} <provider 名>`, "error");
          return;
        }

        const detected = await detectAll();

        if (sub === "add") {
          const hit =
            detected.find((d) => d.target.name === name) ??
            detected.find((d) => d.target.name.toLowerCase().includes(name.toLowerCase()));
          if (!hit) {
            ctx.ui.notify(
              `没有 provider「${name}」。\n已检测到：\n${detected.map(detectLine).join("\n")}`,
              "error",
            );
            return;
          }
          const entries = readConfig() ?? [];
          if (entries.some((e) => e.name === hit.target.name)) {
            ctx.ui.notify(`「${hit.target.name}」已在显示列表里。`, "info");
            return;
          }
          entries.push({ name: hit.target.name, label: hit.target.label });
          await saveAndRefresh(
            ctx,
            entries,
            hit.ok
              ? `已添加「${hit.target.name}」（${formatMoney(hit.balance)}）。`
              : `已添加「${hit.target.name}」，但它当前不可用：${hit.error}`,
          );
          return;
        }

        const entries = readConfig() ?? [];
        const next = entries.filter((e) => e.name !== name);
        if (next.length === entries.length) {
          ctx.ui.notify(
            `「${name}」不在显示列表里。\n当前：${entries.map((e) => e.name).join("、") || "（空）"}`,
            "info",
          );
          return;
        }
        await saveAndRefresh(ctx, next, `已移除「${name}」。`);
        return;
      }

      await refresh(ctx, true, true);
    },
  });

  pi.registerTool({
    name: "check_balance",
    label: "Check Balance",
    description:
      "Query API gateway wallet balance and usage (GET /v1/usage) for every configured account. " +
      "Covers any relay that serves a balance field at GET /v1/usage.",
    promptSnippet:
      "Check API gateway balance or usage when the user asks about quota or spending.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const results = await runQuery(ctx);
        const text = results
          .map((r) =>
            r.ok
              ? `${r.target.name} (${r.target.baseUrl})\n${formatUsage(r.payload)}\n\nRaw (trimmed):\n${JSON.stringify(trimPayload(r.payload), null, 2)}`
              : `${r.target.name} (${r.target.baseUrl})\n查询失败：${r.error}`,
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text }],
          details: {
            accounts: results.map((r) => ({
              name: r.target.name,
              ok: r.ok,
              balance: r.ok ? r.balance : undefined,
              error: r.ok ? undefined : r.error,
            })),
          },
          isError: results.every((r) => !r.ok),
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    try {
      await refresh(ctx, false, true);
    } catch {
      ctx.ui.setStatus("balance", lastStatusLine);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refresh(ctx, false, false).catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    latestCtx = undefined;
  });
}
