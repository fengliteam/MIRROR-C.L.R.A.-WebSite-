// ============================================================
// CLRA Mirror - 域名导航与代理服务
// 功能：多源域名聚合、智能代理、用户提交、管理员审核
// 部署：Cloudflare Workers + KV
// 注意：密码通过环境变量 ADMIN_API_KEY 注入，切勿硬编码！
// ============================================================

// ---------- 配置（可在此调整参数） ----------
const CONFIG = {
  // 远程域名列表（原版）
  LIST_URLS: [
    'https://jfdoc.xingying.us.kg/clra_urls.txt',
    'https://clra1.lzh173.chat/clra_urls.txt',
  ],
  // 硬编码域名（原版）
  HARDCODED_DOMAINS: ['jpt.lzh173.chat', 'scltk.lzh173.chat'],
  // 性能与安全
  RATE_LIMIT_PER_MIN: 100,       // 每分钟请求限制
  DOMAIN_CACHE_TTL: 60,          // 域名列表缓存秒数
  MAX_URL_LENGTH: 15000,         // 代理URL最大长度（字节）
};

// ---------- 全局状态 ----------
let domainCache = null;          // 缓存的域名列表
let cacheTimestamp = 0;          // 缓存时间戳
const rateMap = new Map();       // IP限频记录 { count, resetTime }

// ---------- 工具函数 ----------
/**
 * 返回 JSON 响应
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * HTML 转义（防XSS）
 */
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return text.replace(/[&<>"]/g, m => map[m]);
}

/**
 * 限频检查（内存滑动窗口）
 */
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  let record = rateMap.get(ip);
  if (!record || now - record.resetTime > windowMs) {
    rateMap.set(ip, { count: 1, resetTime: now + windowMs });
    return false;
  }
  record.count++;
  if (record.count > CONFIG.RATE_LIMIT_PER_MIN) {
    return true;
  }
  // 清理过期条目（防止内存泄露）
  if (rateMap.size > 1000) {
    for (const [key, val] of rateMap.entries()) {
      if (now - val.resetTime > windowMs) {
        rateMap.delete(key);
      }
    }
  }
  return false;
}

/**
 * 域名匹配（支持通配符 *.example.com）
 */
function isDomainAllowed(domain, allowedList) {
  return allowedList.some(pattern => {
    if (pattern === domain) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return domain === suffix || domain.endsWith('.' + suffix);
    }
    return false;
  });
}

/**
 * URL 重写（将目标资源链接转为代理链接）
 */
function rewriteUrl(originalUrl, domain) {
  // 忽略特殊协议和已代理的链接
  if (!originalUrl || /^(data|blob|javascript|mailto|tel):/i.test(originalUrl)) {
    return originalUrl;
  }
  if (originalUrl.startsWith('/proxy/')) {
    return originalUrl;
  }

  try {
    let urlObj;
    if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
      urlObj = new URL(originalUrl);
      // 只代理同域资源，避免将外部链接也代理
      if (urlObj.hostname !== domain) {
        return originalUrl;
      }
    } else {
      // 相对路径或绝对路径
      urlObj = new URL(originalUrl, `https://${domain}/`);
    }

    const path = urlObj.pathname;
    const search = urlObj.search || '';
    const proxyPath = `/proxy/${encodeURIComponent(domain)}${path}${search}`;

    // 防止代理链接过长
    if (proxyPath.length > CONFIG.MAX_URL_LENGTH) {
      return urlObj.href; // 直接返回原链接（不代理）
    }
    return proxyPath;
  } catch (_) {
    // 解析失败，原样返回
    return originalUrl;
  }
}

