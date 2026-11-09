#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import * as t from "./tools.js";

// 版本号只维护 package.json 一处，server 元数据与之同步
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "flomo-mcp", version });

// 成功：structuredContent 供客户端按 outputSchema 校验，text 序列化向后兼容
const ok = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
  structuredContent: data,
});
// 失败：isError 结果不经过 outputSchema 校验，文案须可行动（告诉 Agent 如何修正重试）
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

server.registerTool("whoami", {
  description: "验证 flomo 连接：显示当前登录账号、笔记与标签总数。未登录时报错，需先在 flomo 应用中登录",
  outputSchema: t.outputs.whoami,
}, async () => ok(await t.whoami()));

server.registerTool("list_memos", {
  description: "列出笔记。mode=recent 最近更新（最新在前，最多200条）；mode=all 全量按时间升序游标翻页（每页最多100条）；传 tag 按标签过滤（前缀匹配含子标签，如 阅读 也含 阅读/读书，全量扫描后按更新时间降序翻页，忽略 mode）",
  inputSchema: { limit: t.schemas.limit, mode: t.schemas.mode, cursor: t.schemas.cursor, tag: t.schemas.tagFilter },
  outputSchema: t.outputs.listMemos,
}, async ({ limit, mode, cursor, tag }) => ok(await t.listMemos(limit, mode, cursor, tag)));

server.registerTool("search_memos", {
  description: "按关键词搜索笔记（匹配正文与标签，大小写不敏感，结果按更新时间降序）。flomo 无远程搜索接口，每次调用全量拉取后本地过滤；翻页时传 next_cursor 且 keyword 保持不变",
  inputSchema: { keyword: t.schemas.keyword, limit: t.schemas.limit, cursor: t.schemas.searchCursor },
  outputSchema: t.outputs.searchMemos,
}, async ({ keyword, limit, cursor }) => ok(await t.searchMemos(keyword, limit, cursor)));

server.registerTool("get_memo", {
  description: "获取单条笔记全文（HTML 与纯文本）。update_memo 前先调用本工具取当前内容",
  inputSchema: { slug: t.schemas.slug },
  outputSchema: t.outputs.getMemo,
}, async ({ slug }) => ok(await t.getMemo(slug)));

server.registerTool("create_memo", {
  description: "创建笔记。标签用 #标签名 语法写在 content 中（flomo 无独立建标签接口，标签由内容隐式创建）",
  inputSchema: { content: t.schemas.content },
  outputSchema: t.outputs.createMemo,
}, async ({ content }) => ok(await t.createMemo(content)));

server.registerTool("update_memo", {
  description: "更新笔记内容（全量替换，自动保留原创建时间/置顶状态/附件）。先 get_memo 取原内容再修改回写",
  inputSchema: { slug: t.schemas.slug, content: t.schemas.content },
  outputSchema: t.outputs.updateMemo,
}, async ({ slug, content }) => ok(await t.updateMemo(slug, content)));

server.registerTool("delete_memo", {
  description: "删除笔记（移入回收站，可在 flomo 回收站恢复）",
  inputSchema: { slug: t.schemas.slug },
  outputSchema: t.outputs.deleteMemo,
}, async ({ slug }) => ok(await t.deleteMemo(slug)));

server.registerTool("sync", {
  description: "手动触发同步（等同点击 flomo 界面左下角同步按钮）：拉取服务端最新笔记/标签到本地并推送本地待同步修改，返回同步统计。已有同步在进行中时返回 code=SYNCING",
  outputSchema: t.outputs.sync,
}, async () => ok(await t.sync()));

server.registerTool("list_tags", {
  description: "浏览标签树：不传参数=一级标签；传 tag_name=其直接子级；加 recursive=true=其下全部后代。count 为 null 表示计数不可用",
  inputSchema: { tag_name: t.schemas.tagNameQuery, recursive: t.schemas.recursive },
  outputSchema: t.outputs.listTags,
}, async ({ tag_name, recursive }) => ok(await t.listTags(tag_name, recursive)));

server.registerTool("rename_tag", {
  description: "重命名标签（层级用 / 分隔，如 开发/Linux）",
  inputSchema: { old_name: t.schemas.oldName, new_name: t.schemas.newName },
  outputSchema: t.outputs.renameTag,
}, async ({ old_name, new_name }) => ok(await t.renameTag(old_name, new_name)));

server.registerTool("pin_tag", {
  description: "置顶标签",
  inputSchema: { tag: t.schemas.tagName },
  outputSchema: t.outputs.pinTag,
}, async ({ tag }) => ok(await t.pinTag(tag, true)));

server.registerTool("unpin_tag", {
  description: "取消置顶标签",
  inputSchema: { tag: t.schemas.tagName },
  outputSchema: t.outputs.pinTag,
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
