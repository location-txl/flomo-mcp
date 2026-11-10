# 项目宣传站

宣传站源码在 `website/`，是无运行时依赖的静态 HTML、CSS 和 JavaScript。默认中文，可切换英文；偏好只存于访问者浏览器的 localStorage。页面不连接 flomo 账号、不包含统计脚本或第三方字体，场景演示全部是示例数据。

预期公开地址：https://location-txl.github.io/flomo-mcp/

## 修改与检查

- 内容与英文翻译：`website/index.html` 中的正文及 `data-en`。
- 演示内容和交互：`website/app.js`。
- 响应式样式：`website/style.css`。
- 保持所有本地资源使用相对路径（例如 `./style.css`），以兼容 `/flomo-mcp/` 子路径。
- 安装版本要求与实际 `package.json` 保持同步；工具名称与数量以 `src/index.ts` 和 `TOOLS.md` 为准。
- 不要把项目宣传写成 flomo 官方背书，也不要把本地 MCP 连接描述为完全离线、内容不会传给 AI 客户端，或保证永远兼容。

```sh
npm ci
npm run build
npm run test:site
node --check website/app.js
```

普通本地环境可用任意静态文件服务器预览 `website/`。例如 `python3 -m http.server 8080 --directory website`，再打开 `http://localhost:8080`。

手工验收：桌面与 320 / 390 / 768px 宽屏幕，中英文切换和刷新保留、三组场景反复切换、方向键 / Home / End 操作标签、复制配置和提示、FAQ 展开收起、页内导航及浏览器后退。关闭 JavaScript 后正文、安装配置、链接与 FAQ 仍可使用。

## GitHub Pages 发布

`.github/workflows/pages.yml` 在 `main` 上的站点变动后部署，也支持手动触发；它只上传 `website/`。草稿 PR 和普通分支不会部署。现有 npm 发布流程不变。

首次发布需要仓库维护者在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，并把本 PR 合并至 `main`。这是公开项目网站，链接可由任何人访问。不要为此修改仓库可见性、分支保护或组织权限。工作流的部署 job 只申请 GitHub Pages 所需的 `pages: write` 和 `id-token: write`。

如果设置尚未启用或发布授权尚未确认，请保留草稿 PR，不把预计网址当成已上线的网址。上线后应核对工作流成功、部署提交 SHA、公开网页及 CSS / JavaScript 资源均可访问。