// ---------- 获取完整域名列表（含 KV 已审核域名） ----------
async function getDomainList(env) {
  const now = Date.now();

  // 如果缓存有效，直接返回
  if (domainCache && (now - cacheTimestamp) < CONFIG.DOMAIN_CACHE_TTL * 1000) {
    return domainCache;
  }

  const domainSet = new Set();

  // 1. 添加硬编码域名
  CONFIG.HARDCODED_DOMAINS.forEach(d => domainSet.add(d));

  // 2. 并行拉取远程列表
  const fetchPromises = CONFIG.LIST_URLS.map(async (url) => {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'CLRA-Mirror' },
      });
      if (!response.ok) {
        console.warn(`[getDomainList] 远程列表拉取失败: ${url} status=${response.status}`);
        return [];
      }
      const text = await response.text();
      return text.split(/\s+/).filter(s => s.length > 0);
    } catch (err) {
      console.warn(`[getDomainList] 远程列表请求异常: ${url} error=${err.message}`);
      return [];
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      result.value.forEach(d => domainSet.add(d));
    }
  });

  // 3. 从 KV 读取已审核域名
  if (env && env.DOMAINS_KV) {
    try {
      const approved = await env.DOMAINS_KV.get('approved_list', 'json');
      if (Array.isArray(approved)) {
        approved.forEach(d => domainSet.add(d));
      }
    } catch (err) {
      console.warn('[getDomainList] KV 读取失败:', err.message);
    }
  }

  // 更新缓存
  domainCache = Array.from(domainSet);
  cacheTimestamp = now;
  return domainCache;
}

// ---------- 代理请求处理 ----------
async function handleProxy(request, env) {
  const url = new URL(request.url);
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

  // 限频检查
  if (isRateLimited(clientIP)) {
    return new Response('请求过于频繁，请稍后再试', { status: 429 });
  }

  // 解析代理路径: /proxy/域名/路径
  const pathMatch = url.pathname.match(/^\/proxy\/([^\/]+)(\/.*)?$/);
  if (!pathMatch) {
    return new Response('无效的代理路径', { status: 400 });
  }

  const domain = decodeURIComponent(pathMatch[1]);
  const targetPath = pathMatch[2] || '/';
  const targetSearch = url.search || '';

  // 检查域名是否在白名单中
  const allowedDomains = await getDomainList(env);
  if (!isDomainAllowed(domain, allowedDomains)) {
    return new Response('此域名不在允许列表中', { status: 403 });
  }

  // 构造目标 URL
  let targetUrl;
  try {
    targetUrl = new URL(`https://${domain}${targetPath}${targetSearch}`);
  } catch (_) {
    return new Response('目标 URL 格式错误', { status: 400 });
  }

  // 检查 URL 长度
  if (targetUrl.href.length > CONFIG.MAX_URL_LENGTH) {
    return new Response(
      `目标 URL 过长，请直接访问：<a href="${targetUrl.href}">${targetUrl.href}</a>`,
      { status: 414, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // 清洗请求头（移除隐私相关）
  const requestHeaders = new Headers(request.headers);
  const blockedHeaders = [
    'cookie', 'authorization', 'proxy-authorization',
    'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'
  ];
  blockedHeaders.forEach(h => requestHeaders.delete(h));
  requestHeaders.set('X-Forwarded-Host', domain);
  requestHeaders.set('User-Agent', 'CLRA-Mirror-Proxy');

  try {
    // 转发请求
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: request.body,
      redirect: 'manual',
    });

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Location', rewriteUrl(location, domain));
        return new Response(null, {
          status: response.status,
          headers: newHeaders,
        });
      }
    }

    // 处理响应内容
    const contentType = response.headers.get('content-type') || '';
    const responseHeaders = new Headers(response.headers);
    // 移除 CSP 头（避免影响代理）
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');

    // 如果是 HTML，使用 HTMLRewriter 进行重写
    if (contentType.includes('text/html')) {
      const rewriter = new HTMLRewriter()
        .on('a', {
          element(el) {
            const href = el.getAttribute('href');
            if (href) el.setAttribute('href', rewriteUrl(href, domain));
          }
        })
        .on('img', {
          element(el) {
            const src = el.getAttribute('src');
            if (src) el.setAttribute('src', rewriteUrl(src, domain));
          }
        })
        .on('script', {
          element(el) {
            const src = el.getAttribute('src');
            if (src) el.setAttribute('src', rewriteUrl(src, domain));
          }
        })
        .on('link', {
          element(el) {
            const rel = el.getAttribute('rel');
            if (['stylesheet', 'preload', 'preconnect', 'dns-prefetch'].includes(rel)) {
              const href = el.getAttribute('href');
              if (href) el.setAttribute('href', rewriteUrl(href, domain));
            }
          }
        })
        .on('form', {
          element(el) {
            const action = el.getAttribute('action');
            if (action) el.setAttribute('action', rewriteUrl(action, domain));
          }
        })
        .on('meta', {
          element(el) {
            const httpEquiv = el.getAttribute('http-equiv');
            if (httpEquiv && httpEquiv.toLowerCase() === 'refresh') {
              const content = el.getAttribute('content');
              if (content) {
                const match = content.match(/url=(.+)/i);
                if (match) {
                  const newUrl = rewriteUrl(match[1], domain);
                  el.setAttribute('content', content.replace(/url=.+/i, `url=${newUrl}`));
                }
              }
            }
          }
        })
        .on('style', {
          text(text) {
            const rewritten = text.text.replace(
              /url\((['"]?)([^'")]+)(['"]?)\)/g,
              (_, q1, urlPart, q2) => `url(${q1}${rewriteUrl(urlPart.trim(), domain)}${q2})`
            );
            text.replace(rewritten);
          }
        });

      return rewriter.transform(
        new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        })
      );
    }

    // 如果是 CSS，直接重写
    if (contentType.includes('text/css')) {
      const cssText = await response.text();
      const rewritten = cssText.replace(
        /url\((['"]?)([^'")]+)(['"]?)\)/g,
        (_, q1, urlPart, q2) => `url(${q1}${rewriteUrl(urlPart.trim(), domain)}${q2})`
      );
      return new Response(rewritten, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // 其他类型（图片、视频等）直接返回
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('[handleProxy] 代理错误:', error.message);
    return new Response(`代理服务错误: ${error.message}`, { status: 502 });
  }
}

