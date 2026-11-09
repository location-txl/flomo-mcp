# flomo-mcp 工具清单（维护文档）

> 本文是 flomo-mcp 提供的全部 MCP 工具的**唯一权威清单**。新增/修改工具时必须同步更新本文与文末变更记录。
> 面向使用者的说明见 [README.md](README.md)。

- server 名称：`flomo-mcp`（stdio）
- 工具总数：**12**（只读 5 / 写 7）
- 文中「实现」列对应 `src/tools.ts` 的导出函数；注册处为 `src/index.ts`。

## 总览

| # | 工具 | 类别 | 一句话 | 底层 | 实现 |
|---|---|---|---|---|---|
| 1 | `whoami` | 只读 | 验证连接：账号/笔记数/标签数 | Vuex + localStorage 直读（无网络请求） | `whoami` |
| 2 | `list_memos` | 只读 | 列笔记：recent 最近 200 条 / all 全量翻页 / tag 按标签过滤（含子标签） | `GET /memo/latest_updated_desc`、`GET /memo/updated/`（tag 为全量扫描+本地过滤） | `listMemos` |
| 3 | `search_memos` | 只读 | 关键词搜正文与标签（支持游标翻页） | `GET /memo/updated/` 全量翻页 + 本地过滤 | `searchMemos` |
| 4 | `get_memo` | 只读 | 单条笔记全文（HTML + 纯文本） | `GET /memo/<slug>` | `getMemo` |
| 5 | `create_memo` | 写 | 创建笔记 | `PUT /memo` | `createMemo` |
| 6 | `update_memo` | 写 | 更新笔记内容（保留元数据） | `GET /memo/<slug>` + `PUT /memo/<slug>` | `updateMemo` |
| 7 | `delete_memo` | 写 | 删除（移入回收站） | `DELETE /memo/<slug>` | `deleteMemo` |
| 8 | `sync` | 写 | 手动同步（等同点击同步按钮），返回统计 | 页面内 LocalDB 类 `syncWithPromise()`（pull+push） | `sync` |
| 9 | `list_tags` | 只读 | 标签树浏览：无参=一级；`tag_name`=直接子级；+`recursive`=全部后代 | Vuex `state.tags` 直读；fallback `GET /tag/updated/`；层级按名字 `/` 本地推导 | `listTags` |
| 10 | `rename_tag` | 写 | 重命名标签 | `POST /tag/rename` | `renameTag` |
| 11 | `pin_tag` | 写 | 置顶标签 | `POST /tag/pin` | `pinTag` |
| 12 | `unpin_tag` | 写 | 取消置顶标签 | `POST /tag/unpin` | `pinTag` |

## 通用约定

**调用链路**：所有工具 → `evalInPage()`（CDP `Runtime.evaluate`，每次新建 WebSocket 短连接，超时 20s）→ flomo 页面上下文 → `$api.callPromise()`。flomo 未带调试口时先自动拉起（`src/cdp.ts` `ensureFlomo`）。

**成功返回**：每个工具都声明 `outputSchema`，并同时返回 `structuredContent`（结构化数据，SDK 按 schema 强制校验）与 `content`（同一 JSON 的文本序列化，向后兼容）。可缺失字段一律为 `null`（不丢字段），列表工具的 `count` 指**本次返回条数**而非全量总数。

**分页约定**：返回 `next_cursor` 即表示还有下一页，原样传入下次调用即可；无该字段即已取完。游标无效或与当次参数不匹配时**报错**（而非静默重置），错误信息会说明如何从第一页重来。

**错误返回**：`isError: true`，文本为可行动的错误信息（说明原因与修正方式）。API 错误码语义：

| code | 含义 | 处理建议 |
|---|---|---|
| `-10` | 未登录 | 打开 flomo 重新登录 |
| `-20` | 编辑冲突（乐观锁） | 重新取最新内容后再更新 |
| `-998` | 页面内执行异常（$api 调用抛错） | 检查 flomo 版本是否大改，见「维护」 |
| `-999` | 响应不是预期 envelope | 同上 |

**数据格式**（flomo 约定，工具内部已处理）：

- `slug`：笔记唯一标识（base62 字符串），所有单笔记操作以它定位
- `created_at` / `updated_at`：`"YYYY-MM-DD HH:mm:ss"` 本地时区字符串；输出中不可用时为 `null`
- `tz`：`"H:M"` 时区偏移（如东八区 `"8:0"`）
- 翻页游标 `latest_updated_at`：**unix 秒**（传字符串会被服务端静默忽略——实测踩坑）

