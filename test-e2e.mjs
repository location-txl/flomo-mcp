// flomo-mcp 端到端测试：stdio 启动 server，依次调用工具，写操作用临时标签闭环清理
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "flomo-mcp-test", version: "0.2.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`[${name}] ${text}`);
  if (r.structuredContent) return r.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
};
// 期待工具执行错误（isError），断言 message 包含关键词后放行
const expectError = async (name, args, msgPart) => {
  const r = await client.callTool({ name, arguments: args });
  if (!r.isError) throw new Error(`[${name}] 应报错但成功了`);
  const text = r.content?.[0]?.text ?? "";
  if (!text.includes(msgPart)) throw new Error(`[${name}] 错误信息应含「${msgPart}」，实际: ${text}`);
  console.log(`✔ ${name} 正确报错: ${text.slice(0, 80)}`);
};
const show = (label, v) => console.log(`✔ ${label}:`, JSON.stringify(v).slice(0, 380));

// ---- 协议层：全部工具声明 outputSchema（SDK 已对非错误结果强制校验 structuredContent）----
const { tools } = await client.listTools();
const missingSchema = tools.filter((tl) => !tl.outputSchema).map((tl) => tl.name);
if (missingSchema.length) throw new Error(`以下工具缺少 outputSchema: ${missingSchema.join(", ")}`);
console.log(`✔ tools/list: ${tools.length} 个工具均声明 outputSchema`);

// ---- 只读 ----
const me = await call("whoami");
if (!me.account || !("memo_count" in me) || !("tag_count" in me) || typeof me.pro !== "boolean") {
  throw new Error(`whoami 结构不符: ${JSON.stringify(me)}`);
}
show("whoami", me);

// ---- 手动同步（幂等，等同点击同步按钮；顺手刷新 Vuex 供后续标签用例读到新数据）----
const synced = await call("sync");
if (typeof synced.synced !== "boolean" || !["SUCCESS", "SYNCING"].includes(synced.code)) {
  throw new Error(`sync 结构不符: ${JSON.stringify(synced)}`);
}
if (synced.code === "SUCCESS" && (synced.pull_success !== true || synced.push_success !== true)) {
  throw new Error(`sync 成功时 pull/push 应为 true: ${JSON.stringify(synced)}`);
}
show("sync", synced);

const top = await call("list_tags");
if (!Array.isArray(top.tags) || typeof top.count !== "number") throw new Error("list_tags 一级返回结构不符");
show(`list_tags 一级 (${top.count})`, top.tags.slice(0, 6));

const branch = top.tags.find((tl) => tl.total_descendants > 0);
if (branch) {
  const children = await call("list_tags", { tag_name: branch.name });
  if (children.count !== branch.direct_children) throw new Error(`非递归子数 ${children.count} ≠ 一级视图 direct_children ${branch.direct_children}`);
  show(`list_tags 子级 ${branch.name} (${children.count})`, children.tags.slice(0, 6));
  const all = await call("list_tags", { tag_name: branch.name, recursive: true });
  if (all.count !== branch.total_descendants) throw new Error(`recursive 后代数 ${all.count} ≠ 一级视图 total_descendants ${branch.total_descendants}`);
  show(`list_tags 全后代 ${branch.name} (${all.count})`, all.tags.slice(0, 6));
  // 子级视图每行 total_descendants 应等于 recursive 后代数
  const child = children.tags[0];
  if (child) {
    const allOf = child.total_descendants > 0 ? await call("list_tags", { tag_name: child.name, recursive: true }) : null;
    if (allOf && allOf.count !== child.total_descendants) throw new Error(`子级 total_descendants ${child.total_descendants} 与 recursive 实测 ${allOf.count} 不符`);
  }
} else {
  console.log("· list_tags 层级浏览：账号无层级标签，跳过子级用例");
}

await expectError("list_tags", { tag_name: "__no_such_tag__" }, "标签不存在");

const recent = await call("list_memos", { limit: 3 });
if (recent.mode !== "recent" || recent.count > 3) throw new Error("list_memos recent 结构不符");
show(`list_memos recent (${recent.count})`, recent.memos);

const p1 = await call("list_memos", { limit: 3, mode: "all" });
if (!p1.memos.every((m) => "updated_at" in m && Array.isArray(m.tags))) throw new Error("memos 行应恒含 updated_at 与 tags 字段");
show(`list_memos all p1 (${p1.count})`, p1.memos.map((m) => m.slug));
const p2 = await call("list_memos", { limit: 3, mode: "all", cursor: p1.next_cursor });
show(`list_memos all p2 (${p2.count})`, p2.memos.map((m) => m.slug));
const dup = p2.memos.some((m) => p1.memos.some((x) => x.slug === m.slug));
console.log(dup ? "✘ 翻页出现重复" : "✔ 翻页无重复");

await expectError("list_memos", { mode: "all", cursor: "%%invalid%%" }, "游标无效");

// ---- 写准备：两条含唯一关键词的笔记，供 search 翻页用例 ----
const HIT = "__mcp_search_hit__";
const seed1 = await call("create_memo", { content: `#__mcp_test ${HIT} 搜索种子 A` });
const seed2 = await call("create_memo", { content: `#__mcp_test ${HIT} 搜索种子 B` });
show("create_memo 搜索种子", [seed1.slug, seed2.slug]);

