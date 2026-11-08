# AGENT.md

面向 AI 编码代理的项目指南。人类用户文档见 [README.md](README.md)，工具清单见 [TOOLS.md](TOOLS.md)。

## 项目是什么

flomo-mcp 是一个 stdio MCP server（TypeScript），通过 CDP（127.0.0.1:9222）连入本机 flomo 桌面客户端，在页面上下文调用 `window.__flomoVuexStore._vm.$api.*` 读写笔记与标签。认证/签名全部复用 flomo 应用自身逻辑，本项目**不持有任何凭证**。

## 常用命令

```bash
npm run build        # tsc 编译到 dist/（改代码后必跑）
node test-e2e.mjs    # 11 工具全链路测试（需 flomo 已登录且 9222 调试口可用）
npm run patch-flomo  # ASAR 注入调试口（幂等；flomo 自动更新后需重跑）
```

**测试前提**：flomo 已登录、`curl -s http://127.0.0.1:9222/json/version` 有响应。注意测试会**真实读写生产 flomo 账号**（写操作有临时标签闭环清理，勿删测试末尾的清理逻辑）。

## 文件职责

| 文件 | 职责 | 改动频率 |
|---|---|---|
| `src/index.ts` | stdio server 入口 + 11 个 `registerTool` | 加/改工具时 |
| `src/tools.ts` | 工具实现 + zod `schemas` | 最多 |
| `src/api.ts` | `$api.callPromise` 调用层 + flomo 时间/时区格式 | 极少 |
| `src/cdp.ts` | CDP WebSocket、`ensureFlomo` 兜底拉起、`evalInPage` | 极少 |
| `scripts/patch-flomo.mjs` | ASAR 注入（独立于 server，勿被 dist 构建影响） | flomo 更新时 |
| `TOOLS.md` | 工具权威清单 + 维护指南 | **改工具必须同步** |

## 修改工具的同步义务（三处 + 文档）

1. `src/tools.ts`：实现导出函数 + 在 `schemas` 补输入 schema、在 `outputs` 补输出 schema（可缺失字段用 `.nullable()`，勿返回 undefined 丢字段）
2. `src/index.ts`：`registerTool(name, { description, inputSchema, outputSchema }, handler)`——SDK 会按 outputSchema 强制校验非错误结果的 structuredContent
3. `test-e2e.mjs`：补测试（写操作必须闭环清理）
4. `TOOLS.md`：更新总览表、对应详情节、文末变更记录

## 不可破坏的逆向约束（改坏了不会报错，只会静默失效）

这些是逆向 + 实测得出的 flomo 服务端行为，代码注释里也有，集中列出防止误"优化"：

- **不要手拼签名/请求**：一切 API 调用走页面内 `$api.callPromise`，签名（md5+salt）、请求头、token 由应用生成。手拼 fetch 会得到 code:-1/-10。
- **写操作走 V1 相对路径**（`callApi` 的 `/memo`、`/memo/<slug>` 等）。V2 `callMemoWrite` 更新会触发 code=-20 乐观锁冲突。
- **翻页游标 `latest_updated_at` 必须传 unix 秒**（`uaToUnix()` 已处理）。传字符串服务端静默忽略，表现为翻页返回重复数据。
- **`list_tags` 优先 Vuex `state.tags` 直读**；`/tag/updated/` 服务端每页仅 ~8 条，只做 fallback。
- **标签写操作（rename/pin）按名字调 API**，不要先查 Vuex 找 id——新标签在 Vuex 快照里滞后。
- `latest_updated_desc` 服务端 cap 200 条；无远程搜索 API，`search_memos` 是全量拉取后本地过滤（40 页保护上限）。

## 代码约定

- TypeScript strict、ES2022、NodeNext：**import 必须带 `.js` 后缀**（`./tools.js`），否则编译报 TS5097。
- Node ≥ 20（用原生 `WebSocket`/`fetch`，不引 puppeteer/axios 等重依赖；新依赖前先想想是否真的需要）。
- 无 lint/format 配置，跟随现有风格：中文注释、注释克制（只解释"为什么"）、工具返回纯 JSON 可序列化对象（可缺失字段一律 `null`，不返回 `ok: true` 与参数回显）。
- flomo.app 路径统一走 `src/cdp.ts` 的 `FLOMO_APP`（环境变量 `FLOMO_APP_PATH` 优先，默认 `/Applications/flomo.app`），不要硬编码到别处。

## 排查 flomo 更新后的批量失败

批量 `-998/-999` ≈ flomo 改了页面结构。在 flomo 页面控制台验证：
1. `window.__flomoVuexStore` 存在
2. `window.__flomoVuexStore._vm.$api.callPromise` 可调用

若 `$api` 没了，需重新逆向（签名算法见 [TOOLS.md](TOOLS.md) 维护指南），不要凭旧代码猜。

## 禁止事项

- 不要提交 `dist/` 以外的构建产物；不要动 flomo 安装目录下的 `app.asar.orig` 备份（恢复原版的唯一依赖）。
- 不要在测试或调试中对用户真实笔记做无清理的写操作。
- 不要给 MCP 增加缓存层/flomo 凭证落盘逻辑（认证零配置是本项目的核心设计）。
