// flomo-mcp 端到端测试：stdio 启动 server，依次调用工具，写操作用临时标签闭环清理
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "flomo-mcp-test", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`[${name}] ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};
const show = (label, v) => console.log(`✔ ${label}:`, JSON.stringify(v).slice(0, 380));

// ---- 只读 ----
show("whoami", await call("whoami"));

const top = await call("list_tags");
if (top.scope !== "top") throw new Error(`list_tags 无参应返回 scope=top，实际 ${top.scope}`);
show(`list_tags 一级 (${top.total})`, top.tags.slice(0, 6));

const branch = top.tags.find((t) => t.total_descendants > 0);
if (branch) {
  const children = await call("list_tags", { tag_name: branch.name });
  if (children.scope !== "children" || children.parent !== branch.name) throw new Error("list_tags 子级返回结构不符");
  if (children.total !== branch.direct_children) throw new Error(`非递归子数 ${children.total} ≠ 一级视图 direct_children ${branch.direct_children}`);
  show(`list_tags 子级 ${branch.name} (${children.total})`, children.tags.slice(0, 6));
  const all = await call("list_tags", { tag_name: branch.name, recursive: true });
  if (all.total !== branch.total_descendants) throw new Error(`recursive 后代数 ${all.total} ≠ 一级视图 total_descendants ${branch.total_descendants}`);
  show(`list_tags 全后代 ${branch.name} (${all.total})`, all.tags.slice(0, 6));
} else {
  console.log("· list_tags 层级浏览：账号无层级标签，跳过子级用例");
}

try {
  await call("list_tags", { tag_name: "__no_such_tag__" });
  throw new Error("不存在的标签应报错");
} catch (e) {
  if (!String(e.message).includes("标签不存在")) throw e;
  console.log("✔ list_tags 不存在标签正确报错");
}

const recent = await call("list_memos", { limit: 3 });
show(`list_memos recent (${recent.total})`, recent.memos);

const p1 = await call("list_memos", { limit: 3, mode: "all" });
show(`list_memos all p1 (${p1.total})`, p1.memos.map((m) => m.slug));
const p2 = await call("list_memos", { limit: 3, mode: "all", cursor: p1.next_cursor });
show(`list_memos all p2 (${p2.total})`, p2.memos.map((m) => m.slug));
const dup = p2.memos.some((m) => p1.memos.some((x) => x.slug === m.slug));
console.log(dup ? "✘ 翻页出现重复" : "✔ 翻页无重复");

const search = await call("search_memos", { keyword: "测试", limit: 5 });
show(`search_memos (${search.matched}/${search.scanned})`, search.memos.slice(0, 3).map((m) => ({ slug: m.slug, ex: m.excerpt.slice(0, 40) })));

// ---- 写闭环 ----
const created = await call("create_memo", { content: "#__mcp_test flomo-mcp 创建测试 v2 <b>hello</b>" });
show("create_memo", created);
if (!created.slug) throw new Error("创建未返回 slug");

const detail = await call("get_memo", { slug: created.slug });
show("get_memo", { slug: detail.slug, text: (detail.content_text || "").slice(0, 50), tags: detail.tags });

const updated = await call("update_memo", { slug: created.slug, content: "#__mcp_test flomo-mcp 更新后的内容 v3" });
show("update_memo", updated);
const detail2 = await call("get_memo", { slug: created.slug });
console.log(detail2.content_text?.includes("v3") ? "✔ 更新生效" : `✘ 更新未生效: ${detail2.content_text}`);

const renamed = await call("rename_tag", { old_name: "__mcp_test", new_name: "__mcp_renamed" });
show("rename_tag", renamed);

const pinned = await call("pin_tag", { tag: "__mcp_renamed" });
show("pin_tag", pinned);
const unpinned = await call("unpin_tag", { tag: "__mcp_renamed" });
show("unpin_tag", unpinned);

const deleted = await call("delete_memo", { slug: created.slug });
show("delete_memo", deleted);

console.log("\n=== 全部通过 ===");
await client.close();
process.exit(0);