// ---------- API 请求处理 ----------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  // ---------- 健康检查 ----------
  if (method === 'GET' && path === '/api/health') {
    return jsonResponse({ status: 'ok', timestamp: Date.now() });
  }

  // ---------- 用户提交域名 ----------
  if (method === 'POST' && path === '/api/domains') {
    try {
      const { domain } = await request.json();
      if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) {
        return jsonResponse({ error: '域名格式无效' }, 400);
      }

      const pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      const approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];

      // 检查是否已存在
      if (pending.some(item => item.domain === domain) || approved.includes(domain)) {
        return jsonResponse({ error: '域名已提交或已通过审核' }, 409);
      }

      // 存入待审列表
      const submitter = request.headers.get('CF-Connecting-IP') || 'unknown';
      pending.push({
        id: crypto.randomUUID(),
        domain,
        submitter,
        time: Date.now(),
      });
      await env.DOMAINS_KV.put('pending_list', JSON.stringify(pending));

      return jsonResponse({ success: true, message: '提交成功，等待管理员审核' }, 201);
    } catch (err) {
      console.warn('[API] 提交域名异常:', err.message);
      return jsonResponse({ error: '请求数据无效' }, 400);
    }
  }

  // ---------- 管理员查看待审列表 ----------
  if (method === 'GET' && path === '/api/admin/pending') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      const pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      return jsonResponse(pending);
    } catch (err) {
      console.error('[API] 读取待审列表失败:', err.message);
      return jsonResponse({ error: '服务器内部错误' }, 500);
    }
  }

  // ---------- 管理员审核（通过/拒绝） ----------
  if (method === 'POST' && path === '/api/admin/approve') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) {
      return new Response('Unauthorized', { status: 401 });
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

      // 从待审列表移除
      pending.splice(index, 1);
      await env.DOMAINS_KV.put('pending_list', JSON.stringify(pending));

      // 如果通过，添加到已审核列表
      if (action === 'approve') {
        let approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
        if (!approved.includes(domain)) {
          approved.push(domain);
          await env.DOMAINS_KV.put('approved_list', JSON.stringify(approved));
        }
      }

      return jsonResponse({ success: true });
    } catch (err) {
      console.warn('[API] 审核操作异常:', err.message);
      return jsonResponse({ error: '无效请求' }, 400);
    }
  }

  // 其他 API 路径返回 404
  return new Response('Not Found', { status: 404 });
}

