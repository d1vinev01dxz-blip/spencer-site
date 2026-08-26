#!/usr/bin/env node
/**
 * Spencer Website static mirror fetcher.
 * Fetches all public pages from the live site (solving the InfinityFree
 * AES anti-bot challenge), rewrites links for static hosting, strips
 * tracker scripts, and writes the tree into the repo root.
 * Runs in GitHub Actions (node 20, no external deps).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://websiteqwe.xo.je';
const OUT_ROOT = __dirname; // repo root (script lives at repo root)

// Pages excluded from the mirror (auth/session/forms)
const EXCLUDE = [
  'admin.php', 'admin_new.php', 'user_panel.php', 'contributor_panel.php',
  'designer_panel.php', 'ai_panel.php', 'payment_status.php',
  'manage_subscription.php', 'reset_password.php', 'register.php',
  'Error.php', 'forbidden.php', 'suspended.php', 'build.php', 'up.php',
  'background_system.php', 'background_header.php', 'load_background_system.php',
  'get_yaps_messages.php', 'post_yaps_message.php',
  'mark_all_announcements_read.php', 'mark_announcement_read.php',
  'set_user_background.php', 'create_background_tables.php',
  'create_designer_tables.php', 'create_ideas_table.php',
  'init_admin_tables.php', 'repair_database.php', 'sitemap.php',
  'info.php', 'health.php', 'image_proxy.php', 'set.php', 'smail.php',
];

function fetch(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: cookie ? { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' }
                      : { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
      timeout: 45000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function toNumbers(h) { const e = []; h.replace(/(..)/g, (d) => e.push(parseInt(d, 16))); return e; }
function toHex(a) { return a.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('').toLowerCase(); }

async function getPage(url) {
  let p = await fetch(url);
  if (p.body && p.body.includes('slowAES.decrypt')) {
    const m = p.body.match(/toNumbers\("([0-9a-f]+)"\),b=toNumbers\("([0-9a-f]+)"\),c=toNumbers\("([0-9a-f]+)"\)/);
    if (!m) return p;
    try {
      const aes = await fetch(BASE + '/aes.js');
      const module = { exports: {} };
      const fn = new Function('module', 'exports', 'require', '__dirname', '__filename',
        aes.body + '\nmodule.exports = slowAES;');
      fn(module, module.exports, require, '', '');
      const dec = module.exports.decrypt(toNumbers(m[3]), 2, toNumbers(m[1]), toNumbers(m[2]));
      p = await fetch(url, '__test=' + toHex(dec) + '; max-age=21600');
    } catch (e) { console.error('challenge solve failed:', e.message); }
  }
  return p;
}

// Rewrite .php links for static hosting; forms/iframe srcs point back to live host
function rewriteHtml(html) {
  return html
    // form actions and .php srcs -> live host (forms must hit the PHP server)
    .replace(/(<(?:form|iframe|embed|object)[^>]*?(?:action|src)=["'])(\/?[A-Za-z0-9_\-]+\.php)(\?[^"']*)?(["'])/g,
      '$1' + BASE + '/$2$4')
    // hrefs .php -> mirror relative path (X.php -> X/)
    .replace(/(<(?:a|link|area)[^>]*?href=["'])(\/?)([A-Za-z0-9_\-]+)\.php(\?[^"']*)?(["'])/g,
      '$1$3/$5')
    // strip tracker scripts (they'd 404 against github.io)
    .replace(/<script[^>]*src=["'][^"']*(?:tracking|maintenance-heartbeat|fingerprint)\.js[^"']*["'][^>]*><\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*\/api\/[^"']*["'][^>]*><\/script>/gi, '');
}

async function main() {
  // 1. Fetch sitemap for the page list
  let sm = await getPage(BASE + '/sitemap.php');
  if (sm.status !== 200) {
    // Live site unreachable (e.g. InfinityFree suspension) — keep the last
    // good mirror and exit cleanly so the workflow shows no failure.
    console.log('live site unreachable (HTTP ' + sm.status + ') — keeping last mirror');
    process.exit(0);
  }
  const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  console.log('sitemap locs:', locs.length);
  if (locs.length === 0) { console.error('no pages in sitemap'); process.exit(1); }

  const pages = [];
  for (const loc of locs) {
    let u;
    try { u = new URL(loc); } catch { continue; }
    const p = u.pathname.replace(/^\//, '');
    if (!p.endsWith('.php') || EXCLUDE.includes(p)) continue;
    pages.push(p);
  }
  console.log('mirroring', pages.length, 'pages');

  // 2. Clean previous mirror output (keep .github, mirror.js, workflow files)
  for (const entry of fs.readdirSync(OUT_ROOT)) {
    if (entry === '.github' || entry === 'mirror.js' || entry === 'README.md' || entry === '.git' || entry === '.gitignore') continue;
    fs.rmSync(path.join(OUT_ROOT, entry), { recursive: true, force: true });
  }

  // 3. Fetch + write each page
  let ok = 0, failed = [];
  for (const p of pages) {
    const url = BASE + '/' + p;
    try {
      const res = await getPage(url);
      if (res.status !== 200) { failed.push(p + ' (HTTP ' + res.status + ')'); continue; }
      const html = rewriteHtml(res.body);
      const outPath = p === 'index.php' ? path.join(OUT_ROOT, 'index.html')
        : path.join(OUT_ROOT, p.replace(/\.php$/, ''), 'index.html');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
      ok++;
    } catch (e) { failed.push(p + ' (' + e.message + ')'); }
  }
  console.log('mirrored OK:', ok, '| failed:', failed.length);
  if (failed.length) console.log('failed:', failed.join(', '));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
