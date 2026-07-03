// ============================================================
// CLRA Mirror - 完整多页面导航与代理服务
// 功能：域名列表（搜索+点击跳转）、提交审核、管理员面板、友链
// 安全：密码通过环境变量 ADMIN_API_KEY 注入
// 友链：通过环境变量 FRIEND_LINKS (JSON数组) 配置
// ============================================================

const CONFIG = {
  // 远程域名列表（原版）
  LIST_URLS: [
    'https://jfdoc.xingying.us.kg/clra_urls.txt',
    'https://clra1.lzh173.chat/clra_urls.txt',
  ],
  // 硬编码域名（原版）
  HARDCODED_DOMAINS: ['jpt.lzh173.chat', 'scltk.lzh173.chat'],
  // 性能与安全
  RATE_LIMIT_PER_MIN: 100,
  DOMAIN_CACHE_TTL: 60,
  MAX_URL_LENGTH: 15000,
};

let domainCache = null;
let cacheTimestamp = 0;
const rateMap = new Map();

// ---------- 工具函数 ----------
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  let record = rateMap.get(ip);
  if (!record || now - record.resetTime > windowMs) {
    rateMap.set(ip, { count: 1, resetTime: now + windowMs });
    return false;
  }
  record.count++;
  if (record.count > CONFIG.RATE_LIMIT_PER_MIN) return true;
  if (rateMap.size > 2000) {
    for (const [key, val] of rateMap.entries()) {
      if (now - val.resetTime > windowMs) rateMap.delete(key);
    }
  }
  return false;
}

function isDomainAllowed(domain, allowedList) {
  if (!Array.isArray(allowedList) || allowedList.length === 0) return false;
  return allowedList.some(pattern => {
    if (pattern === domain) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return domain === suffix || domain.endsWith('.' + suffix);
    }
    return false;
  });
}

function rewriteUrl(originalUrl, domain) {
  if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
  if (/^(data|blob|javascript|mailto|tel|ws|wss):/i.test(originalUrl)) return originalUrl;
  if (originalUrl.startsWith('/proxy/')) return originalUrl;
  try {
    let urlObj;
    if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
      urlObj = new URL(originalUrl);
      if (urlObj.hostname !== domain) return originalUrl;
    } else {
      urlObj = new URL(originalUrl, `https://${domain}/`);
    }
    const path = urlObj.pathname;
    const search = urlObj.search || '';
    const proxyPath = `/proxy/${encodeURIComponent(domain)}${path}${search}`;
    if (proxyPath.length > CONFIG.MAX_URL_LENGTH) return urlObj.href;
    return proxyPath;
  } catch (_) {
    return originalUrl;
  }
}

// ---------- 获取完整域名列表（含友链） ----------
async function getDomainList(env) {
  const now = Date.now();
  if (domainCache && (now - cacheTimestamp) < CONFIG.DOMAIN_CACHE_TTL * 1000) {
    return domainCache;
  }

  const domainSet = new Set();
  CONFIG.HARDCODED_DOMAINS.forEach(d => domainSet.add(d));

  const fetchTasks = CONFIG.LIST_URLS.map(async (url) => {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'CLRA-Mirror' } });
      if (!resp.ok) return [];
      const text = await resp.text();
      return text.split(/[\s\n]+/).filter(s => s && s.length > 0);
    } catch { return []; }
  });
  const results = await Promise.allSettled(fetchTasks);
  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      r.value.forEach(d => domainSet.add(d));
    }
  });

  // 从 KV 读取已审核域名
  if (env && env.DOMAINS_KV) {
    try {
      const approved = await env.DOMAINS_KV.get('approved_list', 'json');
      if (Array.isArray(approved)) approved.forEach(d => domainSet.add(d));
    } catch (_) {}
  }

  // 从环境变量读取友链域名，也加入白名单
  if (env && env.FRIEND_LINKS) {
    try {
      const friends = JSON.parse(env.FRIEND_LINKS);
      if (Array.isArray(friends)) {
        friends.forEach(f => {
          if (f.url) {
            // 提取域名（去掉协议和路径）
            let domain = f.url.replace(/^https?:\/\//, '').split('/')[0];
            if (domain) domainSet.add(domain);
          }
        });
      }
    } catch (_) {}
  }

  domainCache = Array.from(domainSet);
  cacheTimestamp = now;
  return domainCache;
}

