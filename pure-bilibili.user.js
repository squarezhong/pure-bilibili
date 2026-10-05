// ==UserScript==
// @name         Pure Bilibili
// @namespace    https://github.com/squarezhong/pure-bilibili
// @version      0.1.5
// @description  首页进入关注动态，清理推荐和显式推广，保留主动搜索与个人记录，顶栏入口可配置。
// @author       squarezhong
// @match        https://bilibili.com/*
// @match        https://www.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://live.bilibili.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const FOLLOW = 'https://t.bilibili.com/';
  const KEY = 'pure-bilibili-settings-v1';
  const HIDDEN = 'pure-bilibili-hidden';
  const UI_ID = 'pure-bilibili-settings';
  const HEADER = '.bili-header,.bili-header-m,.international-header,.mini-header,.link-navbar';
  const ENTRY = '.left-entry__item,.right-entry__item,.nav-item,.nav-link-item';
  const PROSE = '.bili-rich-text,.bili-dyn-content,.bili-dyn-title,.bili-dyn-card-video,.bili-dyn-card-article,.desc-info,.basic-desc-info,.reply-content,.comment-text,.article-holder,[contenteditable="true"],textarea';
  const NOISY = '.bpx-player-row-dm-wrap,.bpx-player-dm-wrap,.bpx-player-control-wrap,.bpx-player-subtitle,.bilibili-player-video-danmaku,.danmaku-item,.chat-history-list,.chat-items,.chat-item,.live-player-mounter,video,canvas';
  const ITEMS = [
    ['home', '首页／Logo', true], ['dynamic', '动态', true], ['messages', '消息', true],
    ['favorites', '收藏', true], ['history', '历史', true], ['creator', '创作中心', true],
    ['anime', '番剧', false], ['live', '直播大厅', false], ['games', '游戏中心', false],
    ['shop', '会员购', false], ['manga', '漫画', false], ['matches', '赛事', false],
    ['download', '下载客户端', false], ['vip', '大会员', false], ['upload', '投稿', false],
    ['liveAreas', '直播分区入口', false], ['liveWallet', '直播充值入口', false],
    ['broadcast', '我要开播', false]
  ];
  const DEFAULTS = Object.fromEntries(ITEMS.map(([id, , value]) => [id, value]));
  // These rules address modules, never arbitrary text in a post or a comment.
  const MODULES = {
    dynamic: ['.bili-dyn-search-trendings', '.bili-dyn-banner', '.bili-dyn-recommend', '.bili-dyn-recommend-up'],
    video: ['.recommend-list-v1', '.recommend-list', '.slide-ad-exp', '.ad-report',
      '.video-card-ad-small', '.ad-feedback-menu', '.ad-feedback-menu-popover',
      '.bpx-player-ending-related', '.bpx-player-ending-recommend', '.bpx-player-recommend',
      '.bilibili-player-ending-panel-box-recommend'],
    search: ['.search-recommend', '.search-recommend-container', '.search-discovery'],
    space: ['.game-card', '.game-entry', '.recommend-follow', '.recommend-user'],
    library: ['.recommend-container', '.recommend-list', '.recommend-list-v1', '.guess-like',
      '.bpx-player-ending-related', '.bpx-player-ending-recommend', '.bpx-player-recommend'],
    liveHome: ['.player-area-ctnr', '.highlight-areas-ctnr', '.banner-area',
      '.banner-ctnr', '.hab-ctnr', '.rank-ctnr', '.recommend-area-ctnr', '.partner-banner', '.news-ctnr',
      '.live-sidebar-ctnr .sidebar-btn[title="排行榜"]'],
    liveRoom: ['.room-recommend', '.recommend-ctnr', '.room-ad', '.activity-banner',
      '.partner-banner', '.activity-gather-entry', '[data-module="pc-slider"]',
      '.live-player-handle-bar .panel-item:not(.active)', '.live-player-handle-bar .expand-btn']
  };
  const AD_MODULES = '.bili-dyn-card-goods,.bili-dyn-card-live-reserve__ad,.bili-video-card.is-ad,.video-item.ad,.search-ad,.ad-floor-exp';
  const CARD = '.bili-video-card,.video-item,.bili-dyn-list__item,.bili-dyn-item,.video-card';
  const BADGE = '.bili-video-card__info--ad,.bili-video-card__info--creative-ad,.ad-tag,.ad-label,.bili-dyn-card-ad';
  let settings = readSettings();
  let hidden = new Set();
  let frame = 0;
  let lastURL = '';
  let page = '';
  let ui;
  let dialog;
  let status;
  let lastFocus;
  let sessionOnly = false;
  let suspended = false;
  let observer;
  let layoutObserver;
  const observedLayout = new Set();
  const attempts = new WeakMap();

  function normalize(value) {
    const source = value && typeof value === 'object' ? value.nav : null;
    return { version: 1, nav: Object.fromEntries(ITEMS.map(([id, , fallback]) =>
      [id, source && typeof source[id] === 'boolean' ? source[id] : fallback])) };
  }

  function readSettings() {
    try { return normalize(typeof GM_getValue === 'function' ? GM_getValue(KEY, null) : null); }
    catch (_) { return normalize(null); }
  }

  function route(url = new URL(location.href)) {
    const host = url.hostname;
    if (host === 't.bilibili.com') return 'dynamic';
    if (host === 'search.bilibili.com') return 'search';
    if (host === 'space.bilibili.com') return /\/favlist(?:\/|$)/.test(url.pathname) ? 'library' : 'space';
    if (host === 'live.bilibili.com') return /^\/$/.test(url.pathname) ? 'liveHome' : 'liveRoom';
    if (host === 'www.bilibili.com' || host === 'bilibili.com') {
      if (url.pathname === '/') return 'home';
      if (/^\/(history|watchlater|list|medialist)(\/|$)/.test(url.pathname)) return 'library';
      if (/^\/video\//.test(url.pathname)) return 'video';
      return 'other';
    }
    return 'unmanaged';
  }

  function updateRoute() {
    const next = route();
    if (location.href !== lastURL) {
      lastURL = location.href;
      page = next;
      if (next === 'home') location.replace(FOLLOW);
    }
    if (document.documentElement?.getAttribute('data-pure-bilibili-page') !== page) {
      document.documentElement?.setAttribute('data-pure-bilibili-page', page);
    }
  }

  function query(selector, root = document) { return [...root.querySelectorAll(selector)]; }
  function own(element) { return element?.id === UI_ID || !!element?.closest?.(`#${UI_ID},#pure-bilibili-style`); }
  function label(element) { return (element.getAttribute('aria-label') || element.textContent || '').trim(); }
  function urlOf(element) {
    try { return new URL(element.getAttribute('href'), location.href); } catch (_) { return null; }
  }
  function isHomeURL(url) {
    return url && ['www.bilibili.com', 'bilibili.com'].includes(url.hostname) && url.pathname === '/';
  }

  function injectStyle() {
    if (!document.documentElement || document.getElementById('pure-bilibili-style')) return;
    const style = document.createElement('style');
    style.id = 'pure-bilibili-style';
    // Known structural selectors also hide asynchronous insertions before reconciliation.
    style.textContent = `.${HIDDEN}{display:none!important}
      ${Object.entries(MODULES).flatMap(([name, selectors]) => selectors.map(selector =>
        `html[data-pure-bilibili-page="${name}"] ${selector}`)).join(',\n')}{display:none!important}
      html:not([data-pure-bilibili-page="unmanaged"]) :is(${AD_MODULES}){display:none!important}
      .pure-bilibili-empty-side{display:none!important}
      .pure-bilibili-wide-feed{width:fit-content!important;max-width:calc(100% - 32px);margin-left:auto!important;margin-right:auto!important}
      .pure-bilibili-search-header{min-width:0!important}
      .pure-bilibili-search-header .left-entry{margin-right:0!important}
      .pure-bilibili-search-header .right-entry{flex-shrink:0!important}
      .pure-bilibili-search-container{flex:1 1 0%!important;min-width:0!important;margin-left:16px!important;margin-right:16px!important}
      .pure-bilibili-search-bar{box-sizing:border-box!important;width:var(--pure-bilibili-search-width,360px)!important;min-width:0!important;max-width:none!important;margin-left:auto!important;margin-right:auto!important;transform:translateX(var(--pure-bilibili-search-offset,0px))!important}
      html[data-pure-bilibili-page="video"] .pure-bilibili-danmaku-overflow{overflow:visible!important}
      html[data-pure-bilibili-page="video"] .video-pod-above-modules.pure-bilibili-danmaku-overflow{position:relative;z-index:3}
      html[data-pure-bilibili-page="video"] .pure-bilibili-danmaku-overflow .danmaku-box{z-index:3}
      html[data-pure-bilibili-page="home"] .bili-feed4{visibility:hidden!important}`;
    document.documentElement.append(style);
  }

  function navKey(anchor) {
    const url = urlOf(anchor);
    if (!url) return null;
    const host = url.hostname;
    const path = url.pathname;
    if (isHomeURL(url) || (url.href === FOLLOW && anchor.dataset.pureBilibiliHome === 'true')) return 'home';
    if (host === 't.bilibili.com') return 'dynamic';
    if (host === 'message.bilibili.com') return 'messages';
    if (host === 'space.bilibili.com' && /\/favlist/.test(path)) return 'favorites';
    if (['www.bilibili.com', 'bilibili.com'].includes(host)) {
      if (/^\/history/.test(path)) return 'history';
      if (/^\/anime/.test(path)) return 'anime';
      if (/^\/(match|v\/game\/match)/.test(path)) return 'matches';
    }
    if (host === 'member.bilibili.com') return /upload/.test(path) ? 'upload' : 'creator';
    if (host === 'live.bilibili.com') {
      if (url.searchParams.get('parentAreaId') === '13' || path === '/lol') return 'matches';
      return /area/.test(path) ? 'liveAreas' : 'live';
    }
    if (host === 'game.bilibili.com') return 'games';
    if (host === 'show.bilibili.com') return 'shop';
    if (host === 'manga.bilibili.com') return 'manga';
    if (host === 'app.bilibili.com') return 'download';
    if (host === 'account.bilibili.com' && path.startsWith('/big')) return 'vip';
    return null;
  }

  function cleanNavigation(desired) {
    query(HEADER).forEach(header => {
      // Limit to actual top-level entries, not personal-menu links or preview cards.
      query(ENTRY, header).forEach(entry => {
        if (entry.parentElement?.closest(ENTRY) || entry.matches('.header-avatar-wrap')) return;
        const outerAnchor = entry.closest('a[href]');
        const anchor = outerAnchor || entry.querySelector('a[href]');
        let key = anchor ? navKey(anchor) : null;
        if (!key) {
          const names = { '购买电池': 'liveWallet', '充值': 'liveWallet', '我要开播': 'broadcast', '更多': 'liveAreas', '下载客户端': 'download' };
          key = names[label(entry)];
        }
        if (key && !settings.nav[key]) desired.add(outerAnchor || entry);
      });
      // The ordinary live-room header uses icon-marked list items, not nav-item.
      if (header.matches('.link-navbar')) {
        for (const [selector, key] of [
          ['.item-icon-recharge', 'liveWallet'],
          ['.item-icon-electronDownload', 'download'],
          ['.startlive-btn', 'broadcast']
        ]) {
          query(selector, header).forEach(marker => {
            const entry = marker.closest('.list-item');
            if (entry && !settings.nav[key]) desired.add(entry);
          });
        }
        if (!settings.nav.liveAreas) query('.more-tab-animation', header).forEach(el => desired.add(el));
      }
      // Some versions expose logo anchors outside entry wrappers.
      query('a[href]', header).forEach(anchor => {
        const url = urlOf(anchor);
        if (!isHomeURL(url) && !(anchor.matches('.nav-logo,.entry_logo') && url?.hostname === 'live.bilibili.com' && url.pathname === '/')) return;
        if (!anchor.closest(ENTRY) && !anchor.matches('.nav-logo,.logo,.logo-img,.bili-header__logo,.entry_logo,.entry-title')) return;
        if (anchor.closest('.v-popover,.area-list-panel')) return;
        anchor.dataset.pureBilibiliHome = 'true';
        anchor.setAttribute('href', FOLLOW);
      });
      query('a[data-pure-bilibili-home="true"]', header).forEach(anchor => {
        if (!settings.nav.home) desired.add(anchor.closest(ENTRY) || anchor);
      });
      query('.nav-search-input,input[placeholder]', header).forEach(input => {
        if (!input.matches('input') || !input.closest('.nav-search-content,#nav-searchform,.nav-searchform,.nav-search,.search-input')) return;
        if (input.placeholder !== '搜索') input.placeholder = '搜索';
        if (input.hasAttribute('title') && input.title !== '搜索') input.title = '搜索';
      });
    });
    // Home-entry popovers are discovery surfaces regardless of the entry preference.
    query('.home-page-panel,.channel-panel', document).forEach(el => {
      if (el.closest(HEADER) && !el.closest(PROSE)) desired.add(el);
    });
  }

  function cleanSearch(desired) {
    query('.search-panel,.nav-search-panel,.search-suggest').forEach(panel => {
      query('.trending,.trending-wrap,.trending-container,.hot-search,.search-discovery', panel).forEach(el => desired.add(el));
      // Scoped heading fallback: only a separate section with a known hot-list sibling.
      query('.title,.header', panel).forEach(title => {
        if (!/^(bilibili热搜|热搜|搜索发现|热门搜索)$/.test(label(title))) return;
        const header = title.closest('.header') || title;
        const group = header.parentElement;
        if (group !== panel && group?.querySelector('.trending-list,.trendings,.hot-search-list')) desired.add(group);
        else desired.add(header);
      });
    });
  }

  function layoutSearch() {
    const targets = new Set();
    query(HEADER).forEach(header => {
      query('.center-search-container', header).forEach(container => {
        const bar = container.querySelector('.center-search__bar');
        const menu = container.parentElement;
        const left = menu?.querySelector(':scope > .left-entry');
        const right = menu?.querySelector(':scope > .right-entry');
        if (!bar || !left || !right) return;
        menu.classList.add('pure-bilibili-search-header');
        container.classList.add('pure-bilibili-search-container');
        bar.classList.add('pure-bilibili-search-bar');
        [container, left, right].forEach(el => targets.add(el));
        const viewport = document.documentElement.clientWidth || window.innerWidth;
        const leftEdge = Math.max(16, left.getBoundingClientRect().right + 16);
        const rightEdge = Math.min(viewport - 16, right.getBoundingClientRect().left - 16);
        const centeredWidth = 2 * Math.min(viewport / 2 - leftEdge, rightEdge - viewport / 2);
        // Below a usable centered width, place the search in the actual navigation gap.
        const centered = centeredWidth >= 180;
        const width = Math.max(0, Math.floor(Math.min(360, centered ? centeredWidth : rightEdge - leftEdge)));
        const center = centered ? viewport / 2 : (leftEdge + rightEdge) / 2;
        const set = (name, value) => {
          if (bar.style.getPropertyValue(name) !== value) bar.style.setProperty(name, value);
        };
        set('--pure-bilibili-search-width', `${width}px`);
        const rect = bar.getBoundingClientRect();
        if (!rect.width) return; // Hidden headers are measured when they become visible.
        const previous = parseFloat(bar.style.getPropertyValue('--pure-bilibili-search-offset')) || 0;
        const offset = Math.round((previous + center - (rect.left + rect.width / 2)) * 100) / 100;
        set('--pure-bilibili-search-offset', `${offset}px`);
      });
    });
    if (typeof window.ResizeObserver !== 'function') return;
    if (!layoutObserver) layoutObserver = new window.ResizeObserver(schedule);
    observedLayout.forEach(el => {
      if (!targets.has(el)) { layoutObserver.unobserve(el); observedLayout.delete(el); }
    });
    targets.forEach(el => {
      if (!observedLayout.has(el)) { layoutObserver.observe(el); observedLayout.add(el); }
    });
  }

  function commerceURL(url) {
    return url && (['cm.bilibili.com', 'mall.bilibili.com', 'show.bilibili.com', 'biligame.com', 'www.biligame.com'].includes(url.hostname) ||
      (['www.bilibili.com', 'bilibili.com'].includes(url.hostname) && url.pathname.startsWith('/h5/mall/')));
  }

  function cleanAds(desired) {
    query(AD_MODULES).forEach(el => { if (!el.closest(PROSE)) desired.add(el); });
    query(BADGE).forEach(badge => {
      if (badge.closest(PROSE)) return;
      if (!/^(广告|推广|商业推广)$/.test(label(badge)) && !badge.matches('.bili-dyn-card-ad')) return;
      const card = badge.closest(CARD);
      if (card) desired.add(card);
    });
    // Hide ornaments or explicit commerce modules, never the entire enclosing post.
    query('.bili-dyn-item__ornament,.bili-dyn-card-additional,.game-card,.game-entry,.ad-report').forEach(module => {
      if (module.closest(PROSE)) return;
      if (query('a[href]', module).some(a => commerceURL(urlOf(a)))) desired.add(module);
    });
    // Direct ad click URLs count only inside known cards and outside authored text.
    query('a[href*="cm.bilibili.com/"]').forEach(anchor => {
      const url = urlOf(anchor);
      if (url?.hostname !== 'cm.bilibili.com' || !url.pathname.startsWith('/cm/') || anchor.closest(PROSE)) return;
      const card = anchor.closest(CARD);
      if (card) desired.add(card);
    });
  }

  function cleanPageModules(desired) {
    if (page === 'liveHome') {
      query('.area-detail-ctnr').forEach(el => {
        if (!el.querySelector('.follow-cntr,.my-follow,.focus-area-ctnr') && !el.matches('.follow-cntr')) desired.add(el);
      });
    }
    // Restrict text fallback to module headings and small, recognized wrappers.
    if (['library', 'space', 'liveRoom'].includes(page)) {
      query('.recommend-header,.recommend-title,.section-title,.module-title').forEach(title => {
        if (!/^(猜你喜欢|为你推荐|相关推荐|推荐关注|推荐直播|大家都在看)$/.test(label(title)) || title.closest(PROSE)) return;
        const module = title.closest('.recommend,.recommend-box,.section-block,.module,.panel');
        if (module && !module.querySelector('video,.multi-page,.video-sections-content-list,.follow-cntr')) desired.add(module);
      });
    }
  }

  function cleanPlayer(desired) {
    query('.video-pod-above-modules,.video-pod-above-modules__inner').forEach(container => {
      container.classList.toggle('pure-bilibili-danmaku-overflow', page === 'video' && !!container.querySelector('.danmaku-box'));
    });
    if (page === 'liveHome') {
      query('.player-area-ctnr video').forEach(video => { if (!video.paused) video.pause(); });
    }
    if (!['video', 'library'].includes(page)) return;
    // NOT .bpx-player-ctrl-setting-autoplay: that is initial playback, not recommendations.
    query('.recommend-list-v1 .next-play .switch-btn.on,.recommend-list .next-play .switch-btn.on').forEach(toggle => {
      const now = Date.now();
      const previous = attempts.get(toggle);
      if (previous && (previous.count >= 3 || now - previous.time < 1000)) return;
      attempts.set(toggle, { time: now, count: (previous?.count || 0) + 1 });
      toggle.click();
      // Vue may mount the control before attaching its handler. Retry only this
      // recommendation switch, with a finite bound, without touching player settings.
      if (toggle.classList.contains('on')) window.setTimeout(schedule, 1100);
    });
    query('.bpx-player-ending-panel').forEach(panel => {
      query('a[href*="/video/"]', panel).forEach(anchor => {
        // End-card recommendation links carry a recommendation attribution; share/replay stay.
        const url = urlOf(anchor);
        if (url && /recommend|related/.test(url.search)) desired.add(anchor.closest('.bpx-player-ending-related-item') || anchor);
      });
    });
  }

  function reconcile(desired) {
    hidden.forEach(el => { if (!desired.has(el)) el.classList.remove(HIDDEN); });
    desired.forEach(el => { if (!el.classList.contains(HIDDEN)) el.classList.add(HIDDEN); });
    hidden = desired;
    query('.bili-dyn-home--member').forEach(layout => {
      const right = layout.querySelector('aside.right');
      if (!right) return;
      const children = [...right.children];
      const empty = page === 'dynamic' && children.length > 0 && children.every(section =>
        !section.textContent.trim() || !!section.querySelector('.bili-dyn-banner,.bili-dyn-search-trendings') &&
        [...section.children].every(el => el.matches('.bili-dyn-banner,.bili-dyn-search-trendings') || hidden.has(el)));
      right.classList.toggle('pure-bilibili-empty-side', empty);
      layout.classList.toggle('pure-bilibili-wide-feed', empty);
    });
  }

  function apply() {
    frame = 0;
    updateRoute();
    injectStyle();
    if (!document.body || page === 'unmanaged') return;
    const desired = new Set();
    cleanNavigation(desired);
    cleanSearch(desired);
    cleanAds(desired);
    cleanPageModules(desired);
    cleanPlayer(desired);
    reconcile(desired);
    // Measure after navigation hiding/restoration has affected the flex layout.
    layoutSearch();
  }
  function schedule() {
    if (!suspended && !frame) frame = requestAnimationFrame(apply);
  }

  function ensureUI() {
    if (!ui) {
      ui = document.createElement('span');
      ui.id = UI_ID;
      const shadow = ui.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host{font:14px/1.6 system-ui,sans-serif;color:#1d2838}
        *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #d6dfe8;border-radius:8px;padding:7px 14px;background:#fff;color:#24354b}
        button:hover{background:#eef5fb}button:focus-visible,input:focus-visible{outline:3px solid #78b9f6;outline-offset:3px}
        dialog{color:#24354b;background:#fff;width:min(540px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #dae3ec;border-radius:16px;padding:26px;box-shadow:0 20px 80px #12284235;font:14px/1.6 system-ui,sans-serif}
        dialog::backdrop{background:#15233766}h2{font-size:22px;line-height:1.3;margin:0 0 8px}p{margin:0 0 18px;color:#617084}
        fieldset{border:0;margin:0;padding:0}legend{font-weight:600;margin-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}
        label{display:flex;gap:9px;align-items:center;padding:7px 8px;background:#f6f8fa;border-radius:7px}input{accent-color:#2479b5;width:16px;height:16px}
        .note{font-size:12px;margin-top:16px}.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.save{margin-left:auto;background:#226e9f;color:white;border-color:#226e9f}.save:hover{background:#18587f}
        .status{min-height:22px;margin:12px 0 0;color:#276646}.status.error{color:#a13720}@media(max-width:420px){dialog{padding:18px}.grid{gap:6px}}
      </style><dialog aria-labelledby="pb-title"><h2 id="pb-title">Pure Bilibili</h2><p>让关注成为首页，让浏览由你决定。</p>
      <form><fieldset><legend>保留的顶栏入口</legend><div class="grid"></div></fieldset>
      <p class="note">搜索和个人菜单始终保留。设置通过油猴菜单打开。首页／Logo 通往关注动态。显示入口不会恢复页面推荐。</p>
      <div class="actions"><button type="button" class="reset">恢复默认</button><button type="button" class="cancel">取消</button><button type="submit" class="save">保存</button></div>
      <p class="status" role="status" aria-live="polite"></p></form></dialog>`;
      dialog = shadow.querySelector('dialog');
      status = shadow.querySelector('.status');
      const grid = shadow.querySelector('.grid');
      ITEMS.forEach(([id, text]) => {
        const row = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox'; input.name = id;
        row.append(input, document.createTextNode(text)); grid.append(row);
      });
      shadow.querySelector('.cancel').addEventListener('click', closeSettings);
      shadow.querySelector('.reset').addEventListener('click', () => {
        fillForm({ nav: DEFAULTS });
        setStatus('已填入默认选项，点击保存后生效。');
      });
      shadow.querySelector('form').addEventListener('submit', saveSettings);
      let pressedBackdrop = false;
      const outside = event => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom);
      };
      dialog.addEventListener('pointerdown', event => { pressedBackdrop = outside(event); });
      dialog.addEventListener('click', event => {
        if (pressedBackdrop && outside(event)) closeSettings();
        pressedBackdrop = false;
      });
      dialog.addEventListener('close', () => lastFocus?.focus?.());
    }
    if (ui.parentElement !== document.body) document.body.append(ui);
  }

  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function fillForm(value) { query('input[type="checkbox"]', ui.shadowRoot).forEach(input => { input.checked = value.nav[input.name]; }); }
  function openSettings() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', openSettings, { once: true }); return; }
    ensureUI();
    lastFocus = ui.shadowRoot.activeElement || document.activeElement;
    fillForm(settings);
    setStatus(sessionOnly ? '设置仅在当前页面生效，尚未保存。' : '');
    if (!dialog.open) dialog.showModal();
  }
  function closeSettings() { dialog.close(); }
  async function saveSettings(event) {
    event.preventDefault();
    const nav = Object.fromEntries(query('input[type="checkbox"]', ui.shadowRoot).map(input => [input.name, input.checked]));
    settings = normalize({ nav });
    sessionOnly = true;
    schedule();
    try {
      if (typeof GM_setValue !== 'function') throw new Error('Storage unavailable');
      await GM_setValue(KEY, settings);
      sessionOnly = false;
      setStatus('已保存，已同步到其他打开的 B 站页面。');
    } catch (_) {
      setStatus('保存失败：仅在当前页面生效；刷新后可能丢失。', true);
    }
  }

  function onRemoteChange(_key, _old, value, remote) {
    if (!remote) return;
    settings = normalize(value);
    sessionOnly = false;
    if (dialog?.open) {
      // Keep unsaved draft intact, explicitly explain the pending overwrite.
      setStatus('另一页面已更新设置。关闭后重开可载入；保存会使用本面板的选项。');
    }
    schedule();
  }

  function relevant(record) {
    const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (!el || own(el) || el.closest(NOISY)) return false;
    if (record.type === 'attributes' && record.attributeName === 'class') {
      const strip = value => String(value || '').split(/\s+/).filter(x => x && !x.startsWith('pure-bilibili-')).sort().join(' ');
      const removed = hidden.has(el) && !el.classList.contains(HIDDEN);
      return removed || strip(record.oldValue) !== strip(el.getAttribute('class'));
    }
    if (record.type === 'childList') {
      return [...record.addedNodes, ...record.removedNodes].some(node => {
        const child = node.nodeType === 1 ? node : node.parentElement;
        return child && !own(child) && !child.matches?.(NOISY);
      });
    }
    return true;
  }

  function start() {
    updateRoute(); injectStyle(); schedule();
    observer?.disconnect();
    observer = new MutationObserver(records => { if (!suspended && records.some(relevant)) schedule(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeOldValue: true, attributeFilter: ['class', 'href', 'placeholder', 'title', 'aria-label'], characterData: true });
  }
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Pure Bilibili：设置', openSettings);
      GM_registerMenuCommand('Pure Bilibili：重新应用规则', schedule);
    }
    if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener(KEY, onRemoteChange);
  } catch (error) { console.warn('[Pure Bilibili] 油猴菜单或设置监听注册失败', error); }
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pagehide', () => {
    suspended = true;
    observer?.disconnect();
    layoutObserver?.disconnect();
    observedLayout.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });
  window.addEventListener('pageshow', () => {
    if (suspended) { suspended = false; start(); }
    else schedule();
  });
  // Hiding the live homepage's featured player must not leave it playing audio.
  document.addEventListener('play', event => {
    if (page === 'liveHome' && event.target.matches?.('.player-area-ctnr video')) event.target.pause();
  }, true);
  window.addEventListener('focus', () => {
    if (!sessionOnly) { settings = readSettings(); schedule(); }
  });
  // URL comparison works across isolated userscript worlds without patching the site's history.
  window.setInterval(() => { if (!suspended && location.href !== lastURL) schedule(); }, 1000);
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
