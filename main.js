const { Plugin, MarkdownRenderer, MarkdownView, Component, Notice } = require('obsidian');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// 용지 크기 (mm, 세로 기준)
const PAPER = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210],
  Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
};
const MARGIN_MM = 15;

// 크롬 안에서 실행: 블록 높이를 재서 페이지 나눌 위치를 직접 정한다.
// 1) 섹션(#, ## 제목 ~ 다음 제목)이 남은 공간에 안 들어가면 섹션째 새 페이지로
// 2) 섹션이 한 페이지보다 길면 소제목(###, ####)·콜아웃 경계에서, 그것도 길면 블록 경계에서 나눔
// 3) 블록 하나가 한 페이지보다 길 때만 블록 안에서 나뉨
function paginate(PAGE_H) {
  const H = PAGE_H - 10; // 측정 오차 여유 (px)
  const root = document.querySelector('.print .markdown-rendered');
  const blocks = [];
  let force = false;
  for (const el of Array.from(root.children)) {
    if (el.querySelector(':scope > div[style*="page-break-after"]')) {
      el.style.setProperty('display', 'none', 'important');
      force = true;
      continue;
    }
    const h = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
    blocks.push({ el, force, lvl: h ? +h.tagName[1] : 0, callout: !!el.querySelector(':scope > .callout') });
    force = false;
  }
  // 스니펫 등의 페이지 넘김 규칙은 끄고, 여기서 정한 곳에서만 넘긴다
  for (const b of blocks) {
    b.el.style.setProperty('break-before', 'auto', 'important');
    b.el.style.setProperty('break-after', 'auto', 'important');
    const r = b.el.getBoundingClientRect();
    b.top = r.top;
    b.bottom = r.bottom;
  }
  // 높이가 없는 빈 블록은 계산에서 뺀다 (강제 넘김 표시는 다음 블록으로 넘김)
  const vis = [];
  let pending = false;
  for (const b of blocks) {
    if (b.bottom - b.top <= 2) { pending = pending || b.force; continue; }
    b.force = b.force || pending;
    pending = false;
    b.prev = vis[vis.length - 1];
    vis.push(b);
  }
  if (!vis.length) return;
  const end = root.getBoundingClientRect().bottom;
  vis.forEach((b, i) => { b.h = (i + 1 < vis.length ? vis[i + 1].top : end) - b.top; });

  const split = (arr, isStart) => arr.reduce((out, b, i) => {
    if (i === 0 || isStart(b)) out.push([]);
    out[out.length - 1].push(b);
    return out;
  }, []);
  // 덩어리가 차지하는 높이: 위 블록의 시작 ~ 마지막 블록의 끝 (페이지 끝의 여백은 잘리므로 뺌)
  const sum = (arr) => arr[arr.length - 1].bottom - arr[0].top;
  // 다음 덩어리 시작까지 쓰는 높이 (여백 포함)
  const adv = (arr) => arr.reduce((s, b) => s + b.h, 0);
  let used = 0;
  // 앞 블록 "뒤에서" 넘긴다 (다음 블록 앞에서 넘기면 앞 페이지가 꽉 찼을 때 빈 페이지가 생김)
  // 강제로 넘긴 페이지는 맨 위 여백이 남으므로 0으로 만든다 (계산은 블록 위 끝부터 했음)
  const newPage = (b) => {
    if (used > 0 && b.prev) {
      b.prev.el.style.setProperty('break-after', 'page', 'important');
      for (let e = b.el; e; e = e.firstElementChild) e.style.setProperty('margin-top', '0', 'important');
      // 넘어가는 자리에 있는 구분선(---)·빈 블록은 새 페이지 위에 여백만 남기므로 숨긴다
      for (let e = b.el.previousElementSibling; e && e !== b.prev.el; e = e.previousElementSibling) {
        e.style.setProperty('display', 'none', 'important');
      }
    }
    used = 0;
  };
  // 덩어리를 놓는다: 남은 공간에 안 들어가면 새 페이지
  const place = (chunk, fit) => { if (used + fit > H) newPage(chunk[0]); };

  const sections = split(vis, (b) => b.lvl === 1 || b.lvl === 2);
  sections.forEach((sec, si) => {
    if (sec[0].force) newPage(sec[0]);
    const total = sum(sec);
    const subs = split(sec, (b) => b.lvl === 3 || b.lvl === 4 || b.callout);
    // 내용 없이 제목만 있는 섹션(# 2주차 + 한 줄)은 다음 섹션 첫 부분과 같이 놓는다
    const next = sections[si + 1];
    const tail = sec.length <= 2 && next && !next[0].force
      ? adv(sec) - total + sum(split(next, (b) => b.lvl >= 3 || b.callout)[0]) : 0;
    if (total <= H) { place(sec, Math.min(total + tail, H)); used += adv(sec); return; }

    subs.forEach((sub) => {
      const sh = sum(sub);
      if (sh <= H) { place(sub, sh); used += adv(sub); return; }
      // 제목 블록은 바로 다음 블록과 한 덩어리로 다룬다
      const units = split(sub, (b) => !(b.prev && b.prev.lvl && sub.includes(b.prev)));
      units.forEach((u) => {
        const uh = sum(u);
        if (uh <= H) { place(u, uh); used += adv(u); return; }
        // 한 페이지보다 긴 덩어리: 남은 공간이 절반 넘게 찼으면 새 페이지에서 시작하고 안에서 나뉘도록 허용
        if (used > H * 0.5) newPage(u[0]);
        for (const b of u) {
          b.el.style.setProperty('break-inside', 'auto', 'important');
          b.el.querySelectorAll('.callout, table, blockquote, pre').forEach((e) => e.style.setProperty('break-inside', 'auto', 'important'));
        }
        used = (used + adv(u)) % H + 40;
      });
    });
  });
}

