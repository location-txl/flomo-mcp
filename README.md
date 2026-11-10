# flomo-mcp project website

This is the independent, long-lived `gh-pages` branch for the flomo-mcp project website. The MCP server remains on `main`; do not merge this website branch into `main`.

## Publish

In repository **Settings → Pages**, choose **Deploy from a branch**, then **gh-pages / (root)**. GitHub's built-in Pages publishing handles subsequent commits to this branch. No custom deployment workflow, npm installation, or build step is required.

Public URL after successful deployment: https://location-txl.github.io/flomo-mcp/

## Maintain

- `index.html`: Chinese content and English `data-en` translations.
- `app.js`: language switch, illustrative scenarios, copy controls.
- `style.css`: desktop, tablet and mobile styling.
- `assets/`: favicon and social image.
- `.nojekyll`: publish files as static content.

Keep local URLs relative (for example `./style.css`) to support the `/flomo-mcp/` project path. The site has no runtime dependencies, analytics, external fonts, or live account connection. Demos are illustrative. Language preference is stored only in visitors' localStorage.

For local preview, run `python3 -m http.server 8080` and open http://localhost:8080. Before publishing changes, check both languages and narrow screens, keyboard tab controls, copy buttons, FAQ disclosures, links, and browser navigation.

Capabilities and security statements must stay consistent with [the server README](https://github.com/location-txl/flomo-mcp#readme) and [TOOLS.md](https://github.com/location-txl/flomo-mcp/blob/main/TOOLS.md). This is an independent project, not affiliated with flomo.

## License

[MIT](LICENSE)