// ---------- 代理处理 ----------
async function handleProxy(request, env) {
  const url = new URL(request.url);
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(clientIP)) {
    return new Response('请求过于频繁，请稍后再试', { status: 429 });
  }

  const pathMatch = url.pathname.match(/^\/proxy\/([^\/]+)(\/.*)?$/);
  if (!pathMatch) return new Response('无效的代理路径', { status: 400 });
  const domain = decodeURIComponent(pathMatch[1]);
  const targetPath = pathMatch[2] || '/';
  const targetSearch = url.search || '';

  const allowedDomains = await getDomainList(env);
  if (!isDomainAllowed(domain, allowedDomains)) {
    return new Response('该域名不在允许列表中', { status: 403 });
  }

  let targetUrl;
  try {
    targetUrl = new URL(`https://${domain}${targetPath}${targetSearch}`);
  } catch (_) {
    return new Response('目标 URL 格式错误', { status: 400 });
  }
  if (targetUrl.href.length > CONFIG.MAX_URL_LENGTH) {
    return new Response(
      `目标链接过长，请直接访问：<a href="${targetUrl.href}">${targetUrl.href}</a>`,
      { status: 414, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const reqHeaders = new Headers(request.headers);
  ['cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']
    .forEach(h => reqHeaders.delete(h));
  reqHeaders.set('X-Forwarded-Host', domain);
  reqHeaders.set('User-Agent', 'CLRA-Mirror-Proxy/2.0');

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: reqHeaders,
      body: request.body,
      redirect: 'manual',
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Location', rewriteUrl(location, domain));
        return new Response(null, { status: response.status, headers: newHeaders });
      }
    }

    const contentType = response.headers.get('content-type') || '';
    const respHeaders = new Headers(response.headers);
    respHeaders.delete('content-security-policy');
    respHeaders.delete('content-security-policy-report-only');

    if (contentType.includes('text/html')) {
      const rewriter = new HTMLRewriter()
        .on('a', { element(el) { const v = el.getAttribute('href'); if (v) el.setAttribute('href', rewriteUrl(v, domain)); } })
        .on('img', { element(el) { const v = el.getAttribute('src'); if (v) el.setAttribute('src', rewriteUrl(v, domain)); } })
        .on('script', { element(el) { const v = el.getAttribute('src'); if (v) el.setAttribute('src', rewriteUrl(v, domain)); } })
        .on('link', { element(el) {
          const rel = el.getAttribute('rel');
          if (['stylesheet', 'preload', 'preconnect', 'dns-prefetch'].includes(rel)) {
            const v = el.getAttribute('href');
            if (v) el.setAttribute('href', rewriteUrl(v, domain));
          }
        }})
        .on('form', { element(el) { const v = el.getAttribute('action'); if (v) el.setAttribute('action', rewriteUrl(v, domain)); } })
        .on('meta', { element(el) {
          if (el.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
            const content = el.getAttribute('content');
            if (content) {
              const match = content.match(/url=(.+)/i);
              if (match) {
                el.setAttribute('content', content.replace(/url=.+/i, `url=${rewriteUrl(match[1], domain)}`));
              }
            }
          }
        }})
        .on('style', { text(text) {
          const rewritten = text.text.replace(
            /url\((['"]?)([^'")]+)(['"]?)\)/g,
            (_, q1, urlPart, q2) => `url(${q1}${rewriteUrl(urlPart.trim(), domain)}${q2})`
          );
          text.replace(rewritten);
        }});
      return rewriter.transform(
        new Response(response.body, { status: response.status, headers: respHeaders })
      );
    }

    if (contentType.includes('text/css')) {
      const cssText = await response.text();
      const rewritten = cssText.replace(
        /url\((['"]?)([^'")]+)(['"]?)\)/g,
        (_, q1, urlPart, q2) => `url(${q1}${rewriteUrl(urlPart.trim(), domain)}${q2})`
      );
      return new Response(rewritten, { status: response.status, headers: respHeaders });
    }

    return new Response(response.body, { status: response.status, headers: respHeaders });
  } catch (error) {
    console.error('[代理错误]', error.message);
    return new Response(`代理服务异常：${error.message}`, { status: 502 });
  }
}

