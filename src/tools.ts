import { z } from "zod";
import { callApi, uaToUnix, nowStr, tzStr } from "./api.js";
import { evalInPage } from "./cdp.js";

// ---------- 数据结构 ----------

export interface FlomoMemo {
  slug: string;
  content: string;
  created_at: string;
  updated_at?: string;
  /** 回收站标记：/memo/updated/ 与 latest_updated_desc 均会返回已删除行，必须过滤 */
  deleted_at?: string | null;
  deleted_at_long?: number | null;
  tags?: string[] | { name?: string }[];
  file_ids?: string[];
  pinned?: number;
  pin?: number;
  [k: string]: unknown;
}

/** 非回收站行（deleted_at / deleted_at_long 任一非空即已删除） */
const alive = (m: FlomoMemo) => !m.deleted_at && !m.deleted_at_long;

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

/** tags 字段两种形态（字符串数组 / 对象数组）统一提取为字符串数组 */
function tagNames(tags: FlomoMemo["tags"]): string[] {
  return Array.isArray(tags)
    ? tags.map((t) => (typeof t === "string" ? t : t?.name)).filter((n): n is string => !!n)
    : [];
}

/** HTML → 纯文本。&amp; 必须最后解，否则 &amp;lt; 会被二次解码成 < */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

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
  if (!info.login) throw new Error("flomo 未登录：请打开 flomo 应用登录后重试");
  return {
    account: info.name ?? info.email ?? "未知用户",
    memo_count: info.memo_count >= 0 ? info.memo_count : null,
    tag_count: info.tag_count >= 0 ? info.tag_count : null,
    pro: info.pro,
  };
}

function memoBrief(m: FlomoMemo, contentLen = 200) {
  return {
    slug: m.slug,
    created_at: m.created_at,
    updated_at: m.updated_at ?? null,
    tags: tagNames(m.tags),
    excerpt: htmlToText(m.content ?? "").slice(0, contentLen),
  };
}

// ---------- 游标 ----------
// MCP 无服务端状态：游标只编码定位信息，翻页请求幂等重算

interface ListCursor { ua: number; slug: string }

function encodeListCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeListCursor(s: string): ListCursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof c?.ua === "number" && typeof c?.slug === "string" ? c : null;
  } catch { return null; }
}

interface SearchCursor { kw: string; offset: number }

function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeSearchCursor(s: string): SearchCursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof c?.kw === "string" && typeof c?.offset === "number" ? c : null;
  } catch { return null; }
}

interface TagCursor { tag: string; offset: number }

function encodeTagCursor(c: TagCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeTagCursor(s: string): TagCursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof c?.tag === "string" && typeof c?.offset === "number" ? c : null;
  } catch { return null; }
}

/** 全量拉取笔记（升序 unix 游标翻页），最多 40 页保护。返回是否打满上限。
 *  游标推进基于原始行（整页皆回收站行时过滤后为空但仍有下一页）；已删除行不入结果 */
async function scanAllMemos(): Promise<{ memos: FlomoMemo[]; truncated: boolean }> {
  const all: FlomoMemo[] = [];
  let cur: ListCursor | null = null;
  for (let page = 0; page < 40; page++) {
    const params: Record<string, unknown> = { limit: 100, tz: tzStr() };
    if (cur?.ua) params.latest_updated_at = cur.ua;
    if (cur?.slug) params.latest_slug = cur.slug;
    const batch = await callApi<FlomoMemo[]>("GET", "/memo/updated/", params);
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows.filter(alive));
    if (rows.length < 100) return { memos: all, truncated: false };
    if (page === 39) return { memos: all, truncated: true };
    const last = rows[rows.length - 1];
    cur = { ua: uaToUnix(String(last.updated_at ?? "")), slug: String(last.slug ?? "") };
  }
  return { memos: all, truncated: false };
}

/**
 * 列出笔记。mode=recent：最近更新（服务端 cap 200 条，最新在前）；
 * mode=all：全量按更新时间升序翻页（游标，每页最多 100 条）；
 * 传 tag：忽略 mode，全量扫描后按标签前缀匹配过滤（含子标签），更新时间降序翻页。
 */