const s1 = await call("search_memos", { keyword: HIT, limit: 1 });
if (s1.complete !== true) throw new Error("正常账号扫描应 complete=true");
if (s1.matched < 2) throw new Error(`搜索种子应至少命中 2 条，实际 ${s1.matched}`);
if (s1.count !== 1 || !s1.next_cursor) throw new Error("limit=1 应返回 1 条且带 next_cursor");
show(`search_memos p1 (${s1.matched}/${s1.scanned})`, s1.memos);

const s2 = await call("search_memos", { keyword: HIT, limit: 1, cursor: s1.next_cursor });
if (s2.memos.some((m) => m.slug === s1.memos[0].slug)) throw new Error("搜索翻页出现重复");
show(`search_memos p2`, s2.memos);

await expectError("search_memos", { keyword: "另一个词", limit: 1, cursor: s1.next_cursor }, "不匹配");

// ---- list_memos tag 过滤：父子两条种子验证前缀匹配与翻页 ----
const TAGP = "__mcp_taglist_test";
const seedTag1 = await call("create_memo", { content: `#${TAGP} tag 过滤父种子` });
const seedTag2 = await call("create_memo", { content: `#${TAGP}/sub tag 过滤子种子` });
show("create_memo tag 过滤种子", [seedTag1.slug, seedTag2.slug]);

const byParent = await call("list_memos", { tag: TAGP });
if (byParent.tag !== TAGP || byParent.complete !== true || "mode" in byParent) throw new Error(`tag 过滤返回结构不符: ${JSON.stringify({ ...byParent, memos: [] })}`);
if (byParent.matched < 2) throw new Error(`父标签应至少命中 2 条（含子标签），实际 ${byParent.matched}`);
const slugs = byParent.memos.map((m) => m.slug);
if (!slugs.includes(seedTag1.slug) || !slugs.includes(seedTag2.slug)) throw new Error("父标签结果应同时包含父/子两条种子");
show(`list_memos tag=${TAGP} (${byParent.matched}/${byParent.scanned})`, byParent.memos.map((m) => `${m.slug}:${m.tags.join(",")}`));

const byChild = await call("list_memos", { tag: `${TAGP}/sub` });
const childSlugs = byChild.memos.map((m) => m.slug);
if (!childSlugs.includes(seedTag2.slug) || childSlugs.includes(seedTag1.slug)) throw new Error("子标签应只命中子种子");
show(`list_memos tag=${TAGP}/sub (${byChild.matched})`, byChild.memos.map((m) => m.slug));

const t1 = await call("list_memos", { tag: TAGP, limit: 1 });
if (t1.count !== 1 || !t1.next_cursor) throw new Error("tag 过滤 limit=1 应返回 1 条且带 next_cursor");
const t2 = await call("list_memos", { tag: TAGP, limit: 1, cursor: t1.next_cursor });
if (t2.memos.some((m) => m.slug === t1.memos[0].slug)) throw new Error("tag 过滤翻页出现重复");
show("list_memos tag 翻页", t2.memos.map((m) => m.slug));

await expectError("list_memos", { tag: "__no_such_tag__", cursor: t1.next_cursor }, "不匹配");
const none = await call("list_memos", { tag: "__no_such_tag__" });
if (none.matched !== 0 || none.count !== 0 || none.next_cursor) throw new Error(`不存在的标签应返回空集，实际 ${JSON.stringify({ ...none, memos: [] })}`);
console.log("✔ list_memos 不存在的标签返回空集");

// ---- 写闭环 ----
const created = await call("create_memo", { content: "#__mcp_test flomo-mcp 创建测试 v2 <b>hello</b> &amp; more" });
show("create_memo", created);
if (!created.slug) throw new Error("创建未返回 slug");

const detail = await call("get_memo", { slug: created.slug });
if (!detail.tags.every((tg) => typeof tg === "string")) throw new Error("get_memo tags 应为字符串数组");
if (!detail.content_text.includes("& more")) throw new Error(`HTML 实体未解码: ${detail.content_text}`);
show("get_memo", { slug: detail.slug, text: (detail.content_text || "").slice(0, 50), tags: detail.tags });

const updated = await call("update_memo", { slug: created.slug, content: "#__mcp_test flomo-mcp 更新后的内容 v3" });
if (Object.keys(updated).join() !== "slug") throw new Error(`update_memo 应只返回 slug，实际 ${JSON.stringify(updated)}`);
const detail2 = await call("get_memo", { slug: created.slug });
console.log(detail2.content_text?.includes("v3") ? "✔ 更新生效" : `✘ 更新未生效: ${detail2.content_text}`);

const renamed = await call("rename_tag", { old_name: "__mcp_test", new_name: "__mcp_renamed" });
show("rename_tag", renamed);

const pinned = await call("pin_tag", { tag: "__mcp_renamed" });
show("pin_tag", pinned);
const unpinned = await call("unpin_tag", { tag: "__mcp_renamed" });
show("unpin_tag", unpinned);

for (const s of [created, seed1, seed2, seedTag1, seedTag2]) {
  const deleted = await call("delete_memo", { slug: s.slug });
  show("delete_memo", deleted);
}

console.log("\n=== 全部通过 ===");
await client.close();
process.exit(0);