// ---------- API 处理 ----------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  if (method === 'GET' && path === '/api/health') {
    return jsonResponse({ status: 'ok', timestamp: Date.now() });
  }

  if (method === 'POST' && path === '/api/domains') {
    try {
      const { domain } = await request.json();
      if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) {
        return jsonResponse({ error: '域名格式无效' }, 400);
      }
      const pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      const approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
      if (pending.some(item => item.domain === domain) || approved.includes(domain)) {
        return jsonResponse({ error: '该域名已提交或已通过审核' }, 409);
      }
      const submitter = request.headers.get('CF-Connecting-IP') || 'unknown';
      pending.push({
        id: crypto.randomUUID(),
        domain,
        submitter,
        time: Date.now(),
      });
      await env.DOMAINS_KV.put('pending_list', JSON.stringify(pending));
      return jsonResponse({ success: true, message: '提交成功，等待管理员审核' }, 201);
    } catch (_) {
      return jsonResponse({ error: '请求体格式错误' }, 400);
    }
  }

  if (method === 'GET' && path === '/api/admin/pending') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) {
      return new Response('未授权访问', { status: 401 });
    }
    try {
      const pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      return jsonResponse(pending);
    } catch (_) {
      return jsonResponse({ error: '服务器读取失败' }, 500);
    }
  }

  if (method === 'POST' && path === '/api/admin/approve') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) {
      return new Response('未授权访问', { status: 401 });
    }
    try {
      const { domain, action } = await request.json();
      if (!domain || !['approve', 'reject'].includes(action)) {
        return jsonResponse({ error: '参数无效' }, 400);
      }
      let pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      const index = pending.findIndex(item => item.domain === domain);
      if (index === -1) {
        return jsonResponse({ error: '未找到该待审域名' }, 404);
      }
      pending.splice(index, 1);
      await env.DOMAINS_KV.put('pending_list', JSON.stringify(pending));
      if (action === 'approve') {
        let approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
        if (!approved.includes(domain)) {
          approved.push(domain);
          await env.DOMAINS_KV.put('approved_list', JSON.stringify(approved));
        }
      }
      return jsonResponse({ success: true });
    } catch (_) {
      return jsonResponse({ error: '请求处理异常' }, 400);
    }
  }

  // 获取友链数据（供前端使用）
  if (method === 'GET' && path === '/api/friends') {
    try {
      const friends = env.FRIEND_LINKS ? JSON.parse(env.FRIEND_LINKS) : [];
      return jsonResponse(friends);
    } catch (_) {
      return jsonResponse([]);
    }
  }

  return new Response('API 路径不存在', { status: 404 });
}

