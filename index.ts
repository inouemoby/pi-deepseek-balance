import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────
interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceData {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

interface UsageData {
  // Prefer CNY if available, else first currency
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  isAvailable: boolean;
  _ts: number;
}

const CACHE_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────
function getApiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf-8"));
    if (auth.deepseek?.key) return auth.deepseek.key;
  } catch {}
  return "";
}

function humanNum(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toFixed(2);
}

// ─── Fetch ───────────────────────────────────────────────────────
async function fetchBalance(apiKey: string): Promise<UsageData> {
  const resp = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json()) as BalanceData;

  // Prefer CNY, fallback to first entry
  const info =
    json.balance_infos?.find((b) => b.currency === "CNY") ||
    json.balance_infos?.[0];

  if (!info) throw new Error("No balance info returned");

  return {
    currency: info.currency,
    total: parseFloat(info.total_balance) || 0,
    granted: parseFloat(info.granted_balance) || 0,
    toppedUp: parseFloat(info.topped_up_balance) || 0,
    isAvailable: json.is_available,
    _ts: Date.now(),
  };
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

// ─── Main ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let apiKey = "";
  let usage: UsageData | null = null;
  let footerOn = false;
  let _tui: any = null;
  let thinkingLevel = "off";

  async function getUsage(): Promise<UsageData> {
    if (!apiKey) throw new Error("DeepSeek API key not found in auth.json");
    if (usage && Date.now() - usage._ts < CACHE_MS) return usage;
    usage = await fetchBalance(apiKey);
    return usage;
  }

  function isDeepSeek(ctx: any): boolean {
    const p = ctx.model?.provider?.toLowerCase() ?? "";
    return p === "deepseek" || p.includes("deepseek");
  }
  function trigger() { if (_tui) setTimeout(() => _tui.requestRender?.(), 0); }

  // ── Build usage summary string ────────────────────────────
  function usageSummary(): string {
    if (!usage) return "";
    const cur = usage.currency;
    const sev = !usage.isAvailable ? "⚠⚠" : usage.total < 1 ? "⚠" : "";
    return `${sev}DS:${humanNum(usage.total)}${cur}`;
  }

  // ── Update all display surfaces ───────────────────────────
  function updateAll(ctx: any) {
    if (!ctx || !ctx.ui) return;

    // 1. TUI footer
    toggleFooter(ctx);

    // 2. Status line (works in both TUI and RPC mode)
    if (isDeepSeek(ctx) && apiKey && usage) {
      ctx.ui.setStatus("deepseek-usage", usageSummary());
    } else {
      ctx.ui.setStatus("deepseek-usage", undefined);
    }

    // 3. Widget as fallback
    if (isDeepSeek(ctx) && apiKey && usage) {
      const cur = usage.currency;
      const lines: string[] = [
        "─── DeepSeek Balance ───",
        `Total: ${humanNum(usage.total)} ${cur}`,
        `  Granted: ${humanNum(usage.granted)} ${cur}`,
        `  Topped up: ${humanNum(usage.toppedUp)} ${cur}`,
        `Available: ${usage.isAvailable ? "Yes" : "No (insufficient)"}`,
      ];
      ctx.ui.setWidget("deepseek-usage", lines);
    } else {
      ctx.ui.setWidget("deepseek-usage", undefined);
    }
  }

  // ── Refresh ─────────────────────────────────────────────────
  async function refresh(ctx: any) {
    if (!apiKey) return;
    if (!isDeepSeek(ctx)) {
      if (usage) { usage = null; updateAll(ctx); }
      return;
    }
    try {
      await getUsage();
      trigger();
      updateAll(ctx);
    } catch { /* silent */ }
  }

  // ── Footer (TUI mode only) ────────────────────────────────
  function toggleFooter(ctx: any) {
    if (isDeepSeek(ctx) && apiKey) {
      if (!footerOn) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => { unsub(); _tui = null; },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost.total;
            }
          }
          const parts: string[] = [];
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tr) parts.push(`R${formatTokens(tr)}`);
          if (tw) parts.push(`W${formatTokens(tw)}`);
          if (tc) parts.push(`$${tc.toFixed(3)}`);

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // DeepSeek balance
          if (usage) {
            const sev = !usage.isAvailable ? "!!" : usage.total < 1 ? "!" : "";
            parts.push(`${sev}DS:${humanNum(usage.total)}${usage.currency}`);
          }
          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          if (m) {
            const withProv = `(${m.provider}) ${right}`;
            if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
              right = withProv;
            }
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    apiKey = getApiKey();
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    updateAll(ctx);
    if (apiKey) refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    updateAll(ctx);
    if (apiKey) refresh(ctx);
  });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event.level || "off"; trigger(); });
  pi.on("agent_end", async (_e, ctx) => {
    if (!apiKey || !isDeepSeek(ctx)) return;
    try {
      await getUsage();
      updateAll(ctx);
      ctx.ui.notify(`DeepSeek: ${usageSummary()}`, "info");
    } catch { /* silent */ }
  });

  // ── /ds command ──────────────────────────────────────────
  pi.registerCommand("ds", {
    description: "Show DeepSeek API balance",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage();
        const cur = d.currency;
        const lines = [
          `══ DeepSeek Balance (${cur}) ══`,
          `Total:     ${humanNum(d.total)} ${cur}`,
          `Granted:   ${humanNum(d.granted)} ${cur}`,
          `Topped up: ${humanNum(d.toppedUp)} ${cur}`,
          `Status:    ${d.isAvailable ? "✓ Available" : "⚠ Insufficient balance"}`,
        ];
        ctx.ui.notify(lines.join("\n"), d.isAvailable ? "info" : "warning");
      } catch (err: any) {
        ctx.ui.notify(`DeepSeek: ${err.message}`, "error");
      }
    },
  });

  // ── deepseek_usage tool ──────────────────────────────────
  pi.registerTool({
    name: "deepseek_usage",
    label: "DeepSeek Usage",
    description: "Check DeepSeek API account balance and availability. Returns total/granted/topped-up balance in CNY and USD.",
    promptSnippet: "Check DeepSeek API remaining balance",
    promptGuidelines: [
      "Use deepseek_usage to check DeepSeek API balance before expensive operations.",
      "Use deepseek_usage when the user asks about DeepSeek usage, limits, or remaining credits.",
    ],
    parameters: Type.Object({}),
    async execute(_id: any, _p: any, _s: any, _up: any, _ctx: any) {
      try {
        const d = await getUsage();
        const result = {
          currency: d.currency,
          total: d.total,
          granted: d.granted,
          toppedUp: d.toppedUp,
          isAvailable: d.isAvailable,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    },
  });
}
