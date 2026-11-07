import { evalInPage } from "./cdp.js";

/**
 * flomo API 调用层：直接复用 flomo 页面内的 $api 单例（Vuex store._vm.$api，
 * webpack 打包的 API 类，static 方法含 callPromise/callMemoWrite/callMemoDelete）。
 * 签名（md5）、V2 网关路由、公共头全部由应用自身逻辑处理，随 flomo 更新自动保持一致。
 */

export interface ApiResponse<T = unknown> {
  code: number;
  message?: string;
  data: T;
}

export class FlomoApiError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

function wrapError(env: ApiResponse): never {
  const hint = env.code === -10 ? "（未登录：请在 flomo 应用中重新登录）"
    : env.code === -20 ? "（编辑冲突：笔记已被其他端修改）" : "";
  throw new FlomoApiError(`flomo API 错误 code=${env.code} ${env.message ?? ""}${hint}`, env.code);
}

/** 通用接口（相对路径 = v1；读写 memo 请用 memoWrite/memoDelete 走 v2） */
export async function callApi<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const env = await evalInPage<ApiResponse<T>>(`(async()=>{try{
    const r=await window.__flomoVuexStore._vm.$api.callPromise(${JSON.stringify(method)},${JSON.stringify(path)},${JSON.stringify(params)});
    return r&&r.data;
  }catch(e){return{code:-998,message:String(e).slice(0,200),data:null}}})()`);
  if (!env || typeof env.code !== "number") {
    throw new FlomoApiError(`flomo 响应异常: ${JSON.stringify(env).slice(0, 200)}`, -999);
  }
  if (env.code !== 0) wrapError(env);
  return env.data;
}

/** memo.updated_at（本地时区字符串）→ unix 秒（flomo 游标格式，实测验证） */
export function uaToUnix(ua: string | undefined | null): number {
  if (!ua) return 0;
  const ms = Date.parse(String(ua).replace(" ", "T"));
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/** 当前本地时间 "YYYY-MM-DD HH:mm:ss"（flomo created_at 格式） */
export function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 系统时区偏移 "H:M" 格式（flomo tz 参数） */
export function tzStr(): string {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "" : "-";
  const abs = Math.abs(off);
  return `${sign}${Math.floor(abs / 60)}:${abs % 60}`;
}