// ---------- 管理界面 HTML（现代化玻璃风格） ----------
function buildAdminPage(domains) {
  const domainCount = domains.length;
  const tagHtml = domains.map(d => `<span class="tag">${escapeHtml(d)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLRA 导航 · 管理</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 2rem 1rem;
    }
    .glass {
      background: rgba(255,255,255,0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 2rem;
      padding: 2rem;
      max-width: 1000px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.3);
    }
    h1 {
      font-weight: 600;
      font-size: 2rem;
      background: linear-gradient(135deg, #1e293b, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: #475569; margin-bottom: 2rem; }
    .section {
      background: rgba(255,255,255,0.5);
      border-radius: 1.5rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      border: 1px solid rgba(255,255,255,0.6);
    }
    .section-title {
      font-weight: 500;
      color: #0f172a;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .tag-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      max-height: 180px;
      overflow-y: auto;
      padding: 0.25rem 0;
    }
    .tag {
      background: rgba(59,130,246,0.1);
      border: 1px solid rgba(59,130,246,0.2);
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      font-size: 0.8rem;
      color: #1e293b;
      transition: all 0.2s;
    }
    .tag:hover {
      background: rgba(59,130,246,0.2);
      transform: scale(1.02);
    }
    .input-group {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .input-group input,
    .admin-area input {
      flex: 1;
      min-width: 180px;
      padding: 0.75rem 1rem;
      border: 1px solid #e2e8f0;
      border-radius: 999px;
      background: rgba(255,255,255,0.8);
      font-size: 0.95rem;
      outline: none;
      transition: 0.2s;
    }
    .input-group input:focus,
    .admin-area input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,0.2);
    }
    .btn {
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 999px;
      font-weight: 500;
      background: #3b82f6;
      color: white;
      cursor: pointer;
      transition: 0.2s;
      white-space: nowrap;
    }
    .btn:hover { background: #2563eb; transform: scale(1.02); }
    .btn-success { background: #22c55e; }
    .btn-success:hover { background: #16a34a; }
    .btn-danger { background: #ef4444; }
    .btn-danger:hover { background: #dc2626; }
    .btn-outline { background: transparent; border: 1px solid #cbd5e1; color: #1e293b; }
    .btn-outline:hover { background: #f1f5f9; }
    .msg {
      margin-top: 0.75rem;
      padding: 0.5rem 1rem;
      border-radius: 999px;
      display: none;
    }
    .msg-success { background: #dcfce7; color: #166534; }
    .msg-error { background: #fee2e2; color: #991b1b; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      padding: 0.75rem 0.5rem;
      color: #475569;
      border-bottom: 1px solid #e2e8f0;
    }
    td {
      padding: 0.75rem 0.5rem;
      border-bottom: 1px solid #f1f5f9;
    }
    .admin-area {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .action-btns {
      display: flex;
      gap: 0.4rem;
    }
    .action-btns .btn { padding: 0.3rem 0.8rem; font-size: 0.8rem; }
    @media (max-width: 640px) {
      .glass { padding: 1rem; }
      .input-group, .admin-area { flex-direction: column; }
      .input-group input, .admin-area input { width: 100%; }
    }
  </style>
</head>
<body>
<div class="glass">
  <h1>🌐 CLRA 导航</h1>
  <p class="subtitle">智能域名代理 · 提交您需要的网站</p>

  <!-- 域名列表 -->
  <div class="section">
    <div class="section-title">📋 可用域名（${domainCount}）</div>
    <div class="tag-cloud">${tagHtml}</div>
    <div style="font-size:0.8rem;color:#64748b;margin-top:0.75rem;">
      来源：硬编码 ${CONFIG.HARDCODED_DOMAINS.length} 个 · 远程列表 ${CONFIG.LIST_URLS.length} 个 · 已审核
    </div>
  </div>

  <!-- 提交新域名 -->
  <div class="section">
    <div class="section-title">✏️ 提交新域名</div>
    <div class="input-group">
      <input type="text" id="domainInput" placeholder="example.com" />
      <button class="btn" id="submitBtn">提交审核</button>
    </div>
    <div id="userMsg" class="msg"></div>
  </div>

  <!-- 管理员审核 -->
  <div class="section" style="border-top: 2px dashed #cbd5e1;">
    <div class="section-title">🔐 管理员审核</div>
    <div class="admin-area">
      <input type="password" id="adminKeyInput" placeholder="管理密钥" />
      <button class="btn btn-outline" id="loginBtn">加载待审</button>
    </div>
    <div id="pendingList" style="margin-top:1rem; color:#64748b;">输入密钥后点击加载</div>
  </div>
</div>

<script>
(function() {
  const domainInput = document.getElementById('domainInput');
  const submitBtn = document.getElementById('submitBtn');
  const userMsg = document.getElementById('userMsg');
  const adminKeyInput = document.getElementById('adminKeyInput');
  const loginBtn = document.getElementById('loginBtn');
  const pendingDiv = document.getElementById('pendingList');

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg msg-' + type;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  // 提交域名
  submitBtn.addEventListener('click', async () => {
    const domain = domainInput.value.trim();
    if (!domain) {
      showMsg(userMsg, '请输入域名', 'error');
      return;
    }
    try {
      const resp = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain })
      });
      const data = await resp.json();
      if (resp.ok) {
        showMsg(userMsg, '✅ ' + data.message, 'success');
        domainInput.value = '';
      } else {
        showMsg(userMsg, '❌ ' + (data.error || '提交失败'), 'error');
      }
    } catch {
      showMsg(userMsg, '❌ 网络错误', 'error');
    }
  });

  // 加载待审列表
  loginBtn.addEventListener('click', async () => {
    const key = adminKeyInput.value.trim();
    if (!key) {
      alert('请输入管理密钥');
      return;
    }
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
        const time = new Date(item.time).toLocaleString();
        html += \`<tr>
          <td>\${item.domain}</td>
          <td>\${item.submitter}</td>
          <td>\${time}</td>
          <td>
            <button class="btn btn-success" data-domain="\${item.domain}" data-action="approve">通过</button>
            <button class="btn btn-danger" data-domain="\${item.domain}" data-action="reject">拒绝</button>
          </td>
        </tr>\`;
      });
      html += '</tbody></table>';
      pendingDiv.innerHTML = html;

      // 绑定审核事件
      document.querySelectorAll('[data-domain]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const domain = btn.dataset.domain;
          const action = btn.dataset.action;
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
              loginBtn.click(); // 刷新列表
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
})();
</script>
</body>
</html>`;
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 根路径 -> 管理界面
    if (path === '/') {
      try {
        const domains = await getDomainList(env);
        return new Response(buildAdminPage(domains), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (err) {
        console.error('[Main] 加载域名列表失败:', err.message);
        return new Response('服务器内部错误', { status: 500 });
      }
    }

    // API 路由
    if (path.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // 代理路由
    if (path.startsWith('/proxy/')) {
      return handleProxy(request, env);
    }

    // 其他请求
    return new Response('Not Found', { status: 404 });
  },
};