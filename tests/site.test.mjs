import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'website/index.html'), 'utf8');
const script = readFileSync(resolve(root, 'website/app.js'), 'utf8');
const css = readFileSync(resolve(root, 'website/style.css'), 'utf8');
const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

test('one page title, main landmark and h1; unique IDs', () => {
  for (const tag of ['title', 'main', 'h1']) assert.equal((html.match(new RegExp(`<${tag}(?:>|\\s)`, 'g')) || []).length, 1);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(html, /<html lang="zh-CN">/);
});

test('all fragment links resolve; all local assets work under the GitHub Pages subpath', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    if (value.startsWith('#')) {
      if (value.length > 1) assert.ok(ids.has(value.slice(1)), `Missing anchor: ${value}`);
    } else if (!value.startsWith('https://')) {
      assert.ok(value.startsWith('./'), `Use project-relative asset paths: ${value}`);
      assert.ok(existsSync(resolve(root, 'website', value)), `Missing asset: ${value}`);
      assert.ok(new URL(value, 'https://location-txl.github.io/flomo-mcp/').pathname.startsWith('/flomo-mcp/'));
    }
  }
});

test('the page documents all actual registered MCP tools without inflating the count', () => {
  const tools = [...source.matchAll(/server\.registerTool\("([^"]+)"/g)].map(match => match[1]);
  assert.equal(tools.length, 12);
  const toolList = html.match(/<div class="tool-groups">([\s\S]+?)<section id="faq"/)[1];
  for (const name of tools) assert.ok(toolList.includes(name), `Missing tool: ${name}`);
});

test('copyable MCP configuration is valid JSON and uses the correct npm package', () => {
  const config = JSON.parse(html.match(/<code id="mcp-config">([\s\S]*?)<\/code>/)[1]);
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(config, { mcpServers: { flomo: { command: 'npx', args: ['-y', pkg.name] } } });
  assert.equal(pkg.engines.node, '>=22.4.0');
  assert.ok(html.includes('Node.js ≥ 22.4'));
});

test('security, independent-project status and search limits are disclosed in both languages', () => {
  for (const text of ['与 flomo 官方无关', 'Not affiliated with flomo', '127.0.0.1:9222', '本机进程', 'local processes', '4,000', 'complete: false', 'not a live AI chat', '不是在线 AI 对话', 'does not mean offline-only', '不等于离线运行']) assert.ok(html.includes(text), `Missing disclosure: ${text}`);
  assert.doesNotMatch(html, /update-proof|随版本免维护/i);
});

test('demos, language selection and copy controls have progressive enhancement and accessible hooks', () => {
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  for (const id of ['search', 'save', 'organize']) assert.ok(html.includes(`id="tab-${id}"`));
  for (const [, id] of html.matchAll(/data-copy="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /id="copy-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /ArrowLeft/);
  assert.match(script, /selectNodeContents/);
  assert.match(css, /prefers-reduced-motion/);
});

test('no runtime dependency, third-party asset requests or live account calls', () => {
  for (const [, value] of html.matchAll(/\bsrc="([^"]+)"/g)) assert.ok(value.startsWith('./'));
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|document\.cookie|sendBeacon/);
  assert.doesNotMatch(css, /@import\s|url\(\s*['"]?https?:/);
  assert.ok(existsSync(resolve(root, 'website/.nojekyll')));
});
