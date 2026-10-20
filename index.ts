import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

/** Returns severity: 0=normal, 1=low balance, 2=critical/insufficient */
function balanceSeverity(total: number, isAvailable: boolean): number {
  if (!isAvailable) return 2;
  if (total < 1) return 2;
  if (total < 5) return 1;
  return 0;
}

// ─── Fetch ───────────────────────────────────────────────────────
async function fetchBalance(apiKey: string): Promise<UsageData> {
  const resp = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json()) as BalanceData;

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

// ─── Main ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let apiKey = "";
  let usage: UsageData | null = null;
  let footerOn = false;
  let footerGeneration = 0;
  let _tui: any = null;
  let thinkingLevel = "off";
  const IDLE_REFRESH_MS = 30 * 60 * 1000;  // 闲时定时刷新: 30 分钟
  let latestCtx: any = null;              // 最近一次事件拿到的 ctx,供定时器使用
  let agentBusy = false;                  // agent 生成中 = true,定时刷新只在闲时执行
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  async function getUsage(): Promise<UsageData> {
    if (!apiKey) throw new Error("DeepSeek API key not found in auth.json");
    if (usage && Date.now() - usage._ts < CACHE_MS) return usage;
    usage = await fetchBalance(apiKey);
    return usage;
  }

  function isDeepSeek(ctx: any) { return ctx.model?.provider === "deepseek"; }
  function requestRenderSafe(tui: any): void {
    try { tui?.requestRender?.(); } catch { /* footer may already be disposed */ }
  }

  function trigger() {
    setTimeout(() => requestRenderSafe(_tui), 0);
  }

  // ── Refresh ─────────────────────────────────────────────────
  async function refresh(ctx: any) {
    if (!apiKey) return;
    if (!isDeepSeek(ctx)) {
      if (usage) { usage = null; toggleFooter(ctx); }
      return;
    }
    try { await getUsage(); trigger(); } catch { /* silent */ }
  }

  // ── Footer ──────────────────────────────────────────────────
  function toggleFooter(ctx: any, force = false) {
    if (isDeepSeek(ctx) && apiKey) {
      if (!footerOn || force) {
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
    const generation = ++footerGeneration;
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => {
        if (generation === footerGeneration) requestRenderSafe(tui);
      });
      return {
        // footer 可能被 pi 或其他扩展从外部 dispose(我们不知情),
        // 必须同步 footerOn,并避免旧 footer 清理新 footer 的状态
        dispose: () => {
          try { unsub(); } catch { /* already disposed */ }
          if (generation === footerGeneration) {
            _tui = null;
            footerOn = false;
          }
        },
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
          const cachePartIndexes: number[] = [];
          const tokenPartIndexes: number[] = [];
          let costPartIndex = -1;
          if (ti) { tokenPartIndexes.push(parts.length); parts.push(`↑${formatTokens(ti)}`); }
          if (to) { tokenPartIndexes.push(parts.length); parts.push(`↓${formatTokens(to)}`); }
          if (tr) { cachePartIndexes.push(parts.length); parts.push(`R${formatTokens(tr)}`); }
          if (tw) { cachePartIndexes.push(parts.length); parts.push(`W${formatTokens(tw)}`); }
          if (tc) { costPartIndex = parts.length; parts.push(`$${tc.toFixed(3)}`); }

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

          // DeepSeek balance (exclamation marks for severity)
          if (usage) {
            const sev = balanceSeverity(usage.total, usage.isAvailable);
            const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
            const cur = usage.currency === "CNY" ? "¥" : usage.currency === "USD" ? "$" : usage.currency + " ";
            parts.push(`${flag}${cur}${usage.total.toFixed(2)}`);
          }

          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          // Always show provider label
          const withProv = `(deepseek) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }

          // 宽度不足时的省略顺序 (与 pi-codex-usage 一致): 供应商名 → 缓存计数 → 费用 → 累计 token
          const fits = () => visibleWidth(left) + 2 + visibleWidth(right) <= width;
          if (!fits()) {
            for (const index of cachePartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && tokenPartIndexes.length > 0) {
            for (const index of tokenPartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
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

  // ── Idle timer (每 30 分钟闲时刷新) ───────────────────────
  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(() => {
      if (agentBusy) return;                    // 生成中,跳过本轮
      const ctx = latestCtx;
      if (!ctx || !isDeepSeek(ctx) || !apiKey) return;  // 只在对应 provider 下刷新
      refresh(ctx);
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();               // 不阻止进程退出
  }

  function stopIdleTimer() {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    apiKey = getApiKey();
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;                            // 强制重建 footer,确保闭包捕获新 ctx
    toggleFooter(ctx, true);
    if (apiKey) refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    stopIdleTimer();
    latestCtx = null;
  });

  pi.on("agent_start", async (_e, ctx) => { latestCtx = ctx; agentBusy = true; });
  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (apiKey) refresh(ctx);
  });

  // 每条 assistant 消息结束 (含工具调用轮次) 都尝试刷新一次, 让单轮很长的任务
  // 中途也能及时看到用量变化; 同一个 CACHE_MS 窗口内最多发起一次 (含失败重试), 避免过快
  let lastMidRefreshAt = 0;
  pi.on("message_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (event?.message?.role !== "assistant") return;
    if (!isDeepSeek(ctx) || !apiKey) return;
    const now = Date.now();
    if (now - lastMidRefreshAt < CACHE_MS) return;
    lastMidRefreshAt = now;
    refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isDeepSeek(ctx)) {
      // 延迟到 macrotask: 让排在我们后面的扩展先完成卸载,我们再挂载,避免被覆盖
      setTimeout(() => {
        const currentCtx = latestCtx;
        if (!currentCtx || !isDeepSeek(currentCtx)) return;
        try {
          toggleFooter(currentCtx, true);
          if (apiKey) refresh(currentCtx);
        } catch { /* session or footer was disposed */ }
      }, 0);
    } else {
      // 切走时立即卸载自己,给目标 provider 的扩展让位
      toggleFooter(ctx);
      if (apiKey) refresh(ctx);
    }
  });
  pi.on("thinking_level_select", async (event: any) => { thinkingLevel = event?.level || "off"; trigger(); });

  // ── /deepseek ─────────────────────────────────────────────
  pi.registerCommand("deepseek", {
    description: "Show DeepSeek API balance",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage();
        const cur = d.currency;
        const fmt = (n: number) => n.toFixed(2);
        ctx.ui.notify(
          [
            `══ DeepSeek Balance (${cur}) ══`,
            `Total:     ${fmt(d.total)} ${cur}`,
            `Granted:   ${fmt(d.granted)} ${cur}`,
            `Topped up: ${fmt(d.toppedUp)} ${cur}`,
            `Status:    ${d.isAvailable ? "✓ Available" : "⚠ Insufficient balance"}`,
          ].join("\n"),
          d.isAvailable ? "info" : "warning",
        );
      } catch (err: any) {
        ctx.ui.notify(`DeepSeek: ${err.message}`, "error");
      }
    },
  });

}
