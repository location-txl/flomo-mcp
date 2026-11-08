#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import * as t from "./tools.js";

// 版本号只维护 package.json 一处，server 元数据与之同步
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "flomo-mcp", version });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: `❌ ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

server.registerTool("whoami", {
  description: "验证 flomo 连接：显示当前登录账号、笔记与标签总数",
}, async () => ok(await t.whoami()));

server.registerTool("list_memos", {
  description: "列出笔记。mode=recent 最近更新（最新在前，最多200条）；mode=all 全量按时间升序游标翻页",
  inputSchema: { limit: t.schemas.limit, mode: t.schemas.mode, cursor: t.schemas.cursor },
}, async ({ limit, mode, cursor }) => ok(await t.listMemos(limit, mode, cursor)));

server.registerTool("search_memos", {
  description: "全量拉取笔记后按关键词搜索（匹配正文与标签，桌面端无远程搜索接口）",
  inputSchema: { keyword: t.schemas.keyword, limit: t.schemas.limit },
}, async ({ keyword, limit }) => ok(await t.searchMemos(keyword, limit)));

server.registerTool("get_memo", {
  description: "获取单条笔记全文（HTML 与纯文本）",
  inputSchema: { slug: t.schemas.slug },
}, async ({ slug }) => ok(await t.getMemo(slug)));

server.registerTool("create_memo", {
  description: "创建笔记。标签用 #标签名 语法写在 content 中（flomo 无独立建标签接口）",
  inputSchema: { content: t.schemas.content },
}, async ({ content }) => ok(await t.createMemo(content)));

server.registerTool("update_memo", {
  description: "更新笔记内容（自动保留原创建时间/置顶状态/附件）",
  inputSchema: { slug: t.schemas.slug, content: t.schemas.content },
}, async ({ slug, content }) => ok(await t.updateMemo(slug, content)));

server.registerTool("delete_memo", {
  description: "删除笔记（移入回收站）",
  inputSchema: { slug: t.schemas.slug },
}, async ({ slug }) => ok(await t.deleteMemo(slug)));

server.registerTool("list_tags", {
  description: "浏览标签树：不传参数=一级标签；传 tag_name=其直接子级；加 recursive=true=其下全部后代",
  inputSchema: { tag_name: t.schemas.tagNameQuery, recursive: t.schemas.recursive },
}, async ({ tag_name, recursive }) => ok(await t.listTags(tag_name, recursive)));

server.registerTool("rename_tag", {
  description: "重命名标签（层级用 / 分隔，如 开发/Linux）",
  inputSchema: { old_name: t.schemas.oldName, new_name: t.schemas.newName },
}, async ({ old_name, new_name }) => ok(await t.renameTag(old_name, new_name)));

server.registerTool("pin_tag", {
  description: "置顶标签",
  inputSchema: { tag: t.schemas.tagName },
}, async ({ tag }) => ok(await t.pinTag(tag, true)));

server.registerTool("unpin_tag", {
  description: "取消置顶标签",
  inputSchema: { tag: t.schemas.tagName },
}, async ({ tag }) => ok(await t.pinTag(tag, false)));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[flomo-mcp] ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[flomo-mcp] fatal: ${err}\n`);
  process.exit(1);
});
