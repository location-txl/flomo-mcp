import { z } from "zod";
import { callApi, uaToUnix, nowStr, tzStr } from "./api.js";
import { evalInPage } from "./cdp.js";

// ---------- 数据结构 ----------

export interface FlomoMemo {
  slug: string;
  content: string;
  created_at: string;
  updated_at?: string;
  tags?: string[] | { name?: string }[];
  file_ids?: string[];
  pinned?: number;
  pin?: number;
  [k: string]: unknown;
}

export interface FlomoTag {
  id: number;
  name: string;
  pin?: number;
  order?: number;
  updated_at?: string;
  deleted_at?: string | null;
  [k: string]: unknown;
}

// ---------- 工具实现 ----------

export async function whoami() {
  const info = await evalInPage<{
    email: string | null; name: string | null; slug: string | null;
    pro: boolean; memo_count: number; tag_count: number; login: boolean;
  }>(`(function(){
    const me = JSON.parse(localStorage.getItem('me')||'{}');
    const s = window.__flomoVuexStore && window.__flomoVuexStore.state;
    return {
      login: !!me.access_token,
      email: me.email ? me.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
      name: me.name || null, slug: me.slug || null,
      pro: !!(me.pro_type),
      memo_count: s ? s.memo_count : -1,
      tag_count: s && Array.isArray(s.tags) ? s.tags.length : -1
    };
  })()`);
  if (!info.login) return "flomo 未登录：请打开 flomo 应用登录后重试";
  return [
    `flomo 账号: ${info.name ?? info.email}`,
    `笔记总数: ${info.memo_count}，标签总数: ${info.tag_count}`,
    `Pro: ${info.pro ? "是" : "否"}`,
  ].join("\n");
}

function memoBrief(m: FlomoMemo, contentLen = 200): object {
  const text = m.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
  const tags = Array.isArray(m.tags)
    ? m.tags.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
    : [];
  return {
    slug: m.slug,
    created_at: m.created_at,
    updated_at: m.updated_at,
    tags,
    excerpt: text.slice(0, contentLen),
  };
}

interface PageCursor { ua: number; slug: string }

function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s: string): PageCursor | null {
  try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as PageCursor; } catch { return null; }
}

/**
 * 列出笔记。mode=recent：最近更新（服务端 cap 200 条，最新在前）；
 * mode=all：全量按更新时间升序翻页（游标）。
 */
export async function listMemos(limit: number, mode: "recent" | "all", cursor?: string) {
  if (mode === "recent") {
    const memos = await callApi<FlomoMemo[]>("GET", "/memo/latest_updated_desc", { limit: 200, tz: tzStr() });
    const arr = Array.isArray(memos) ? memos : [];
    return { mode, total: arr.length, memos: arr.slice(0, limit).map((m) => memoBrief(m)) };
  }
  const cur = cursor ? decodeCursor(cursor) : null;
  const params: Record<string, unknown> = { limit: Math.min(Math.max(limit, 1), 100), tz: tzStr() };
  if (cur?.ua) params.latest_updated_at = cur.ua;
  if (cur?.slug) params.latest_slug = cur.slug;
  const memos = await callApi<FlomoMemo[]>("GET", "/memo/updated/", params);
  const arr = Array.isArray(memos) ? memos : [];
  const last = arr[arr.length - 1];
  const next = last && arr.length >= Math.min(limit, 100)
    ? { next_cursor: encodeCursor({ ua: uaToUnix(String(last.updated_at ?? "")), slug: String(last.slug ?? "") }) }
    : {};
  return { mode, total: arr.length, ...next, memos: arr.map((m) => memoBrief(m)) };
}

export async function searchMemos(keyword: string, limit: number) {
  const kw = keyword.toLowerCase();
  const all: FlomoMemo[] = [];
  let cur: PageCursor | null = null;
  // /memo/updated/ 升序全量翻页（unix 游标），上限 40 页保护
  for (let page = 0; page < 40; page++) {
    const params: Record<string, unknown> = { limit: 100, tz: tzStr() };
    if (cur?.ua) params.latest_updated_at = cur.ua;
    if (cur?.slug) params.latest_slug = cur.slug;
    const batch = await callApi<FlomoMemo[]>("GET", "/memo/updated/", params);
    const arr = Array.isArray(batch) ? batch : [];
    all.push(...arr);
    if (arr.length < 100) break;
    const last = arr[arr.length - 1];
    cur = { ua: uaToUnix(String(last.updated_at ?? "")), slug: String(last.slug ?? "") };
  }

  const hits = all.filter((m) => {
    const text = (m.content ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
    const tags = Array.isArray(m.tags)
      ? m.tags.map((t) => (typeof t === "string" ? t : t?.name ?? "")).join(" ").toLowerCase()
      : "";
    return text.includes(kw) || tags.includes(kw);
  }).sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)));

  return {
    keyword,
    scanned: all.length,
    matched: hits.length,
    memos: hits.slice(0, limit).map((m) => memoBrief(m)),
  };
}