export async function listMemos(limit: number, mode: "recent" | "all", cursor?: string, tag?: string) {
  if (tag !== undefined) {
    const clean = tag.replace(/^#/, "").trim();
    if (!clean) throw new Error("tag 不能为空");
    let offset = 0;
    if (cursor !== undefined) {
      const c = decodeTagCursor(cursor);
      if (!c) throw new Error("翻页游标无效，请从第一页重新开始（不传 cursor 参数）");
      if (c.tag !== clean) throw new Error("翻页游标与 tag 不匹配，请从第一页重新开始");
      offset = c.offset;
    }
    const { memos: all, truncated } = await scanAllMemos();
    const hits = all
      .filter((m) => tagNames(m.tags).some((n) => n === clean || n.startsWith(clean + "/")))
      .sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)));

    const page = hits.slice(offset, offset + limit);
    const next = offset + limit < hits.length
      ? { next_cursor: encodeTagCursor({ tag: clean, offset: offset + limit }) }
      : {};
    return {
      tag: clean,
      complete: !truncated,
      scanned: all.length,
      matched: hits.length,
      count: page.length,
      ...next,
      memos: page.map((m) => memoBrief(m)),
    };
  }
  if (mode === "recent") {
    const memos = await callApi<FlomoMemo[]>("GET", "/memo/latest_updated_desc", { limit: 200, tz: tzStr() });
    const arr = (Array.isArray(memos) ? memos : []).filter(alive).slice(0, limit);
    return { mode, count: arr.length, memos: arr.map((m) => memoBrief(m)) };
  }
  const cur = cursor !== undefined ? decodeListCursor(cursor) : null;
  if (cursor !== undefined && !cur) {
    throw new Error("翻页游标无效，请从第一页重新开始（不传 cursor 参数）");
  }
  const pageSize = Math.min(limit, 100);
  const params: Record<string, unknown> = { limit: pageSize, tz: tzStr() };
  if (cur?.ua) params.latest_updated_at = cur.ua;
  if (cur?.slug) params.latest_slug = cur.slug;
  const memos = await callApi<FlomoMemo[]>("GET", "/memo/updated/", params);
  const rows = Array.isArray(memos) ? memos : [];
  const arr = rows.filter(alive);
  const last = rows[rows.length - 1];
  const next = last && rows.length >= pageSize
    ? { next_cursor: encodeListCursor({ ua: uaToUnix(String(last.updated_at ?? "")), slug: String(last.slug ?? "") }) }
    : {};
  return { mode, count: arr.length, ...next, memos: arr.map((m) => memoBrief(m)) };
}

/**
 * 关键词搜索（正文与标签）。flomo 无远程搜索接口，每次调用全量拉取后本地过滤；
 * 翻页游标编码 {kw, offset}，翻页时重新扫描按偏移切片。
 */
export async function searchMemos(keyword: string, limit: number, cursor?: string) {
  let offset = 0;
  if (cursor !== undefined) {
    const c = decodeSearchCursor(cursor);
    if (!c) throw new Error("翻页游标无效，请从第一页重新搜索（不传 cursor 参数）");
    if (c.kw !== keyword) throw new Error("翻页游标与 keyword 不匹配，请从第一页重新搜索");
    offset = c.offset;
  }
  const { memos: all, truncated } = await scanAllMemos();
  const kw = keyword.toLowerCase();
  const hits = all.filter((m) => {
    const text = htmlToText(m.content ?? "").toLowerCase();
    const tags = tagNames(m.tags).join(" ").toLowerCase();
    return text.includes(kw) || tags.includes(kw);
  }).sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)));

  const page = hits.slice(offset, offset + limit);
  const next = offset + limit < hits.length
    ? { next_cursor: encodeSearchCursor({ kw: keyword, offset: offset + limit }) }
    : {};
  return {
    complete: !truncated,
    scanned: all.length,
    matched: hits.length,
    count: page.length,
    ...next,
    memos: page.map((m) => memoBrief(m)),
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
    updated_at: d.updated_at ?? null,
    tags: tagNames(d.tags),
    content_html: d.content,
    content_text: htmlToText(d.content ?? ""),
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
  if (!slug) throw new Error("flomo 创建响应异常：未返回 slug，请用 list_memos 确认笔记是否实际已创建");
  return { slug };
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
  return { slug };
}

export async function deleteMemo(slug: string) {
  await callApi("DELETE", `/memo/${encodeURIComponent(slug)}`);
  return { slug, note: "已移入回收站" };
}

interface SyncResult {
  ok: boolean;
  message?: string;
  result?: {
    success: boolean;
    code: string;
    message?: string;
    data?: {
      duration?: number;
      pullSuccess?: boolean;
      pushSuccess?: boolean;
      updatedMemoCount?: number;
      tagUpdated?: number;
    };
  };
}

