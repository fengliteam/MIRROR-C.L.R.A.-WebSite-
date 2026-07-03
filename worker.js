// ============================================================
// CLRA Mirror - 强制全代理 + 泛域名支持 + 外链提示
// ============================================================

const CONFIG = {
  LIST_URLS: [
    'https://jfdoc.xingying.us.kg/clra_urls.txt',
    'https://clra1.lzh173.chat/clra_urls.txt',
  ],
  HARDCODED_DOMAINS: ['jpt.lzh173.chat', 'scltk.lzh173.chat'],
  RATE_LIMIT_PER_MIN: 100,
  DOMAIN_CACHE_TTL: 60,
  MAX_URL_LENGTH: 15000,
};

let domainCache = null;
let cacheTimestamp = 0;
const rateMap = new Map();

// ---------- 工具 ----------
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

// ---------- 核心：强制全代理，失败时返回特殊路径 ----------
function rewriteUrl(originalUrl, domain) {
  if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
  if (/^(data|blob|javascript|mailto|tel|ws|wss):/i.test(originalUrl)) return originalUrl;
  if (originalUrl.startsWith('/proxy/')) return originalUrl;

  let urlString = originalUrl;
  if (urlString.startsWith('//')) {
    urlString = 'https:' + urlString;
  }

  try {
    let urlObj;
    if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
      urlObj = new URL(urlString);
    } else {
      urlObj = new URL(urlString, `https://${domain}/`);
    }
    const targetDomain = urlObj.hostname;
    // 如果目标域名包含 *，视为泛域名，我们也放行，代理层会处理
    const path = urlObj.pathname;
    const search = urlObj.search || '';
    const hash = urlObj.hash || '';
    const proxyPath = `/proxy/${encodeURIComponent(targetDomain)}${path}${search}${hash}`;
    if (proxyPath.length > CONFIG.MAX_URL_LENGTH) return urlObj.href;
    return proxyPath;
  } catch (_) {
    // 解析失败，返回特殊标记，代理层会拦截
    return '/proxy/blocked/';
  }
}

