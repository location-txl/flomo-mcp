# flomo-mcp

[English](README.en.md) | **中文**

[![npm](https://img.shields.io/npm/v/@location-txl/flomo-mcp.svg)](https://www.npmjs.com/package/@location-txl/flomo-mcp)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

让 AI 直接读写你的 [flomo](https://flomoapp.com) 笔记——无需任何 API Key。flomo-mcp 是一个 [MCP](https://modelcontextprotocol.io) server，通过本机已登录的 flomo 桌面客户端（macOS）向 AI 客户端（Claude Desktop、ZCode、Cursor 等）提供笔记与标签的完整读写能力。

## 这是什么

flomo 没有公开 API。本项目不做"逆向接口 + 手工签名"，而是通过 Chrome DevTools Protocol 连接本机 flomo 桌面客户端，在页面上下文中直接调用应用内部的请求层，token、签名、请求路由全部由 flomo 自己处理：

```
AI 客户端 ──stdio──▶ flomo-mcp ──CDP(127.0.0.1:9222)──▶ flomo 桌面客户端
                                                        │  在 flomo 页面上下文执行
                                                        │  window.__flomoVuexStore._vm.$api.*
                                                        ▼
                                              https://flomoapp.com/api/v1
                                              （认证/签名由 flomo 自身处理）
```

- **认证零配置**：不存储任何凭证，token 始终留在 flomo 的 localStorage 里，flomo 里重新登录后自动跟随
- **随版本免维护**：API 调用复用页面内 webpack 打包的 `$api` 单例，签名算法、请求头由应用自己生成，flomo 常规更新不破坏兼容
- **兜底拉起**：每次工具调用前检查调试口；flomo 未启动会自动带 `--remote-debugging-port=9222` 拉起，已启动但无调试口会自动重启它

### 能做什么

| 你对 AI 说 | 背后调用的工具 |
|---|---|
| "flomo 里搜一下关于 docker 的笔记" | `search_memos` |
| "看看我最近写了什么" | `list_memos` |
| "帮我把这条想法记到 flomo，带上 #灵感 标签" | `create_memo` |
| "把 xxx 这条笔记改成…" | `get_memo` + `update_memo` |
| "我有哪些标签？把『读书』置顶" | `list_tags` + `pin_tag` |
| "把标签 读书 改成 阅读/读书" | `rename_tag` |

全部 12 个工具（5 只读 / 7 写）的参数与返回结构见 **[TOOLS.md](TOOLS.md)**。

## 使用

### 环境要求

- macOS + 已登录的 flomo 桌面客户端（默认路径 `/Applications/flomo.app`）
- Node.js ≥ 22.4（依赖原生 WebSocket，无需 puppeteer 等外部浏览器）

### 安装

已发布到 npm，推荐用 npx 直接运行，无需 clone：

```bash
npx @location-txl/flomo-mcp
```

从源码运行（面向开发者）：

```bash
git clone https://github.com/location-txl/flomo-mcp.git ~/flomo-mcp
cd ~/flomo-mcp
npm install
npm run build
```

### 注册到 MCP 客户端

```json
{
  "mcpServers": {
    "flomo": {
      "command": "npx",
      "args": ["-y", "@location-txl/flomo-mcp"]
    }
  }
}
```

flomo 不装在默认路径时，通过环境变量指定：

```json
{
  "mcpServers": {
    "flomo": {
      "command": "npx",
      "args": ["-y", "@location-txl/flomo-mcp"],
      "env": { "FLOMO_APP_PATH": "/你的路径/flomo.app" }
    }
  }
}
```

从源码运行时，`command` / `args` 换成 `"node"` / `["~/flomo-mcp/dist/index.js"]`。

重启客户端后，对 AI 说：

> 用 flomo 的 whoami 看看连上了吗

返回账号（邮箱脱敏）、笔记总数、标签总数即注册成功。

### 可选：注入调试口（双击启动即生效）

MCP 自带兜底拉起逻辑，不注入也能用；注入后双击 flomo 图标即带调试口，省去首次调用自动重启的等待：

```bash
npx -p @location-txl/flomo-mcp flomo-mcp-patch   # 默认 /Applications/flomo.app
npx -p @location-txl/flomo-mcp flomo-mcp-patch -- /你的路径/flomo.app

# 或源码目录内
npm run patch-flomo -- /你的路径/flomo.app
```

- 脚本幂等，可重复运行；自动备份原版到 `app.asar.orig`
- **flomo 自动更新会覆盖注入**，更新后重跑一次即可
- 恢复原版：

```bash
cp "/Applications/flomo.app/Contents/Resources/app.asar.orig" \
   "/Applications/flomo.app/Contents/Resources/app.asar"
codesign --force --deep --sign - "/Applications/flomo.app"
```

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| `未登录：请在 flomo 应用中重新登录`（code=-10） | flomo 里登录态过期，打开 flomo 重新登录即可 |
| `编辑冲突`（code=-20） | 笔记刚被其他端（手机/网页）改过，重新 `get_memo` 拿最新内容后再改 |
| 工具首次调用很慢（~10s） | 触发了兜底：自动 quit + 带调试口重启 flomo，属正常 |
| `无法连接 flomo 调试口` | 手动跑 `open -a flomo --args --remote-debugging-port=9222`；仍不行确认 flomo 安装路径并用 `FLOMO_APP_PATH` 指定 |
| `patch-flomo` 报 `Operation not permitted` | macOS App Management（TCC）拦截：app 带 quarantine 属性。重命名 app 后用 `tar --no-xattrs` 复制一份无 quarantine 副本再注入 |
| flomo 更新后工具全挂 | 更新覆盖了注入的 asar → 重跑 `npm run patch-flomo`；若仍挂，按 [AGENT.md](AGENT.md) 的排查步骤检查页面锚点 |

### 安全提示

- 9222 调试口对本机**所有进程**可见，等同 flomo 笔记读写权。介意的话可把注入参数改为 `--remote-debugging-pipe`（需要同步改 `src/cdp.ts`）
- 本项目不落盘任何凭证；`whoami` 输出的邮箱已脱敏

## 开发

### 常用命令

```bash
npm run build          # tsc 编译到 dist/（改代码后必跑）
node test-e2e.mjs      # 12 个工具全链路测试
npm run patch-flomo    # ASAR 注入（可选）
```

### 测试须知

e2e 测试连接的是**真实 flomo 账号**：写操作走 create→update→rename→pin→delete 闭环并自动清理，请勿删除测试末尾的清理逻辑。运行前提：flomo 已登录、调试口可用；flomo 不在默认路径时先 `export FLOMO_APP_PATH=...`。

### 源码结构

```
src/
├── index.ts   # stdio MCP server 入口 + 12 个工具注册
├── cdp.ts     # CDP 客户端：探测/兜底拉起 flomo、页面上下文执行
├── api.ts     # 复用页面 $api 的调用层 + flomo 时间/时区格式工具
└── tools.ts   # 工具实现与参数 schema
scripts/
└── patch-flomo.mjs  # ASAR 注入（幂等）
```

### 深入文档

- **[TOOLS.md](TOOLS.md)** — 全部工具的参数、返回结构、底层接口、维护指南
- **[AGENT.md](AGENT.md)** — 架构约束、逆向得出的不可破坏规则、flomo 更新后的排查步骤
- **[发布流程](docs/releasing.md)** — 配置 npm Trusted Publisher，通过 Git 标签发布 npm 和 GitHub Release

项目宣传站源码与发布说明见 **[网站维护文档](docs/website.md)**。

## License

[MIT](LICENSE)

本项目为个人学习研究项目，与 flomo 官方无关，请自行遵守 flomo 服务条款使用。