---

## 1. `whoami`

验证 flomo 连接，无参数。

```json
{ "account": "location", "memo_count": 371, "tag_count": 107, "pro": true }
```

- 未登录时报错（`isError: true`），提示打开 flomo 应用登录
- `account`：显示名，无名称时为脱敏邮箱（保留前 2 位 + 域名）
- `memo_count` / `tag_count`：flomo 页面内存不可用时为 `null`

## 2. `list_memos`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `limit` | int 1–200 | 否 | 20 | 返回条数（all 模式每页最多 100 条，超出按 100 执行） |
| `mode` | `"recent"` \| `"all"` | 否 | `recent` | recent=最近更新（最新在前，服务端上限 200 条）；all=全量按更新时间升序游标翻页。传 `tag` 时忽略 |
| `tag` | string | 否 | — | 按标签过滤：**前缀匹配含子标签**（查 `阅读` 也返回 `阅读/读书` 下的笔记）。传此参数时忽略 `mode`，全量扫描后本地过滤，按更新时间降序游标翻页 |
| `cursor` | string | 否 | — | 翻页游标，传上次返回的 `next_cursor`（mode=all 或 tag 过滤时使用；后者翻页须保持 `tag` 不变） |

**未传 tag** 返回：`{ mode, count, next_cursor?, memos: [ { slug, created_at, updated_at|null, tags[], excerpt } ] }`

**传 tag** 返回：`{ tag, complete, scanned, matched, count, next_cursor?, memos[…] }`（无 `mode` 字段，memos 结构同上）

- `excerpt` 为去 HTML 标签（已解码实体）后的前 200 字符；翻页到尾页时无 `next_cursor`
- 游标无效或与当次 `tag` 不匹配时报错"请从第一页重新开始"
- **已排除回收站笔记**：两个数据源（`/memo/latest_updated_desc`、`/memo/updated/`）都会返回已删除行（多端同步需要），本工具一律按 `deleted_at` 过滤，只返回存活笔记
- recent 用 `/memo/latest_updated_desc`（服务端 cap 200）；all 用 `/memo/updated/`（每页 ≤100）
- tag 过滤：flomo 无按标签查询的 API（应用内点标签也是本地过滤），本工具全量拉取 `/memo/updated/` 后按 memo 自带 `tags` 字段前缀匹配，与 `search_memos` 同一套全量扫描+offset 游标机制（`complete`/`scanned` 语义相同）

## 3. `search_memos`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `keyword` | string | 是 | — | 关键词，大小写不敏感，匹配正文（去 HTML）与标签 |
| `limit` | int 1–200 | 否 | 20 | 本次返回条数 |
| `cursor` | string | 否 | — | 翻页游标，传上次返回的 `next_cursor`，`keyword` 必须与首次搜索一致 |

返回：`{ complete, scanned, matched, count, next_cursor?, memos[…] }`（memos 结构同上，按更新时间降序）

- `matched`=匹配总数，`count`=本次返回条数；`matched > count` 时用 `next_cursor` 取下一页
- `complete: false` 表示触达 40 页（4000 条）扫描保护上限，结果可能不全
- **已排除回收站笔记**（与 `list_memos` 同一过滤口径）
- flomo 桌面端**没有远程搜索接口**（应用内搜索走本地 IndexedDB），本工具为全量拉取后本地过滤；游标编码 `{kw, offset}`，翻页时重新扫描按偏移切片（无服务端状态），翻页期间笔记更新可能导致少量偏移

## 4. `get_memo`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | 是 | 笔记 slug |

返回：`{ slug, created_at, updated_at|null, tags[], content_html, content_text }`

- `tags` 统一为字符串数组（含层级路径）；`content_text` 已解码常见 HTML 实体
- `GET /memo/<slug>` 的响应可能是对象或单元素数组，`fetchMemoRaw()` 已统一处理

## 5. `create_memo`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content` | string | 是 | 笔记内容，支持 HTML；**标签用 `#标签名` 语法写在内容里**（flomo 无独立建标签接口，标签由内容隐式创建） |

返回：`{ slug }`。响应未返回 slug 时报错（提示用 `list_memos` 确认是否实际已创建）。

