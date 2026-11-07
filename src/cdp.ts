import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const CDP_PORT = 9222;
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;
export const FLOMO_APP = "/Volumes/out/Applications/flomo.app";

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/** 探测 CDP 调试口是否可用 */
export async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_HTTP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 确保调起带调试口的 flomo：未启动则带参拉起；已启动但无调试口则重启 */
export async function ensureFlomo(): Promise<void> {
  if (await cdpAlive()) return;

  const { stdout } = await exec("pgrep", ["-x", "flomo"]);
  if (stdout.trim()) {
    await exec("osascript", ["-e", 'quit app "flomo"']);
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try { const r = await exec("pgrep", ["-x", "flomo"]); if (!r.stdout.trim()) break; } catch { break; }
    }
  }
  await exec("open", ["-a", FLOMO_APP, "--args", `--remote-debugging-port=${CDP_PORT}`]);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await cdpAlive()) return;
  }
  throw new Error("无法连接 flomo 调试口（等待 15s 超时）。请手动启动: open -a flomo --args --remote-debugging-port=9222，并确认 flomo 已登录");
}

/** 选择主窗口 page target（#/mine），兜底第一个 page */
async function pickTarget(): Promise<CdpTarget> {
  const res = await fetch(`${CDP_HTTP}/json`, { signal: AbortSignal.timeout(2000) });
  const targets = (await res.json()) as CdpTarget[];
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const main = pages.find((t) => t.url.includes("#/mine")) ?? pages[0];
  if (!main) throw new Error("flomo 中没有可用的页面 target，请确认 flomo 主窗口已打开");
  return main;
}

/**
 * 在 flomo 页面上下文执行表达式（每次新建短连接，天然支持并发调用）。
 * expr 应为返回 Promise 或值的表达式，返回值必须可 JSON 序列化。
 */
export async function evalInPage<T = unknown>(expr: string, timeoutMs = 20000): Promise<T> {
  await ensureFlomo();
  const target = await pickTarget();

  return new Promise<T>((resolve, reject) => {
    let msgId = 0;
    const settled = { done: false };
    const ws = new WebSocket(target.webSocketDebuggerUrl!);

    const fail = (err: Error) => {
      if (settled.done) return;
      settled.done = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("CDP evaluate 超时")), timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: ++msgId,
        method: "Runtime.evaluate",
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== msgId) return;
      clearTimeout(timer);
      if (settled.done) return;
      settled.done = true;
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) return reject(new Error(`CDP 错误: ${msg.error.message}`));
      const details = msg.result?.exceptionDetails;
      if (details) {
        return reject(new Error(`页面执行异常: ${String(details.exception?.description ?? details.text).slice(0, 300)}`));
      }
      resolve(msg.result?.result?.value as T);
    };
    ws.onerror = () => fail(new Error("CDP WebSocket 连接失败"));
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