/** GET /memo/<slug> 响应可能是对象或单元素数组，统一取出 */
async function fetchMemoRaw(slug: string): Promise<FlomoMemo> {
  const memo = await callApi<FlomoMemo>("GET", `/memo/${encodeURIComponent(slug)}`, { tz: tzStr() });
  const d = (memo && typeof memo === "object" && !Array.isArray(memo) && (memo as FlomoMemo).slug)
    ? memo
    : (Array.isArray(memo) ? (memo[0] as FlomoMemo) : (memo as FlomoMemo));
  if (!d?.slug) throw new Error(`笔记 ${slug} 不存在或响应格式异常`);
  return d;
}

export async function getMemo(slug: string) {
  const d = await fetchMemoRaw(slug);
  return {
    slug: d.slug,
    created_at: d.created_at,
    updated_at: d.updated_at,
    tags: Array.isArray(d.tags) ? d.tags : [],
    content_html: d.content,
    content_text: d.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

export async function createMemo(content: string) {
  const data = await callApi<{ slug?: string } | null>("PUT", "/memo", {
    content,
    created_at: nowStr(),
    source: "web",
    file_ids: [],
    tz: tzStr(),
  });
  const slug = (data && typeof data === "object" && !Array.isArray(data))
    ? (data as { slug?: string }).slug ?? null
    : null;
  return { ok: true, slug, note: "创建成功。标签请在 content 中使用 #标签名 语法" };
}

export async function updateMemo(slug: string, content: string) {
  const d = await fetchMemoRaw(slug);
  const fileIds = Array.isArray(d.file_ids) ? d.file_ids : [];
  const pin = typeof d.pinned === "number" ? d.pinned : (typeof d.pin === "number" ? d.pin : 0);
  await callApi("PUT", `/memo/${encodeURIComponent(slug)}`, {
    content,
    created_at: d.created_at,
    local_updated_at: Math.floor(Date.now() / 1000),
    source: "web",
    file_ids: fileIds,
    tz: tzStr(),
    pin,
  });
  return { ok: true, slug, updated_at: nowStr() };
}

export async function deleteMemo(slug: string) {
  await callApi("DELETE", `/memo/${encodeURIComponent(slug)}`);
  return { ok: true, slug, note: "已移入回收站" };
}

/** 全量标签：优先 Vuex 内存直读（flomo 已同步全量，含 id），fallback /tag/updated/ */
export async function listTags() {
  const fromStore = await evalInPage<{ ok: boolean; total: number; tags?: { id: number; name: string; pinned: boolean; count?: number }[] }>(`(function(){
    try{
      const s=window.__flomoVuexStore.state;
      const tags=s.tags;
      if(!Array.isArray(tags)||!tags.length)return{ok:false};
      const pinned=new Set((s.pinned_tags||[]).map(t=>t&&(t.name||t)));
      return{ok:true,total:tags.length,tags:tags.map(t=>({id:t.id,name:t.name,pinned:pinned.has(t.name),count:t.count}))};
    }catch(e){return{ok:false}}
  })()`);
  if (fromStore?.ok && fromStore.tags?.length) {
    return { source: "memory", total: fromStore.total, tags: fromStore.tags };
  }
  // fallback：API（服务器每页较小，unix 游标循环）
  const all: FlomoTag[] = [];
  let curUa = 0;
  let curId: number | null = null;
  for (let page = 0; page < 60; page++) {
    const params: Record<string, unknown> = { limit: 500, latest_updated_at: curUa, tz: tzStr() };
    if (curId !== null) params.latest_id = curId;
    const batch = await callApi<FlomoTag[]>("GET", "/tag/updated/", params);
    const arr = (Array.isArray(batch) ? batch : []).filter((t) => !t.deleted_at);
    all.push(...arr);
    if (arr.length === 0) break;
    const last = arr[arr.length - 1];
    const newUa = uaToUnix(String(last.updated_at ?? ""));
    if (page > 0 && newUa <= curUa) break;
    curUa = newUa;
    curId = last.id;
    if (arr.length < 8) break;
  }
  return {
    source: "api",
    total: all.length,
    tags: all.map((t) => ({ id: t.id, name: t.name, pinned: !!t.pin, count: undefined })),
  };
}

/** 标签重命名：走 /tag/rename 按名字操作（服务器裁决存在性；Vuex 快照可能滞后于新标签） */
export async function renameTag(oldName: string, newName: string) {
  await callApi("POST", "/tag/rename", { old_tag: oldName.trim(), new_tag: newName.trim() });
  return { ok: true, from: oldName, to: newName };
}

export async function pinTag(tagName: string, pin: boolean) {
  await callApi("POST", pin ? "/tag/pin" : "/tag/unpin", { tag: tagName.trim(), tz: tzStr() });
  return { ok: true, tag: tagName, pinned: pin };
}

// ---------- zod schemas（MCP 注册用） ----------

export const schemas = {
  limit: z.number().int().min(1).max(200).default(20).describe("返回条数"),
  mode: z.enum(["recent", "all"]).default("recent").describe("recent=最近更新(最新在前，最多200条)；all=全量按时间升序翻页"),
  cursor: z.string().optional().describe("翻页游标（上次返回的 next_cursor，仅 mode=all）"),
  keyword: z.string().min(1).describe("搜索关键词（匹配正文与标签）"),
  slug: z.string().describe("笔记 slug"),
  content: z.string().min(1).describe("笔记内容，支持 HTML 与 #标签名 语法"),
  oldName: z.string().describe("当前标签名"),
  newName: z.string().describe("新标签名"),
  tagName: z.string().describe("标签名"),
};
