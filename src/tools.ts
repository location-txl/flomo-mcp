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

type TagBrief = { id: number; name: string; pinned: boolean; count?: number };

/** 全量标签获取：优先 Vuex 内存直读（flomo 已同步全量，含 id），fallback /tag/updated/ */
async function fetchAllTags(): Promise<{ source: "memory" | "api"; tags: TagBrief[] }> {
  const fromStore = await evalInPage<{ ok: boolean; total: number; tags?: TagBrief[] }>(`(function(){
    try{
      const s=window.__flomoVuexStore.state;
      const tags=s.tags;
      if(!Array.isArray(tags)||!tags.length)return{ok:false};
      const pinned=new Set((s.pinned_tags||[]).map(t=>t&&(t.name||t)));
      return{ok:true,total:tags.length,tags:tags.map(t=>({id:t.id,name:t.name,pinned:pinned.has(t.name),count:t.count}))};
    }catch(e){return{ok:false}}
  })()`);
  if (fromStore?.ok && fromStore.tags?.length) {
    return { source: "memory", tags: fromStore.tags };
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
    tags: all.map((t) => ({ id: t.id, name: t.name, pinned: !!t.pin, count: undefined })),
  };
}

/** 标签树浏览：不传 tagName 返回一级标签；传 tagName 返回其直接子级（recursive=true 时全部后代）。
 *  flomo 标签扁平存储，层级只是名字里的 "/" 约定，树结构在本地按前缀推导。 */
export async function listTags(tagName?: string, recursive = false) {
  const { source, tags } = await fetchAllTags();
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  // 全部节点名 = 实体标签 + 仅作为前缀存在的虚拟中间层（如只建过 #阅读/读书/小说 而无 #阅读/读书）。
  // 必须按节点去重后统计"每个节点的直接父级"，否则虚拟中间层的子级会漏计
  const nodes = new Set<string>();
  for (const t of tags) {
    const parts = t.name.split("/");
    for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join("/"));
  }
  const directOf = new Map<string, number>();
  for (const n of nodes) {
    const i = n.lastIndexOf("/");
    if (i > 0) {
      const p = n.slice(0, i);
      directOf.set(p, (directOf.get(p) ?? 0) + 1);
    }
  }

  if (!tagName) {
    // 一级视图：按第一段聚合。仅作前缀出现的虚拟一级（如只建过 #阅读/读书）没有实体 id，记 null
    const groups = new Map<string, { id: number | null; pinned: boolean; count: number | undefined; descendants: number }>();
    for (const t of tags) {
      const top = t.name.split("/")[0];
      let g = groups.get(top);
      if (!g) {
        g = { id: null, pinned: false, count: undefined, descendants: 0 };
        groups.set(top, g);
      }
      if (t.name === top) {
        g.id = t.id;
        g.pinned = t.pinned;
      } else {
        g.descendants++;
      }
      if (typeof t.count === "number") g.count = (g.count ?? 0) + t.count;
    }
    const list = [...groups.entries()].map(([name, g]) => ({
      name,
      id: g.id,
      pinned: g.pinned,
      count: g.count,
      direct_children: directOf.get(name) ?? 0,
      total_descendants: g.descendants,
    })).sort((a, b) => (a.pinned === b.pinned ? byName(a, b) : a.pinned ? -1 : 1));
    return { source, scope: "top" as const, total: list.length, tags: list };
  }

  const parent = tagName.trim().replace(/^\/+|\/+$/g, "");
  if (!parent) throw new Error("tag_name 不能为空");
  const prefix = parent + "/";
  const descendants = tags.filter((t) => t.name.startsWith(prefix));
  // 既不是任何标签名、也不是任何标签前缀 → 输入有误；叶子标签查子级返回空列表属正常
  if (!tags.some((t) => t.name === parent) && descendants.length === 0) {
    throw new Error(`标签不存在：${parent}`);
  }
  type Row = { id: number | null; name: string; pinned: boolean; count: number | undefined; direct_children: number };
  let list: Row[];
  if (recursive) {
    // 全部后代只返回实体标签
    list = descendants.map((t) => ({
      id: t.id,
      name: t.name,
      pinned: t.pinned,
      count: t.count,
      direct_children: directOf.get(t.name) ?? 0,
    }));
  } else {
    // 直接子级：实体子级原样返回；中间层无实体的合成虚拟节点（id=null，count 为其下实体合计），
    // 保证只建过 #阅读/读书/小说 这类账号也能沿树继续下钻
    const childMap = new Map<string, { id: number | null; pinned: boolean; count: number | undefined }>();
    for (const t of descendants) {
      const rest = t.name.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        childMap.set(t.name, { id: t.id, pinned: t.pinned, count: t.count });
        continue;
      }
      const child = parent + "/" + rest.slice(0, slash);
      let c = childMap.get(child);
      if (!c) {
        c = { id: null, pinned: false, count: undefined };
        childMap.set(child, c);
      }
      if (c.id === null && typeof t.count === "number") c.count = (c.count ?? 0) + t.count;
    }
    list = [...childMap.entries()].map(([name, c]) => ({
      id: c.id,
      name,
      pinned: c.pinned,
      count: c.count,
      direct_children: directOf.get(name) ?? 0,
    }));
  }
  return { source, scope: "children" as const, parent, recursive, total: list.length, tags: list.sort(byName) };
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
  tagNameQuery: z.string().min(1).optional().describe("父标签名，支持任意层级路径（如 阅读 或 阅读/读书）。不传则返回一级标签"),
  recursive: z.boolean().default(false).describe("传入 tag_name 时：true=返回其下所有层级后代；false=仅直接子级"),
};
