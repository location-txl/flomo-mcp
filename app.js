const translations = [...document.querySelectorAll('[data-en]')].map(element => ({
  element,
  zh: element.innerHTML,
  en: element.dataset.en,
}));
const languageToggle = document.querySelector('#language-toggle');
let language = 'zh';
let scenario = 'search';
let toastTimer;
const scenarios = {
  search: {
    zh: ['帮我找找 flomo 里关于「创作」的笔记。', 'search_memos({ keyword: "创作" })', '示例笔记', '创作不是等待灵感，而是给灵感一个每天都会出现的地方。', '#创作 #习惯', '按关键词匹配正文与标签，把相关笔记带回对话。'],
    en: ['Find my flomo notes about creativity.', 'search_memos({ keyword: "creativity" })', 'Example note', 'Creativity is not waiting for inspiration. It is giving inspiration a place to show up every day.', '#creativity #habits', 'Match keywords in content and tags, and bring relevant notes into the conversation.'],
  },
  save: {
    zh: ['把这个想法记到 flomo：每天留一点时间写作，带上 #创作 标签。', 'create_memo({ content: "每天留一点时间写作。 #创作" })', '写入内容示例', '每天留一点时间写作。', '#创作', '标签随笔记正文创建。真实使用时，写入会改变你的 flomo 账号内容。'],
    en: ['Save this idea to flomo: Make a little time to write each day. Add #creativity.', 'create_memo({ content: "Make a little time to write each day. #creativity" })', 'Example note to create', 'Make a little time to write each day.', '#creativity', 'Tags are created from the note content. In real use, this writes to your flomo account.'],
  },
  organize: {
    zh: ['把「读书」标签改成「阅读/读书」。', 'rename_tag({ old_name: "读书", new_name: "阅读/读书" })', '标签整理示例', '把独立标签放回更清晰的主题层级。', '#阅读/读书', '使用 / 表示标签层级。真实使用时，重命名会改变账号中的标签。'],
    en: ['Rename the “books” tag to “reading/books”.', 'rename_tag({ old_name: "books", new_name: "reading/books" })', 'Example tag organization', 'Give a standalone tag a place in a clearer topic hierarchy.', '#reading/books', 'A / separates tag levels. In real use, renaming changes the tag in your account.'],
  },
};
function renderScenario() {
  const values = scenarios[scenario][language];
  ['demo-prompt', 'demo-code', 'demo-result-label', 'demo-result', 'demo-tag', 'demo-explainer'].forEach((id, index) => {
    document.getElementById(id).textContent = values[index];
  });
  document.querySelectorAll('[data-scenario]').forEach(button => {
    const selected = button.dataset.scenario === scenario;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelector('#demo-panel').setAttribute('aria-labelledby', `tab-${scenario}`);
}
function setLanguage(next) {
  language = next;
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  translations.forEach(({element, zh, en}) => {
    if (next === 'zh') element.innerHTML = zh;
    else element.textContent = en;
  });
  languageToggle.innerHTML = next === 'zh' ? 'EN <span aria-hidden="true">→</span>' : '中文 <span aria-hidden="true">→</span>';
  languageToggle.setAttribute('aria-label', next === 'zh' ? 'Switch to English' : '切换为中文');
  document.title = next === 'zh' ? 'flomo-mcp · 让每一条想法，都有下一步' : 'flomo-mcp · Every thought. A next chapter.';
  const nav = document.querySelector('.nav-links');
  nav.setAttribute('aria-label', next === 'zh' ? '主导航' : 'Main navigation');
  document.querySelector('.hero-visual').setAttribute('aria-label', next === 'zh' ? '笔记连接 AI 的概念演示' : 'Illustration of notes connecting to AI');
  document.querySelector('[role="tablist"]').setAttribute('aria-label', next === 'zh' ? '演示场景' : 'Demo scenarios');
  document.querySelector('.wordmark').setAttribute('aria-label', next === 'zh' ? 'flomo-mcp 首页' : 'flomo-mcp home');
  const setupLink = document.querySelector('.setup-intro > .text-link');
  setupLink.href = next === 'zh' ? 'https://github.com/location-txl/flomo-mcp#使用' : 'https://github.com/location-txl/flomo-mcp/blob/main/README.en.md#usage';
  renderScenario();
  try { localStorage.setItem('flomo-mcp-language', next); } catch { /* The page also works when storage is disabled. */ }
}
languageToggle.hidden = false;
languageToggle.addEventListener('click', () => setLanguage(language === 'zh' ? 'en' : 'zh'));
document.querySelectorAll('[data-scenario]').forEach(button => {
  button.addEventListener('click', () => { scenario = button.dataset.scenario; renderScenario(); });
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-scenario]')];
    const index = tabs.indexOf(button);
    const keys = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    tabs[keys[event.key]].click();
    tabs[keys[event.key]].focus();
  });
});
function notify(message) {
  const status = document.querySelector('#copy-status');
  clearTimeout(toastTimer);
  status.textContent = message;
  status.classList.add('visible');
  toastTimer = setTimeout(() => status.classList.remove('visible'), 3500);
}
document.querySelectorAll('[data-copy]').forEach(button => {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(target.textContent);
      notify(language === 'zh' ? '已复制，可以粘贴到客户端了。' : 'Copied. Ready to paste into your client.');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      notify(language === 'zh' ? '内容已选中，请手动复制。' : 'Text selected. Please copy it manually.');
    }
  });
});
try {
  if (localStorage.getItem('flomo-mcp-language') === 'en') setLanguage('en');
} catch { /* Storage is optional. */ }