/**
 * 手动同步（等同点击 flomo 界面左下角同步按钮）。
 * 通过 webpackChunkflomo 注入捕获 require，取 LocalDB 类（当前主包模块 77142，
 * 导出名 Ay）调 syncWithPromise()：pull 拉服务端最新数据入本地 IndexedDB，push 推本地待同步修改。
 * 失败时 syncWithPromise 以结果对象 reject，页面侧 catch 后原样带回。
 */
export async function sync() {
  const r = await evalInPage<SyncResult>(`(async function(){
    let req=null;
    // server 自动拉起的 flomo 主窗口可能仍在加载（webpackChunkflomo 未就绪），短暂轮询等待
    for(let i=0;i<40&&!req;i++){
      try{window.webpackChunkflomo.push([[Math.floor(Math.random()*1e9)+1e6],{},function(r){req=r;}]);}catch(e){}
      if(!req)await new Promise(w=>setTimeout(w,500));
    }
    if(!req)return{ok:false,message:"flomo 页面尚未就绪或 require 捕获失败"};
    let cls=null;
    try{const m=req(77142);cls=m&&m.Ay;}catch(e){}
    if(!cls||typeof cls.syncWithPromise!=="function"){
      // 模块 id 随 flomo 更新会漂移，按签名扫描已加载模块兜底
      for(const k in req.c){try{const m=req.c[k]&&req.c[k].exports;
        if(m&&m.Ay&&typeof m.Ay.syncWithPromise==="function"){cls=m.Ay;break;}}catch(e){}}
    }
    if(!cls)return{ok:false,message:"未找到同步模块（flomo 前端已更新）"};
    return{ok:true,result:await cls.syncWithPromise().catch(e=>e)};
  })()`, 120000);
  if (!r?.ok || !r.result || typeof r.result.success !== "boolean") {
    throw new Error(`${r?.message ?? "同步调用异常"}：请重启 flomo 后重试；若持续失败请到 GitHub 提 issue`);
  }
  const res = r.result;
  if (!res.success && res.code !== "SYNCING") {
    throw new Error(`同步失败（${res.code}）：${res.message ?? "未知原因"}。请检查网络后重试`);
  }
  const d = res.data ?? {};
  return {
    synced: res.success,
    code: res.code as "SUCCESS" | "SYNCING",
    message: res.message ?? "",
    duration_ms: typeof d.duration === "number" ? d.duration : null,
    pull_success: d.pullSuccess ?? null,
    push_success: d.pushSuccess ?? null,
    updated_memo_count: d.updatedMemoCount ?? null,
    tag_updated: d.tagUpdated ?? null,
  };
}

type TagBrief = { id: number; name: string; pinned: boolean; count?: number };

/** 全量标签获取：优先 Vuex 内存直读（flomo 已同步全量，含 id），fallback /tag/updated/ */
async function fetchAllTags(): Promise<TagBrief[]> {
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
    return fromStore.tags;
  }
  // fallback：API（服务器每页较小，(updated_at, id) 双游标循环；无 count）
  const all: FlomoTag[] = [];
  let curUa = 0;
  let curId: number | null = null;
  for (let page = 0; page < 60; page++) {
    const params: Record<string, unknown> = { limit: 500, latest_updated_at: curUa, tz: tzStr() };
    if (curId !== null) params.latest_id = curId;
    const batch = await callApi<FlomoTag[]>("GET", "/tag/updated/", params);
    // 游标推进与终止必须基于原始行：deleted 过滤后整页可能为空或不满页，据此断页会漏数据；
    // 同页内 updated_at 相同属正常，靠 latest_id 游标继续翻，不能按时间戳不前进就停
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows.filter((t) => !t.deleted_at));
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    curUa = uaToUnix(String(last.updated_at ?? ""));
    curId = last.id;
    if (rows.length < 8) break;
  }
  return all.map((t) => ({ id: t.id, name: t.name, pinned: !!t.pin, count: undefined }));
}

/** 标签树浏览：不传 tagName 返回一级标签；传 tagName 返回其直接子级（recursive=true 时全部后代）。
 *  flomo 标签扁平存储，层级只是名字里的 "/" 约定，树结构在本地按前缀推导。 */