// ---------- 获取域名列表 ----------
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

  if (env && env.DOMAINS_KV) {
    try {
      const approved = await env.DOMAINS_KV.get('approved_list', 'json');
      if (Array.isArray(approved)) approved.forEach(d => domainSet.add(d));
    } catch (_) {}
  }

  if (env && env.FRIEND_LINKS) {
    try {
      const friends = JSON.parse(env.FRIEND_LINKS);
      if (Array.isArray(friends)) {
        friends.forEach(f => {
          if (f.url) {
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

// ---------- 代理处理（含泛域名随机和外部链接提示） ----------
async function handleProxy(request, env) {
  const url = new URL(request.url);
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(clientIP)) {
    return new Response('请求过于频繁，请稍后再试', { status: 429 });
  }

  const pathMatch = url.pathname.match(/^\/proxy\/([^\/]+)(\/.*)?$/);
  if (!pathMatch) {
    // 如果是特殊标记 /proxy/blocked/，返回错误页面
    if (url.pathname === '/proxy/blocked/') {
      return new Response('无效的链接，无法解析为目标域名', { status: 400 });
    }
    return new Response('无效的代理路径', { status: 400 });
  }

  let domain = decodeURIComponent(pathMatch[1]);
  const targetPath = pathMatch[2] || '/';
  const targetSearch = url.search || '';

  // 处理泛域名：如果域名包含 *，随机生成子域名
  if (domain.includes('*')) {
    const random = Math.random().toString(36).substring(2, 10);
    // 将 * 替换为随机字符串，但需要处理 *.example.com 格式
    let newDomain = domain.replace(/\*/g, random);
    // 如果域名是 *.example.com，替换后为 random.example.com
    // 如果域名是 *.*.example.com，则替换所有 *
    // 构造新 URL 并重定向
    const newProxyPath = `/proxy/${encodeURIComponent(newDomain)}${targetPath}${targetSearch}`;
    return new Response(null, {
      status: 302,
      headers: { Location: newProxyPath },
    });
  }

  const allowedDomains = await getDomainList(env);
  if (!isDomainAllowed(domain, allowedDomains)) {
    // 返回中转提示页面，让用户选择是否直接访问原网站
    const originalUrl = `https://${domain}${targetPath}${targetSearch}`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>安全提示</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:100px auto;text-align:center;padding:20px;background:#f8fafc}.card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}.btn{display:inline-block;margin:10px;padding:12px 28px;border-radius:40px;border:none;font-weight:600;cursor:pointer;text-decoration:none}.btn-primary{background:#2563eb;color:#fff}.btn-secondary{background:#e2e8f0;color:#1e293b}.btn-secondary:hover{background:#cbd5e1}.btn-primary:hover{background:#1d4ed8}</style>
      </head>
      <body>
      <div class="card">
        <h2>⚠️ 外部链接提醒</h2>
        <p>您点击的域名 <strong>${escapeHtml(domain)}</strong> 不在本镜像白名单中，点击下方“继续访问”将直接跳转至原网站，<strong>不受代理保护</strong>，请自行辨别风险。</p>
        <p style="font-size:0.9rem;color:#64748b;">目标地址：${escapeHtml(originalUrl)}</p>
        <a href="${escapeHtml(originalUrl)}" class="btn btn-primary">继续访问（不代理）</a>
        <a href="javascript:history.back()" class="btn btn-secondary">返回</a>
      </div>
      </body>
      </html>
    `;
    return new Response(html, {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // 构造目标 URL
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
          if (['stylesheet', 'preload', 'preconnect', 'dns-prefetch', 'icon', 'apple-touch-icon'].includes(rel)) {
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
                const newUrl = rewriteUrl(match[1], domain);
                el.setAttribute('content', content.replace(/url=.+/i, `url=${newUrl}`));
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
        }})
        .on('object', { element(el) { const v = el.getAttribute('data'); if (v) el.setAttribute('data', rewriteUrl(v, domain)); } })
        .on('embed', { element(el) { const v = el.getAttribute('src'); if (v) el.setAttribute('src', rewriteUrl(v, domain)); } })
        .on('source', { element(el) {
          const v = el.getAttribute('src');
          if (v) el.setAttribute('src', rewriteUrl(v, domain));
          const srcset = el.getAttribute('srcset');
          if (srcset) {
            const newSrcset = srcset.split(',').map(part => {
              const trimmed = part.trim();
              const parts = trimmed.split(/\s+/);
              if (parts.length > 0) {
                parts[0] = rewriteUrl(parts[0], domain);
                return parts.join(' ');
              }
              return trimmed;
            }).join(', ');
            el.setAttribute('srcset', newSrcset);
          }
        }})
        .on('video', { element(el) { const v = el.getAttribute('poster'); if (v) el.setAttribute('poster', rewriteUrl(v, domain)); } });

      return rewriter.transform(
        new Response(response.body, { status: response.status, headers: respHeaders })
      );
    }

    if (contentType.includes('text/css')) {
      const cssText = await response.text();
      const rewritten = cssText
        .replace(/url\((['"]?)([^'")]+)(['"]?)\)/g, (_, q1, urlPart, q2) => `url(${q1}${rewriteUrl(urlPart.trim(), domain)}${q2})`)
        .replace(/@import\s+(['"])([^'"]+)(['"])/g, (_, q1, url, q2) => `@import ${q1}${rewriteUrl(url, domain)}${q2}`);
      return new Response(rewritten, { status: response.status, headers: respHeaders });
    }

    return new Response(response.body, { status: response.status, headers: respHeaders });
  } catch (error) {
    console.error('[代理错误]', error.message);
    return new Response(`代理服务异常：${error.message}`, { status: 502 });
  }
}

// ---------- API 处理（同上，保持不变） ----------
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
      if (!domain || !/^[a-z0-9.*-]+$/i.test(domain)) {
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
    if (adminKey !== env.ADMIN_API_KEY) return new Response('未授权', { status: 401 });
    try {
      const pending = await env.DOMAINS_KV.get('pending_list', 'json') || [];
      return jsonResponse(pending);
    } catch (_) {
      return jsonResponse({ error: '服务器读取失败' }, 500);
    }
  }

  if (method === 'GET' && path === '/api/admin/approved') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) return new Response('未授权', { status: 401 });
    try {
      const approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
      return jsonResponse(approved);
    } catch (_) {
      return jsonResponse({ error: '服务器读取失败' }, 500);
    }
  }

  if (method === 'POST' && path === '/api/admin/approve') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) return new Response('未授权', { status: 401 });
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

  if (method === 'DELETE' && path === '/api/admin/approved') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) return new Response('未授权', { status: 401 });
    try {
      const { domain } = await request.json();
      if (!domain) return jsonResponse({ error: '缺少域名参数' }, 400);
      let approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
      const index = approved.indexOf(domain);
      if (index === -1) {
        return jsonResponse({ error: '该域名不在已审核列表中' }, 404);
      }
      approved.splice(index, 1);
      await env.DOMAINS_KV.put('approved_list', JSON.stringify(approved));
      return jsonResponse({ success: true, message: '已从白名单移除' });
    } catch (_) {
      return jsonResponse({ error: '请求处理异常' }, 400);
    }
  }

  if (method === 'DELETE' && path === '/api/admin/approved/batch') {
    const adminKey = request.headers.get('X-Admin-Key');
    if (adminKey !== env.ADMIN_API_KEY) return new Response('未授权', { status: 401 });
    try {
      const { domains } = await request.json();
      if (!Array.isArray(domains) || domains.length === 0) {
        return jsonResponse({ error: '请提供要删除的域名列表' }, 400);
      }
      let approved = await env.DOMAINS_KV.get('approved_list', 'json') || [];
      const toRemove = new Set(domains);
      const newApproved = approved.filter(d => !toRemove.has(d));
      await env.DOMAINS_KV.put('approved_list', JSON.stringify(newApproved));
      return jsonResponse({ success: true, message: `成功移除 ${approved.length - newApproved.length} 个域名` });
    } catch (_) {
      return jsonResponse({ error: '请求处理异常' }, 400);
    }
  }

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

// ---------- 构建 HTML（UI 不变） ----------
function buildAppHtml(domains, friendLinks) {
  const domainItems = domains.map(d => {
    const isWildcard = d.startsWith('*.');
    if (isWildcard) {
      const base = d.slice(2);
      return `<span class="domain-link wildcard-domain" data-base="${escapeHtml(base)}" data-original="${escapeHtml(d)}" title="点击随机子域名">${escapeHtml(d)} <span class="badge">随机</span></span>`;
    } else {
      return `<a href="/proxy/${encodeURIComponent(d)}/" class="domain-link" target="_blank">${escapeHtml(d)}</a>`;
    }
  }).join('');

  const friendItems = (friendLinks || []).map(f => {
    const name = escapeHtml(f.name || f.url);
    const url = f.url;
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
      --badge-bg: #2563eb;
      --badge-text: #fff;
      --transition: 0.25s;
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
        --badge-bg: #60a5fa;
        --badge-text: #0f172a;
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      transition: background 0.3s, color 0.3s;
      padding-top: 70px;
      background-image: radial-gradient(circle at 10% 30%, rgba(37,99,235,0.05) 0%, transparent 60%),
                        radial-gradient(circle at 90% 70%, rgba(96,165,250,0.05) 0%, transparent 60%);
    }
    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: var(--nav-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 2rem;
      height: 64px;
      gap: 1.5rem;
      flex-wrap: nowrap;
      overflow-x: auto;
      box-shadow: 0 2px 20px rgba(0,0,0,0.06);
    }
    .navbar .brand {
      font-weight: 700;
      font-size: 1.3rem;
      color: var(--text);
      text-decoration: none;
      white-space: nowrap;
      margin-right: auto;
      letter-spacing: -0.5px;
    }
    .navbar .brand span { color: var(--link-color); }
    .nav-link {
      color: var(--text-secondary);
      text-decoration: none;
      font-weight: 500;
      padding: 0.4rem 1rem;
      border-radius: 40px;
      transition: var(--transition);
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
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 1.5rem 1.5rem 3rem;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 2.5rem;
      padding: 2rem;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      margin-bottom: 2rem;
      transition: var(--transition);
    }
    .card-title {
      font-size: 1.6rem;
      font-weight: 600;
      margin-bottom: 1.2rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .search-box {
      width: 100%;
      padding: 0.9rem 1.4rem;
      border-radius: 60px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      transition: var(--transition);
      margin-bottom: 1.5rem;
    }
    .search-box:focus {
      border-color: var(--link-color);
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
    }
    .domain-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.7rem;
      max-height: 420px;
      overflow-y: auto;
      padding: 0.2rem 0;
    }
    .domain-link {
      background: var(--tag-bg);
      border: 1px solid var(--tag-border);
      padding: 0.4rem 1.2rem;
      border-radius: 40px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.9rem;
      transition: var(--transition);
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      cursor: pointer;
    }
    .domain-link:hover {
      background: var(--link-color);
      color: white;
      transform: scale(1.04);
      border-color: var(--link-color);
    }
    .badge {
      font-size: 0.6rem;
      background: var(--badge-bg);
      color: var(--badge-text);
      padding: 0.1rem 0.5rem;
      border-radius: 20px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .friend-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1.2rem;
    }
    .friend-item {
      background: var(--tag-bg);
      border: 1px solid var(--tag-border);
      border-radius: 1.5rem;
      padding: 1rem 1.2rem;
      transition: var(--transition);
    }
    .friend-item:hover {
      background: var(--link-color);
      border-color: var(--link-color);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(37,99,235,0.15);
    }
    .friend-item:hover .friend-name,
    .friend-item:hover .friend-domain { color: white; }
    .friend-link {
      text-decoration: none;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .friend-name { font-weight: 600; color: var(--text); font-size: 1.1rem; }
    .friend-domain { font-size: 0.85rem; color: var(--text-secondary); opacity: 0.7; }
    .admin-key-area {
      display: flex;
      gap: 0.8rem;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .admin-key-area input {
      flex: 1;
      min-width: 200px;
      padding: 0.8rem 1.2rem;
      border-radius: 60px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--text);
      outline: none;
      transition: var(--transition);
    }
    .admin-key-area input:focus {
      border-color: var(--link-color);
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
    }
    .btn {
      padding: 0.8rem 2rem;
      border: none;
      border-radius: 60px;
      font-weight: 600;
      background: var(--link-color);
      color: white;
      cursor: pointer;
      transition: var(--transition);
      white-space: nowrap;
      font-size: 0.95rem;
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
    .btn-sm { padding: 0.3rem 1rem; font-size: 0.8rem; }
    .btn-xs { padding: 0.2rem 0.7rem; font-size: 0.7rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      padding: 0.7rem 0.5rem;
      color: var(--text-secondary);
      border-bottom: 2px solid var(--input-border);
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
    .msg {
      padding: 0.5rem 1rem;
      border-radius: 60px;
      margin-top: 0.8rem;
      display: none;
    }
    .msg-success { background: #dcfce7; color: #166534; }
    .msg-error { background: #fee2e2; color: #991b1b; }
    .page { display: none; animation: fadeIn 0.3s ease; }
    .page.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .sub-section { margin-top: 2rem; border-top: 1px solid var(--border); padding-top: 1.5rem; }
    .tab-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 2px solid var(--input-border);
      padding-bottom: 0.5rem;
    }
    .tab-btn {
      background: transparent;
      border: none;
      padding: 0.5rem 1.2rem;
      border-radius: 30px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      transition: var(--transition);
    }
    .tab-btn.active {
      background: var(--link-color);
      color: white;
    }
    .tab-btn:hover:not(.active) { background: var(--tag-bg); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .checkbox-all { margin-right: 0.5rem; }
    @media (max-width: 640px) {
      .navbar { padding: 0 1rem; gap: 0.8rem; }
      .navbar .brand { font-size: 1rem; }
      .nav-link { font-size: 0.85rem; padding: 0.3rem 0.6rem; }
      .container { padding: 1rem; }
      .card { padding: 1.2rem; }
      .friend-grid { grid-template-columns: 1fr 1fr; }
      .admin-key-area { flex-direction: column; }
    }
  </style>
</head>
<body>

<nav class="navbar">
  <a href="#" class="brand">🌐 <span>CLRA</span></a>
  <button class="nav-link active" data-page="home">首页</button>
  <button class="nav-link" data-page="submit">提交</button>
  <button class="nav-link" data-page="admin">审核</button>
  <button class="nav-link" data-page="friends">友链</button>
</nav>

<div class="container">

  <div id="page-home" class="page active">
    <div class="card">
      <div class="card-title">📋 可用域名</div>
      <input type="text" id="searchInput" class="search-box" placeholder="搜索域名..." oninput="filterDomains()">
      <div id="domainList" class="domain-grid">
        ${domainItems}
      </div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:1rem; display:flex; justify-content:space-between; flex-wrap:wrap;">
        <span>共 <strong>${domains.length}</strong> 个</span>
        <span>点击即可通过代理访问</span>
      </div>
    </div>
  </div>

  <div id="page-submit" class="page">
    <div class="card">
      <div class="card-title">✏️ 提交新域名</div>
      <p style="color:var(--text-secondary); margin-bottom:1.2rem;">支持泛域名，如 <code>*.example.com</code></p>
      <div style="display:flex; gap:0.8rem; flex-wrap:wrap;">
        <input type="text" id="submitDomainInput" class="search-box" style="flex:1; min-width:200px;" placeholder="example.com 或 *.example.com">
        <button class="btn" id="submitBtn">提交审核</button>
      </div>
      <div id="submitMsg" class="msg"></div>
    </div>
  </div>

  <div id="page-admin" class="page">
    <div class="card">
      <div class="card-title">🔐 管理员审核</div>
      <div class="admin-key-area">
        <input type="password" id="adminKeyInput" placeholder="管理密钥">
        <button class="btn" id="adminLoginBtn">加载数据</button>
      </div>
      <div id="adminContent">
        <p style="color:var(--text-secondary);">输入密钥后点击加载</p>
      </div>
    </div>
  </div>

  <div id="page-friends" class="page">
    <div class="card">
      <div class="card-title">🔗 友情链接</div>
      <div class="friend-grid">
        ${friendItems || '<p style="color:var(--text-secondary);">暂无友链，请在环境变量中配置 FRIEND_LINKS</p>'}
      </div>
      <div style="margin-top:1rem; font-size:0.9rem; color:var(--text-secondary);">
        点击友链名称将通过代理访问
      </div>
    </div>
  </div>

</div>

<script>
  // 导航切换
  document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const page = this.dataset.page;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');
    });
  });

  function filterDomains() {
    const q = document.getElementById('searchInput').value.toLowerCase().trim();
    const links = document.querySelectorAll('#domainList .domain-link');
    links.forEach(link => {
      const text = link.textContent.toLowerCase();
      link.style.display = text.includes(q) ? 'inline-flex' : 'none';
    });
  }
  window.filterDomains = filterDomains;

  // 泛域名随机
  document.addEventListener('click', function(e) {
    const target = e.target.closest('.wildcard-domain');
    if (target) {
      const base = target.dataset.base;
      if (base) {
        const random = Math.random().toString(36).substring(2, 10);
        const subdomain = random + '.' + base;
        window.open('/proxy/' + encodeURIComponent(subdomain) + '/', '_blank');
      }
      e.preventDefault();
    }
  });

  // 提交域名
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

  // 管理员
  let currentAdminKey = '';
  document.getElementById('adminLoginBtn').addEventListener('click', async function() {
    const keyInput = document.getElementById('adminKeyInput');
    const key = keyInput.value.trim();
    if (!key) { alert('请输入管理密钥'); return; }
    currentAdminKey = key;
    const container = document.getElementById('adminContent');
    container.innerHTML = '<p style="color:var(--text-secondary);">加载中...</p>';

    try {
      const [pendingResp, approvedResp] = await Promise.all([
        fetch('/api/admin/pending', { headers: { 'X-Admin-Key': key } }),
        fetch('/api/admin/approved', { headers: { 'X-Admin-Key': key } })
      ]);
      if (pendingResp.status === 401 || approvedResp.status === 401) {
        container.innerHTML = '<p style="color:#ef4444;">❌ 密钥错误或无权限</p>';
        return;
      }
      const pending = await pendingResp.json();
      const approved = await approvedResp.json();

      let html = `
        <div class="tab-bar">
          <button class="tab-btn active" data-tab="pending-tab">待审核 (${pending.length})</button>
          <button class="tab-btn" data-tab="approved-tab">已审核 (${approved.length})</button>
        </div>
        <div id="pending-tab" class="tab-content active">
          <h3 style="margin:0 0 1rem 0;">📋 待审核域名</h3>
      `;
      if (!Array.isArray(pending) || pending.length === 0) {
        html += '<p style="color:#22c55e;">✅ 暂无待审核域名</p>';
      } else {
        html += '<table><thead><tr><th>域名</th><th>提交者IP</th><th>时间</th><th>操作</th></tr></thead><tbody>';
        pending.forEach(item => {
          html += \`<tr>
            <td>\${item.domain}</td>
            <td>\${item.submitter}</td>
            <td>\${new Date(item.time).toLocaleString()}</td>
            <td>
              <button class="btn btn-success btn-sm" data-domain="\${item.domain}" data-action="approve">通过</button>
              <button class="btn btn-danger btn-sm" data-domain="\${item.domain}" data-action="reject">拒绝</button>
            </td>
          </tr>\`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';

      html += `
        <div id="approved-tab" class="tab-content">
          <h3 style="margin:0 0 1rem 0;">✅ 已审核域名</h3>
          <div style="margin-bottom:1rem;">
            <button class="btn btn-danger btn-sm" id="batchDeleteBtn">删除选中</button>
            <span style="margin-left:1rem; font-size:0.85rem; color:var(--text-secondary);">勾选后点击删除可批量拉黑</span>
          </div>
      `;
      if (!Array.isArray(approved) || approved.length === 0) {
        html += '<p style="color:var(--text-secondary);">暂无已审核域名</p>';
      } else {
        html += '<table><thead><tr><th><input type="checkbox" id="selectAllApproved" class="checkbox-all"></th><th>域名</th><th>操作</th></tr></thead><tbody>';
        approved.forEach(domain => {
          html += \`<tr>
            <td><input type="checkbox" class="approved-checkbox" data-domain="\${domain}"></td>
            <td>\${domain}</td>
            <td><button class="btn btn-danger btn-xs delete-approved" data-domain="\${domain}">删除</button></td>
          </tr>\`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';

      container.innerHTML = html;

      // Tab 切换
      container.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          const target = this.dataset.tab;
          container.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
          document.getElementById(target).classList.add('active');
        });
      });

      // 待审操作
      container.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async function() {
          const domain = this.dataset.domain;
          const action = this.dataset.action;
          if (!confirm(\`确定要\${action === 'approve' ? '通过' : '拒绝'} \${domain} 吗？\`)) return;
          try {
            const resp = await fetch('/api/admin/approve', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': currentAdminKey
              },
              body: JSON.stringify({ domain, action })
            });
            const data = await resp.json();
            if (resp.ok) {
              alert('✅ 操作成功');
              document.getElementById('adminLoginBtn').click();
            } else {
              alert('❌ 操作失败: ' + (data.error || '未知错误'));
            }
          } catch {
            alert('❌ 网络错误');
          }
        });
      });

      // 单个删除
      container.querySelectorAll('.delete-approved').forEach(btn => {
        btn.addEventListener('click', async function() {
          const domain = this.dataset.domain;
          if (!confirm(\`确定要删除（拉黑） \${domain} 吗？\`)) return;
          try {
            const resp = await fetch('/api/admin/approved', {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': currentAdminKey
              },
              body: JSON.stringify({ domain })
            });
            const data = await resp.json();
            if (resp.ok) {
              alert('✅ ' + data.message);
              document.getElementById('adminLoginBtn').click();
            } else {
              alert('❌ 操作失败: ' + (data.error || '未知错误'));
            }
          } catch {
            alert('❌ 网络错误');
          }
        });
      });

      // 全选
      const selectAll = document.getElementById('selectAllApproved');
      if (selectAll) {
        selectAll.addEventListener('change', function() {
          const checkboxes = container.querySelectorAll('.approved-checkbox');
          checkboxes.forEach(cb => cb.checked = this.checked);
        });
      }

      // 批量删除
      const batchBtn = document.getElementById('batchDeleteBtn');
      if (batchBtn) {
        batchBtn.addEventListener('click', async function() {
          const checkboxes = container.querySelectorAll('.approved-checkbox:checked');
          if (checkboxes.length === 0) {
            alert('请至少选择一个域名');
            return;
          }
          const domains = Array.from(checkboxes).map(cb => cb.dataset.domain);
          if (!confirm(\`确定要删除（拉黑）以下 \${domains.length} 个域名吗？\n\${domains.join('、')}\`)) return;
          try {
            const resp = await fetch('/api/admin/approved/batch', {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': currentAdminKey
              },
              body: JSON.stringify({ domains })
            });
            const data = await resp.json();
            if (resp.ok) {
              alert('✅ ' + data.message);
              document.getElementById('adminLoginBtn').click();
            } else {
              alert('❌ 操作失败: ' + (data.error || '未知错误'));
            }
          } catch {
            alert('❌ 网络错误');
          }
        });
      }

    } catch (e) {
      container.innerHTML = '<p style="color:#ef4444;">❌ 加载失败</p>';
    }
  });

  // 友链空提示
  const friendGrid = document.querySelector('.friend-grid');
  if (friendGrid && friendGrid.children.length === 0) {
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