## 6. `update_memo`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | 是 | 笔记 slug |
| `content` | string | 是 | 新内容（全量替换，非追加） |

返回：`{ slug }`。

实现先 `GET /memo/<slug>` 取原笔记，自动保留 `created_at`、`file_ids`（附件）、`pin`，再带 `local_updated_at`（unix 秒）提交。**content 是整篇替换**，先 `get_memo` 再改更稳妥。

## 7. `delete_memo`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | 是 | 笔记 slug |

返回：`{ slug, note: "已移入回收站" }`。可在 flomo 回收站恢复。

## 8. `sync`

手动触发同步，无参数，等同点击 flomo 界面左下角的同步按钮：先 pull（拉服务端最新笔记/标签进本地 IndexedDB），成功后 push（推送本地待同步修改到服务端），并返回同步统计。

```json
{ "synced": true, "code": "SUCCESS", "message": "同步完成",
  "duration_ms": 1001, "pull_success": true, "push_success": true,
  "updated_memo_count": 12, "tag_updated": 0 }
```

- 已有同步在进行中时**不报错**，返回 `{ synced: false, code: "SYNCING", …null }`，稍后重试即可
- pull/push 失败时 `isError`（code 为 `PULL_ERROR` / `PUSH_ERROR`），错误文案含失败原因（多为网络问题）
- `updated_memo_count` / `tag_updated` 为 flomo 同步引擎统计的本次更新数；UI 侧会在同步完成后清零，读取的是完成瞬间的值
- 实现：不走 `$api`，而是页面内调用 webpack 打包的 LocalDB 类（主包模块 77142，导出名 `Ay`）的 `syncWithPromise()`——与同步按钮同一入口。通过 `webpackChunkflomo.push` 注入捕获 webpack require；flomo 更新导致模块 id 漂移时按 `syncWithPromise` 签名扫描已加载模块兜底。副作用与按钮一致：同步完成后 flomo 自身会刷新 Vuex 中的标签/统计（`list_tags` 的内存快路径随之更新）

## 9. `list_tags`

按层级浏览标签树（flomo 标签扁平存储，层级只是名字里的 `/` 约定，树在本地按前缀推导）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tag_name` | string | 否 | 父标签名，支持任意层级路径（如 `阅读` 或 `阅读/读书`）。不传则返回一级标签 |
| `recursive` | boolean | 否 | 默认 `false`。传入 `tag_name` 时：`true`=其下所有层级后代；`false`=仅直接子级 |

返回：`{ count, tags: [ { id, name, pinned, count, direct_children, total_descendants } ] }`

```json
{ "count": 2,
  "tags": [ { "id": 1, "name": "阅读/读书", "pinned": false, "count": 5, "direct_children": 0, "total_descendants": 0 },
            { "id": null, "name": "阅读/杂谈", "pinned": false, "count": 7, "direct_children": 2, "total_descendants": 3 } ] }
```

- `id: null` 表示虚拟中间层节点（只建过 `#阅读/杂谈/xx` 而从未单独用过 `#阅读/杂谈`）
- `count`：一级视图为分支内合计（可能重复计数）；`null` 表示计数不可用（API fallback 路径无 count）
- `direct_children=0` 即叶子，无需继续下钻；`total_descendants` 为其下所有层级的实体标签总数
- 子级返回完整 name（含路径）；`recursive=true` 只返回实体标签
- `tag_name` 既非任何标签名也非任何前缀时报错（附恢复提示）；叶子标签查子级返回空列表属正常
- 一级视图排序：置顶优先，其余按名字
- 数据获取：优先 Vuex `state.tags` 内存直读（毫秒级、全量、含 count）；flomo 未完成同步时 fallback `/tag/updated/` 游标翻页（**服务端每页仅 ~8 条**，属已知的窗口限制，此时无 count）

## 10. `rename_tag`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `old_name` | string | 是 | 当前标签名 |
| `new_name` | string | 是 | 新标签名，层级用 `/` 分隔（如 `阅读/读书`） |

返回：`{ from, to }`（trim 后的规范化名称）。

按**名字**调 `/tag/rename`，存在性由服务器裁决（不依赖 Vuex 快照——新建标签在 Vuex 里可能滞后）。

## 11/12. `pin_tag` / `unpin_tag`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tag` | string | 是 | 标签名 |