export async function listTags(tagName?: string, recursive = false) {
  const tags = await fetchAllTags();
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
  // 某节点下的实体后代总数（含多层）
  const descCount = (name: string) => tags.filter((t) => t.name.startsWith(name + "/")).length;

  if (!tagName) {
    // 一级视图：按第一段聚合。仅作前缀出现的虚拟一级（如只建过 #阅读/读书）没有实体 id，记 null
    const groups = new Map<string, { id: number | null; pinned: boolean; count: number | undefined }>();
    for (const t of tags) {
      const top = t.name.split("/")[0];
      let g = groups.get(top);
      if (!g) {
        g = { id: null, pinned: false, count: undefined };
        groups.set(top, g);
      }
      if (t.name === top) {
        g.id = t.id;
        g.pinned = t.pinned;
      }
      if (typeof t.count === "number") g.count = (g.count ?? 0) + t.count;
    }
    const list = [...groups.entries()].map(([name, g]) => ({
      name,
      id: g.id,
      pinned: g.pinned,
      count: g.count ?? null,
      direct_children: directOf.get(name) ?? 0,
      total_descendants: descCount(name),
    })).sort((a, b) => (a.pinned === b.pinned ? byName(a, b) : a.pinned ? -1 : 1));
    return { count: list.length, tags: list };
  }

  const parent = tagName.trim().replace(/^\/+|\/+$/g, "");
  if (!parent) throw new Error("tag_name 不能为空");
  const prefix = parent + "/";
  const descendants = tags.filter((t) => t.name.startsWith(prefix));
  // 既不是任何标签名、也不是任何标签前缀 → 输入有误；叶子标签查子级返回空列表属正常
  if (!tags.some((t) => t.name === parent) && descendants.length === 0) {
    throw new Error(`标签不存在：${parent}。请先调用 list_tags（不带参数）确认标签名`);
  }
  type Row = { id: number | null; name: string; pinned: boolean; count: number | null; direct_children: number; total_descendants: number };
  let list: Row[];
  if (recursive) {
    // 全部后代只返回实体标签
    list = descendants.map((t) => ({
      id: t.id,
      name: t.name,
      pinned: t.pinned,
      count: t.count ?? null,
      direct_children: directOf.get(t.name) ?? 0,
      total_descendants: descCount(t.name),
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
      count: c.count ?? null,
      direct_children: directOf.get(name) ?? 0,
      total_descendants: descCount(name),
    }));
  }
  return { count: list.length, tags: list.sort(byName) };
}

/** 标签重命名：走 /tag/rename 按名字操作（服务器裁决存在性；Vuex 快照可能滞后于新标签） */
export async function renameTag(oldName: string, newName: string) {
  const from = oldName.trim();
  const to = newName.trim();
  await callApi("POST", "/tag/rename", { old_tag: from, new_tag: to });
  return { from, to };
}

export async function pinTag(tagName: string, pin: boolean) {
  const tag = tagName.trim();
  await callApi("POST", pin ? "/tag/pin" : "/tag/unpin", { tag, tz: tzStr() });
  return { tag, pinned: pin };
}

// ---------- zod schemas（MCP 注册用） ----------

const memoBriefShape = {
  slug: z.string().describe("笔记唯一标识，用于 get/update/delete"),
  created_at: z.string().describe("创建时间 YYYY-MM-DD HH:mm:ss（本地时区）"),
  updated_at: z.string().nullable().describe("更新时间；null 表示 flomo 未返回"),
  tags: z.array(z.string()).describe("标签名列表（含完整层级路径）"),
  excerpt: z.string().describe("正文纯文本摘要（前 200 字符）"),
};

const tagRowShape = {
  id: z.number().int().nullable().describe("标签 id，flomo 本地生成、重建后可能变化，勿作稳定主键（操作用 name）；null 表示虚拟中间层节点"),
  name: z.string().describe("标签名（含完整层级路径，如 阅读/读书）"),
  pinned: z.boolean(),
  count: z.number().int().nullable().describe("笔记计数；null 表示不可用"),
  direct_children: z.number().int().describe("直接子级数，0 即叶子"),
  total_descendants: z.number().int().describe("其下所有层级的实体标签总数"),
};