// ---------- 构建单页应用 HTML（包含所有页面） ----------
function buildAppHtml(domains, friendLinks) {
  // 生成域名列表项（可点击跳转代理）
  const domainItems = domains.map(d => `
    <a href="/proxy/${encodeURIComponent(d)}/" class="domain-link" target="_blank">
      ${escapeHtml(d)}
    </a>
  `).join('');

  // 生成友链列表
  const friendItems = (friendLinks || []).map(f => {
    const name = escapeHtml(f.name || f.url);
    const url = f.url;
    // 提取域名用于代理
    let domain = url.replace(/^https?:\/\//, '').split('/')[0];
    const proxyUrl = `/proxy/${encodeURIComponent(domain)}/`;
    return `
      <div class="friend-item">
        <a href="${proxyUrl}" target="_blank" class="friend-link">
          <span class="friend-name">${name}</span>
          <span class="friend-domain">${escapeHtml(domain)}</span>
        </a>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLRA 导航 · 镜像</title>
  <style>
    /* ---------- 全局变量（适配深色/浅色） ---------- */
    :root {
      --bg: #f0f4f8;
      --card-bg: rgba(255, 255, 255, 0.75);
      --text: #0f172a;
      --text-secondary: #475569;
      --border: rgba(255, 255, 255, 0.5);
      --shadow: 0 30px 60px -20px rgba(0,0,0,0.25);
      --nav-bg: rgba(255, 255, 255, 0.6);
      --link-color: #2563eb;
      --link-hover: #1d4ed8;
      --input-bg: rgba(255,255,255,0.9);
      --input-border: #e2e8f0;
      --tag-bg: rgba(37, 99, 235, 0.08);
      --tag-border: rgba(37, 99, 235, 0.15);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --card-bg: rgba(30, 41, 59, 0.8);
        --text: #f1f5f9;
        --text-secondary: #94a3b8;
        --border: rgba(255, 255, 255, 0.1);
        --shadow: 0 30px 60px -20px rgba(0,0,0,0.6);
        --nav-bg: rgba(15, 23, 42, 0.8);
        --link-color: #60a5fa;
        --link-hover: #93bbfc;
        --input-bg: rgba(30, 41, 59, 0.8);
        --input-border: #334155;
        --tag-bg: rgba(96, 165, 250, 0.12);
        --tag-border: rgba(96, 165, 250, 0.2);
      }
    }

    /* ---------- 全局样式 ---------- */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      transition: background 0.3s, color 0.3s;
      padding-top: 70px; /* 给固定导航留空间 */
    }

    /* ---------- 顶部导航 ---------- */
    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: var(--nav-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 2rem;
      height: 64px;
      gap: 1.5rem;
      flex-wrap: nowrap;
      overflow-x: auto;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }
    .navbar .brand {
      font-weight: 700;
      font-size: 1.25rem;
      color: var(--text);
      text-decoration: none;
      white-space: nowrap;
      margin-right: auto;
    }
    .navbar .brand span { color: var(--link-color); }
    .nav-link {
      color: var(--text-secondary);
      text-decoration: none;
      font-weight: 500;
      padding: 0.4rem 0.8rem;
      border-radius: 40px;
      transition: 0.2s;
      white-space: nowrap;
      cursor: pointer;
      background: transparent;
      border: none;
      font-size: 0.95rem;
    }
    .nav-link:hover { background: var(--tag-bg); color: var(--text); }
    .nav-link.active {
      background: var(--link-color);
      color: white;
    }
    .nav-link.active:hover { background: var(--link-hover); }

    /* ---------- 主容器 ---------- */
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 1.5rem 1.5rem 3rem;
    }

    /* ---------- 卡片 ---------- */
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 2rem;
      padding: 1.8rem;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      margin-bottom: 2rem;
    }
    .card-title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1.2rem;
    }

    /* ---------- 域名列表（可搜索） ---------- */
    .search-box {
      width: 100%;
      padding: 0.8rem 1.2rem;
      border-radius: 60px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      transition: 0.2s;
      margin-bottom: 1.5rem;
    }
    .search-box:focus {
      border-color: var(--link-color);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    }
    .domain-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      max-height: 400px;
      overflow-y: auto;
      padding: 0.2rem 0;
    }
    .domain-link {
      background: var(--tag-bg);
      border: 1px solid var(--tag-border);
      padding: 0.4rem 1rem;
      border-radius: 40px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.9rem;
      transition: 0.15s;
      display: inline-block;
    }
    .domain-link:hover {
      background: var(--link-color);
      color: white;
      transform: scale(1.03);
      border-color: var(--link-color);
    }

    /* ---------- 友链 ---------- */
    .friend-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
    }
    .friend-item {
      background: var(--tag-bg);
      border: 1px solid var(--tag-border);
      border-radius: 1.2rem;
      padding: 0.8rem 1.2rem;
      transition: 0.2s;
    }
    .friend-item:hover {
      background: var(--link-color);
      border-color: var(--link-color);
    }
    .friend-item:hover .friend-name,
    .friend-item:hover .friend-domain {
      color: white;
    }
    .friend-link {
      text-decoration: none;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .friend-name {
      font-weight: 600;
      color: var(--text);
      font-size: 1.1rem;
    }
    .friend-domain {
      font-size: 0.85rem;
      color: var(--text-secondary);
      opacity: 0.7;
    }

    /* ---------- 审核面板 ---------- */
    .admin-key-area {
      display: flex;
      gap: 0.8rem;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 1.2rem;
    }
    .admin-key-area input {
      flex: 1;
      min-width: 200px;
      padding: 0.7rem 1.2rem;
      border-radius: 60px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--text);
      outline: none;
    }
    .admin-key-area input:focus {
      border-color: var(--link-color);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    }
    .btn {
      padding: 0.7rem 1.8rem;
      border: none;
      border-radius: 60px;
      font-weight: 600;
      background: var(--link-color);
      color: white;
      cursor: pointer;
      transition: 0.15s;
      white-space: nowrap;
    }
    .btn:hover { background: var(--link-hover); transform: scale(1.02); }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--input-border);
      color: var(--text);
    }
    .btn-outline:hover { background: var(--tag-bg); }
    .btn-success { background: #16a34a; }
    .btn-success:hover { background: #15803d; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      padding: 0.7rem 0.5rem;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--input-border);
    }
    td {
      padding: 0.7rem 0.5rem;
      border-bottom: 1px solid var(--input-border);
    }
    .action-btns {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .action-btns .btn { padding: 0.3rem 0.9rem; font-size: 0.8rem; }

    /* ---------- 消息提示 ---------- */
    .msg {
      padding: 0.5rem 1rem;
      border-radius: 60px;
      margin-top: 0.8rem;
      display: none;
    }
    .msg-success { background: #dcfce7; color: #166534; }
    .msg-error { background: #fee2e2; color: #991b1b; }

    /* ---------- 页面切换 ---------- */
    .page {
      display: none;
      animation: fadeIn 0.3s ease;
    }
    .page.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    /* ---------- 响应式 ---------- */
    @media (max-width: 640px) {
      .navbar { padding: 0 1rem; gap: 0.8rem; }
      .navbar .brand { font-size: 1rem; }
      .nav-link { font-size: 0.85rem; padding: 0.3rem 0.6rem; }
      .container { padding: 1rem; }
      .card { padding: 1.2rem; }
      .friend-grid { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>

<!-- 顶部导航 -->
<nav class="navbar">
  <a href="#" class="brand">🌐 <span>CLRA</span></a>
  <button class="nav-link active" data-page="home">首页</button>
  <button class="nav-link" data-page="submit">提交</button>
  <button class="nav-link" data-page="admin">审核</button>
  <button class="nav-link" data-page="friends">友链</button>
</nav>

<div class="container">

  <!-- ========== 首页：域名列表 ========== -->
  <div id="page-home" class="page active">
    <div class="card">
      <div class="card-title">📋 可用域名</div>
      <input type="text" id="searchInput" class="search-box" placeholder="搜索域名..." oninput="filterDomains()">
      <div id="domainList" class="domain-grid">
        ${domainItems}
      </div>
      <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:1rem;">
        共 ${domains.length} 个 · 点击即可通过代理访问
      </div>
    </div>
  </div>

  <!-- ========== 提交页面 ========== -->
  <div id="page-submit" class="page">
    <div class="card">
      <div class="card-title">✏️ 提交新域名</div>
      <div style="display:flex; gap:0.8rem; flex-wrap:wrap;">
        <input type="text" id="submitDomainInput" class="search-box" style="flex:1; min-width:200px;" placeholder="example.com">
        <button class="btn" id="submitBtn">提交审核</button>
      </div>
      <div id="submitMsg" class="msg"></div>
    </div>
  </div>

  <!-- ========== 审核页面 ========== -->
  <div id="page-admin" class="page">
    <div class="card">
      <div class="card-title">🔐 管理员审核</div>
      <div class="admin-key-area">
        <input type="password" id="adminKeyInput" placeholder="管理密钥">
        <button class="btn" id="adminLoginBtn">加载待审</button>
      </div>
      <div id="adminPendingList" style="color:var(--text-secondary);">输入密钥后点击加载</div>
    </div>
  </div>

  <!-- ========== 友链页面 ========== -->
  <div id="page-friends" class="page">
    <div class="card">
      <div class="card-title">🔗 友情链接</div>
      <div class="friend-grid">
        ${friendItems}
      </div>
      <div style="margin-top:1rem; font-size:0.9rem; color:var(--text-secondary);">
        点击友链名称将通过代理访问
      </div>
    </div>
  </div>

</div>

<script>
  // ---------- 导航切换 ----------
  document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const page = this.dataset.page;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');
    });
  });

  // ---------- 搜索过滤 ----------
  function filterDomains() {
    const q = document.getElementById('searchInput').value.toLowerCase().trim();
    const links = document.querySelectorAll('#domainList .domain-link');
    links.forEach(link => {
      const text = link.textContent.toLowerCase();
      link.style.display = text.includes(q) ? 'inline-block' : 'none';
    });
  }
  window.filterDomains = filterDomains;

  // ---------- 提交域名 ----------
  document.getElementById('submitBtn').addEventListener('click', async function() {
    const input = document.getElementById('submitDomainInput');
    const domain = input.value.trim();
    const msg = document.getElementById('submitMsg');
    if (!domain) { showMsg(msg, '请输入域名', 'error'); return; }
    try {
      const resp = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain })
      });
      const data = await resp.json();
      if (resp.ok) {
        showMsg(msg, '✅ ' + data.message, 'success');
        input.value = '';
      } else {
        showMsg(msg, '❌ ' + (data.error || '提交失败'), 'error');
      }
    } catch {
      showMsg(msg, '❌ 网络错误', 'error');
    }
  });

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg msg-' + type;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  // ---------- 管理员审核 ----------
  document.getElementById('adminLoginBtn').addEventListener('click', async function() {
    const keyInput = document.getElementById('adminKeyInput');
    const key = keyInput.value.trim();
    const pendingDiv = document.getElementById('adminPendingList');
    if (!key) { alert('请输入管理密钥'); return; }
    try {
      const resp = await fetch('/api/admin/pending', {
        headers: { 'X-Admin-Key': key }
      });
      if (resp.status === 401) {
        pendingDiv.innerHTML = '<p style="color:#ef4444;">❌ 密钥错误或无权限</p>';
        return;
      }
      const list = await resp.json();
      if (!Array.isArray(list) || list.length === 0) {
        pendingDiv.innerHTML = '<p style="color:#22c55e;">✅ 暂无待审核域名</p>';
        return;
      }
      let html = '<table><thead><tr><th>域名</th><th>提交者IP</th><th>时间</th><th>操作</th></tr></thead><tbody>';
      list.forEach(item => {
        html += \`<tr>
          <td>\${item.domain}</td>
          <td>\${item.submitter}</td>
          <td>\${new Date(item.time).toLocaleString()}</td>
          <td>
            <button class="btn btn-success" data-domain="\${item.domain}" data-action="approve">通过</button>
            <button class="btn btn-danger" data-domain="\${item.domain}" data-action="reject">拒绝</button>
          </td>
        </tr>\`;
      });
      html += '</tbody></table>';
      pendingDiv.innerHTML = html;

      // 绑定审核事件
      document.querySelectorAll('#adminPendingList [data-domain]').forEach(btn => {
        btn.addEventListener('click', async function() {
          const domain = this.dataset.domain;
          const action = this.dataset.action;
          if (!confirm(\`确定要\${action === 'approve' ? '通过' : '拒绝'} \${domain} 吗？\`)) return;
          try {
            const resp = await fetch('/api/admin/approve', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': key
              },
              body: JSON.stringify({ domain, action })
            });
            const data = await resp.json();
            if (resp.ok) {
              alert('✅ 操作成功');
              // 重新加载列表
              document.getElementById('adminLoginBtn').click();
            } else {
              alert('❌ 操作失败: ' + (data.error || '未知错误'));
            }
          } catch {
            alert('❌ 网络错误');
          }
        });
      });
    } catch {
      pendingDiv.innerHTML = '<p style="color:#ef4444;">❌ 加载失败</p>';
    }
  });

  // 初始化：如果友链为空，显示提示
  const friendGrid = document.querySelector('.friend-grid');
  if (friendGrid.children.length === 0) {
    friendGrid.innerHTML = '<p style="color:var(--text-secondary);">暂无友链，请在环境变量中配置 FRIEND_LINKS</p>';
  }
</script>
</body>
</html>`;
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 根路径 -> 返回单页应用
      if (path === '/') {
        const domains = await getDomainList(env);
        let friends = [];
        if (env.FRIEND_LINKS) {
          try { friends = JSON.parse(env.FRIEND_LINKS); } catch (_) {}
        }
        const html = buildAppHtml(domains, friends);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (path.startsWith('/api/')) {
        return handleApi(request, env);
      }

      if (path.startsWith('/proxy/')) {
        return handleProxy(request, env);
      }

      return new Response('未找到资源', { status: 404 });
    } catch (err) {
      console.error('[全局异常]', err.stack);
      return new Response('服务器内部错误', { status: 500 });
    }
  },
};