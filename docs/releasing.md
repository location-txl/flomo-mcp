# 发布 flomo-mcp

工作流合入 `main` 后，在 [`@location-txl/flomo-mcp` 的 npm 设置](https://www.npmjs.com/package/@location-txl/flomo-mcp/access)添加 [GitHub Actions Trusted Publisher](https://docs.npmjs.com/trusted-publishers/)：

| 设置 | 值 |
| --- | --- |
| Organization or user | `location-txl` |
| Repository | `flomo-mcp` |
| Workflow filename | `release.yml` |
| Environment name | 留空 |
| Allowed actions | 允许直接 `npm publish` |

添加后两天内需完成首次发布。工作流通过 OIDC 认证，无需配置 npm token。

确认目标提交包含发布工作流、已通过 CI，且版本尚未发布到 npm，再创建并推送一个新标签：

```sh
git tag v0.2.0
git push origin v0.2.0
```

标签可带 `v` 前缀。每个版本只推送一种写法：`0.2.0` 和 `v0.2.0` 都会发布 `@location-txl/flomo-mcp@0.2.0`，分发标签为 `latest`。`v0.3.0-beta.1` 会发布到 `next`，并在 GitHub 标为预发布。带 `+` 构建元数据的版本不接受。

工作流只在构建目录中更新版本，所以 npm 包内的 `package.json` 和 MCP 初始化时报告的版本都来自标签；GitHub 标签指向的源码不会被改写。构建只读取 `setup-node` 的 npm 缓存，不为标签保存新缓存。

npm 发布成功后，工作流使用原始标签创建 GitHub Release 并自动生成发布说明。若 npm 发布失败，修复问题后重跑失败任务；若 npm 已发布且只有 GitHub Release 失败，只重跑失败任务即可。