export const schemas = {
  limit: z.number().int().min(1).max(200).default(20).describe("返回条数（mode=all 时每页最多 100 条，超出按 100 执行）"),
  mode: z.enum(["recent", "all"]).default("recent").describe("recent=最近更新(最新在前，最多200条)；all=全量按时间升序翻页(每页≤100)。传 tag 时忽略"),
  cursor: z.string().optional().describe("翻页游标（上次返回的 next_cursor；mode=all 或传 tag 时使用，后者翻页须保持 tag 不变）"),
  tagFilter: z.string().min(1).optional().describe("按标签过滤（前缀匹配含子标签，如 阅读 也含 阅读/读书）。传此参数时忽略 mode，全量扫描后本地过滤，按更新时间降序游标翻页"),
  searchCursor: z.string().optional().describe("翻页游标（上次返回的 next_cursor，必须配合首次搜索的同一 keyword）"),
  keyword: z.string().min(1).describe("搜索关键词（匹配正文与标签，大小写不敏感）"),
  slug: z.string().describe("笔记 slug"),
  content: z.string().min(1).describe("笔记内容，支持 HTML 与 #标签名 语法"),
  oldName: z.string().describe("当前标签名"),
  newName: z.string().describe("新标签名"),
  tagName: z.string().describe("标签名"),
  tagNameQuery: z.string().min(1).optional().describe("父标签名，支持任意层级路径（如 阅读 或 阅读/读书）。不传则返回一级标签"),
  recursive: z.boolean().default(false).describe("传入 tag_name 时：true=返回其下所有层级后代；false=仅直接子级"),
};

// 输出 schema：SDK 注册后对非错误结果强制校验 structuredContent
export const outputs = {
  whoami: {
    account: z.string().describe("账号显示名（无名称时为脱敏邮箱）"),
    memo_count: z.number().int().nullable(),
    tag_count: z.number().int().nullable(),
    pro: z.boolean(),
  },
  listMemos: {
    mode: z.enum(["recent", "all"]).optional().describe("本次使用的模式；传 tag 过滤时不返回"),
    tag: z.string().optional().describe("本次过滤的标签（已去除 # 前缀）；存在即本次为 tag 过滤结果"),
    complete: z.boolean().optional().describe("tag 过滤：false=触达 40 页扫描上限，结果可能不全"),
    scanned: z.number().int().optional().describe("tag 过滤：本次实际扫描笔记数"),
    matched: z.number().int().optional().describe("tag 过滤：匹配总数"),
    count: z.number().int().describe("本次返回条数（非全量总数）"),
    next_cursor: z.string().optional().describe("存在即还有下一页，原样传入下次调用"),
    memos: z.array(z.object(memoBriefShape)),
  },
  searchMemos: {
    complete: z.boolean().describe("false=触达 40 页扫描上限，结果可能不全"),
    scanned: z.number().int().describe("本次实际扫描笔记数"),
    matched: z.number().int().describe("匹配总数"),
    count: z.number().int().describe("本次返回条数"),
    next_cursor: z.string().optional().describe("存在即匹配结果未取完，原样传入下次调用（keyword 不变）"),
    memos: z.array(z.object(memoBriefShape)),
  },
  getMemo: {
    slug: z.string(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    tags: z.array(z.string()),
    content_html: z.string().describe("原始 HTML，update_memo 需基于此修改回写"),
    content_text: z.string().describe("纯文本（已解码 HTML 实体）"),
  },
  createMemo: { slug: z.string() },
  updateMemo: { slug: z.string() },
  deleteMemo: { slug: z.string(), note: z.string().describe("已移入回收站，可在 flomo 回收站恢复") },
  sync: {
    synced: z.boolean().describe("true=本次调用完成一次同步；false=已有同步在进行中（code=SYNCING）"),
    code: z.enum(["SUCCESS", "SYNCING"]),
    message: z.string().describe("flomo 返回的同步结果消息"),
    duration_ms: z.number().int().nullable().describe("同步耗时（毫秒）；SYNCING 时为 null"),
    pull_success: z.boolean().nullable().describe("拉取服务端数据是否成功；SYNCING 时为 null"),
    push_success: z.boolean().nullable().describe("推送本地待同步修改是否成功；SYNCING 时为 null"),
    updated_memo_count: z.number().int().nullable().describe("本次同步更新的笔记数"),
    tag_updated: z.number().int().nullable().describe("本次同步更新的标签数"),
  },
  listTags: {
    count: z.number().int().describe("本次返回的标签节点数"),
    tags: z.array(z.object(tagRowShape)),
  },
  renameTag: { from: z.string(), to: z.string() },
  pinTag: { tag: z.string(), pinned: z.boolean() },
};
