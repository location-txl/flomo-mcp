# flomo-mcp

通过 CDP 复用本机 flomo 客户端登录态的 MCP server：查询/编辑笔记与标签，无需任何 API Key。

## 架构

```
Claude/ZCode ──stdio──▶ flomo-mcp ──CDP(127.0.0.1:9222)──▶ flomo 桌面客户端
                                                        │  在 flomo 页面上下文执行
                                                        │  window.__flomoVuexStore._vm.$api.*
                                                        ▼
                                              https://flomoapp.com/api/v1|v2
                                              （认证/签名由 flomo 自身逻辑处理）
```

- **认证零配置**：token、签名（md5+salt）、V2 网关全部复用 flomo 应用内部逻辑，flomo 重新登录自动跟随
- **兜底拉起**：若 flomo 未启动或没带调试口，MCP 首次调用时自动 quit + 以 `--remote-debugging-port=9222` 重启

## 工具（11 个）

| 工具 | 说明 |
|---|---|
| `whoami` | 验证连接，显示账号/笔记数/标签数 |
| `list_memos` | recent=最近 200 条（最新在前）；all=全量游标翻页 |
| `search_memos` | 全量拉取后按关键词过滤正文与标签（桌面端无远程搜索 API） |
| `get_memo` | 笔记全文（HTML + 纯文本） |
| `create_memo` | 创建；标签用 `#标签名` 语法写在 content 中 |
| `update_memo` | 更新（保留创建时间/置顶/附件） |
| `delete_memo` | 移入回收站 |
| `list_tags` | 全部标签（Vuex 内存直读，毫秒级） |
| `rename_tag` | 重命名（层级用 `/` 分隔） |
| `pin_tag` / `unpin_tag` | 标签置顶 |

## 安装与注册

```bash
cd /Volumes/out/workspace/mcp/flomo-mcp
npm install && npm run build
```

MCP 客户端配置（ZCode / Claude 等）：

```json
{
  "mcpServers": {
    "flomo": {
      "command": "node",
      "args": ["/Volumes/out/workspace/mcp/flomo-mcp/dist/index.js"]
    }
  }
}
```

## 双击启动即带调试口（已注入）

flomo 已被注入 `--remote-debugging-port=9222`（双击启动自动开启调试口，无需带参数）。
注入方式：`npm run patch-flomo`（脚本 `scripts/patch-flomo.mjs`，幂等可重跑）。

- **flomo 自动更新后注入会被覆盖** → 重跑 `npm run patch-flomo` 即可
- **恢复原版**：`cp <flomo.app>/Contents/Resources/app.asar.orig <flomo.app>/Contents/Resources/app.asar && codesign --force --deep --sign - <flomo.app>`
- 原始未修改 app 备份在 `/Volumes/out/Applications/flomo.app.mcpbak`

> macOS App Management 说明：若 patch 脚本报 `Operation not permitted`，是 app 带了
> quarantine 属性触发 TCC 保护。处理：重命名 app 后用
> `tar --no-xattrs` 复制一份无 quarantine 的副本再注入（本次已处理）。

## 安全提示

- 9222 端口对本机所有进程可见，等同于 flomo 笔记读写权。介意可改用 `--remote-debugging-pipe`
- 本项目不存储任何凭证；token 始终留在 flomo 应用的 localStorage 中

## 测试

```bash
node test-e2e.mjs   # 11 个工具全链路（含写闭环 create→update→rename→pin→delete）
```
