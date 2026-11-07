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
const tags = await call("list_tags");
show(`list_tags (${tags.total})`, tags.tags.slice(0, 6));
if (tags.total < 100) console.log(`⚠ 标签仅 ${tags.total} 个（Vuex 显示 111），翻页可能不全`);

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

// ---- 清理历史遗留的测试笔记 ----
for (const old of ["MjY0NTg2Mjgz", "MjY0NTg3Mjgz", "MjY0NTg3Mjkz", "MjY0NTg3NDU3", "MjY0NTg3NTIx"]) {
  try { await call("delete_memo", { slug: old }); console.log(`✔ 已清理遗留笔记 ${old}`); }
  catch { /* 不存在则跳过 */ }
}

console.log("\n=== 全部通过 ===");
await client.close();
process.exit(0);