// @media print 규칙은 화면에서도 적용되게 풀고 @media screen 규칙은 버린다
// (높이를 잴 때와 인쇄할 때 레이아웃이 같아야 함)
function collectCss(rules) {
  return Array.from(rules).map((r) => {
    if (r instanceof CSSMediaRule) {
      const m = r.media.mediaText;
      if (/\bprint\b/.test(m) && !/\bscreen\b/.test(m)) return collectCss(r.cssRules);
      if (/\bscreen\b/.test(m) && !/\bprint\b/.test(m)) return '';
    }
    return r.cssText;
  }).join('\n');
}

module.exports = class ChromePdfExport extends Plugin {
  onload() {
    // 옵시디언 기본 "PDF로 내보내기"(⋯ 메뉴·명령 팔레트 모두 MarkdownView.printToPdf를 부름)를 이 방식으로 바꾼다
    const proto = MarkdownView.prototype;
    const original = proto.printToPdf;
    const plugin = this;
    proto.printToPdf = function () { plugin.exportPdf(this.file); };
    this.register(() => { proto.printToPdf = original; });
  }

  async exportPdf(file) {
    const browser = BROWSERS.find((p) => fs.existsSync(p));
    if (!browser) return new Notice('크롬이나 엣지를 찾지 못했습니다.');

    const { dialog, shell } = require('electron').remote;
    const res = await dialog.showSaveDialog({
      defaultPath: path.join(path.dirname(this.app.vault.adapter.getFullPath(file.path)), file.basename + '.pdf'),
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return;

    const notice = new Notice('PDF 만드는 중...', 0);
    const host = document.body.createDiv();
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;';
    const comp = new Component();
    comp.load();
    try {
      // 옵시디언 PDF 내보내기와 같은 구조: .print > .markdown-rendered > div(블록 하나씩)
      const view = host.createDiv('markdown-preview-view markdown-rendered');
      const settings = this.app.vault.getConfig('pdfExportSettings') || {};
      if (settings.includeName !== false) view.createEl('h1', { text: file.basename });
      const body = createDiv();
      await MarkdownRenderer.render(this.app, await this.app.vault.cachedRead(file), body, file.path, comp);
      await sleep(1500); // 수식·다이어그램 렌더링 대기
      for (const el of Array.from(body.children)) {
        if (el.tagName === 'HR' || el.classList.contains('frontmatter') || el.classList.contains('frontmatter-container')) {
          if (el.tagName === 'HR') view.appendChild(el);
          continue;
        }
        view.createDiv().appendChild(el);
      }
      view.querySelectorAll('a.internal-link').forEach((a) => a.removeAttribute('href'));

      const css = Array.from(document.styleSheets).map((s) => {
        try { return collectCss(s.cssRules); } catch (e) { return ''; }
      }).join('\n');
      const bodyCls = document.body.className.replace('theme-dark', 'theme-light');
      const size = settings.pageSize in PAPER ? settings.pageSize : 'A4';
      let [w, h] = PAPER[size];
      if (settings.landscape) [w, h] = [h, w];
      const pageH = (h - 2 * MARGIN_MM) * 96 / 25.4; // mm → CSS px
      const html = `<!doctype html><html class="${document.documentElement.className}"><head><meta charset="utf-8">
<base href="app://local/"><style>${css}</style>
<style>@page { size: ${w}mm ${h}mm; margin: ${MARGIN_MM}mm; }
html, body { background: white !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; height: auto !important; }
.print { width: ${w - 2 * MARGIN_MM}mm; }</style></head>
<body class="${bodyCls}"><div class="print">${view.outerHTML}</div>
<script>(${paginate.toString()})(${pageH});</script></body></html>`
        .replace(/app:\/\/[^/"')]+\//g, 'file:///');

      const tmp = path.join(os.tmpdir(), 'obsidian-chrome-pdf.html');
      fs.writeFileSync(tmp, html, 'utf8');
      await new Promise((resolve, reject) => execFile(browser, [
        '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--allow-file-access-from-files',
        '--print-to-pdf=' + res.filePath, 'file:///' + tmp.split(path.sep).join('/'),
      ], { timeout: 120000 }, (err) => (err && !fs.existsSync(res.filePath) ? reject(err) : resolve())));
      fs.unlinkSync(tmp);
      new Notice('PDF 저장: ' + res.filePath);
      shell.openPath(res.filePath);
    } catch (e) {
      console.error(e);
      new Notice('PDF 내보내기 실패: ' + e.message);
    } finally {
      notice.hide();
      comp.unload();
      host.remove();
    }
  }
};