返回：`{ tag, pinned }`。

---

## 维护指南

### flomo 更新后检查清单

1. 重跑 `npm run patch-flomo`（更新会覆盖注入的 asar）
2. `curl -s http://127.0.0.1:9222/json/version` 确认调试口
3. 跑 `node test-e2e.mjs` 全量回归。若批量报 `-998/-999`，多半是 flomo 改了页面结构，在 flomo 页面控制台验证两个锚点：
   - `window.__flomoVuexStore` 是否存在
   - `window.__flomoVuexStore._vm.$api` 及 `callPromise` 是否可调用
4. 若 `$api` 没了，需重新逆向：签名算法为 `md5(参数按 key 排序拼 k=v& + salt "dbbc3dd73364b4084c3a69346e0ce2b2")`
5. 若仅 `sync` 失效：webpack 模块 id 漂移属预期（有按 `syncWithPromise` 签名扫描已加载模块的兜底）；兜底也失败说明导出名变了，在主包 `index.*.js` 搜 `syncWithPromise` 重新定位模块

### 已知限制（设计如此，勿当 bug 修）

- 无远程搜索 API → `search_memos` 是全量拉取 + 本地过滤（40 页保护上限，`complete: false` 时告知调用方）
- `/memo/latest_updated_desc` 服务端 cap 200 条
- `/tag/updated/` 每页 ~8 条 → `list_tags` 优先 Vuex 直读
- 写操作走 **V1** 相对路径（V2 `callMemoWrite` 更新会触发 code=-20 乐观锁冲突，实测）
- 翻页游标必须 unix 秒
- MCP 无服务端状态 → 翻页游标只编码定位信息（list 编码时间戳，search 编码关键词+偏移），每次调用幂等重算

### 新增工具的步骤

1. `src/tools.ts`：实现导出函数 + 在 `schemas` 补输入 zod schema、在 `outputs` 补输出 zod schema（可缺失字段用 `.nullable()`，勿留 undefined）
2. `src/index.ts`：`server.registerTool(name, { description, inputSchema, outputSchema }, handler)`
3. `test-e2e.mjs` 补测试（写操作必须闭环清理）
4. **更新本文**：总览表 + 详情节 + 变更记录

### 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-07 | 0.1.0 | 首版：11 工具（whoami/list_memos/search_memos/get_memo/create_memo/update_memo/delete_memo/list_tags/rename_tag/pin_tag/unpin_tag），e2e 全绿，ASAR 注入交付 |
| 2026-11-08 | 0.1.2 | `list_tags` 重设计为标签树浏览：无参=一级标签、`tag_name`=直接子级、`recursive=true`=全部后代；层级按名字 `/` 前缀本地推导（不再默认返回全量）；中间层无实体时合成虚拟节点（`id: null`），一级视图置顶优先排序 |
| 2026-11-08 | 0.2.0 | 按 MCP 规范全量整改输出：全部工具声明 `outputSchema` 并返回 `structuredContent`（SDK 强制校验）；可缺失字段统一 `null` 不丢字段；`list_memos` `total`→`count`、坏游标报错；`search_memos` 支持游标翻页（`{kw,offset}` 无状态重扫）并新增 `complete` 截断标记；`update_memo` 移除本地伪造的 `updated_at`；`create_memo` slug 缺失改报错；`whoami` 未登录改 isError；`get_memo` tags 统一字符串数组、纯文本解码 HTML 实体；写工具移除 `ok: true` 冗余字段与参数回显；`list_tags` 行统一含 `total_descendants`；错误文案可行动化（去 `❌` 前缀）；补 zod 显式依赖 |
| 2026-11-08 | 未发布 | 新增第 12 个工具 `sync`：手动同步（等同点击 flomo 同步按钮），页面内直调 LocalDB `syncWithPromise()`（webpackChunk 注入捕获 require，模块 id 漂移时按签名扫描兜底），返回 pull/push 统计；同步进行中返回 `SYNCING` 不报错 |
| 2026-11-08 | 未发布 | `list_memos` 新增 `tag` 参数：按标签过滤列出该标签下笔记（前缀匹配含子标签，与 `list_tags` 后代计数同口径），传 `tag` 时忽略 `mode`，全量扫描本地过滤后按更新时间降序游标翻页（`{tag,offset}` 游标，返回结构对齐 `search_memos`） |
