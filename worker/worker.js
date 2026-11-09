/**
 * Troca Aí · Portfólio — Worker de analytics in-house
 *
 * Rotas:
 *   POST /collect   eventos de navegação (sendBeacon), enriquecidos com IP/geo
 *   POST /waitlist  cadastro na lista de espera (com ou sem Google)
 *   GET  /dash?key= painel
 *   GET  /export.csv?key=&what=visitors|events|waitlist
 *
 * Bindings (configurar no painel do Worker):
 *   DB          D1 → trocai-portfolio-analytics
 *   DASH_KEY    secret → chave do painel
 *   GOOGLE_CLIENT_ID  var → Client ID do OAuth (opcional; usado para validar o token)
 */

const ALLOWED_ORIGINS = [
  'https://portfolio.trocai.bia.lu',
  'https://luishansen.github.io',
  'http://localhost:8765',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/collect' && request.method === 'POST') {
        // O corpo precisa ser lido ANTES de responder: depois da resposta o stream do request é fechado.
        const text = await request.text();
        ctx.waitUntil(handleCollect(text, request, env).catch(e => console.error('collect failed:', e && e.message || e)));
        return new Response(null, { status: 204, headers: cors });
      }
      if (url.pathname === '/waitlist' && request.method === 'POST') {
        const out = await handleWaitlist(request, env);
        return json(out, cors);
      }
      if (url.pathname === '/dash' && request.method === 'GET') {
        if (!checkKey(url, env)) return new Response('Não autorizado', { status: 401 });
        return new Response(await renderDash(env), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/visit' && request.method === 'GET') {
        if (!checkKey(url, env)) return new Response('Não autorizado', { status: 401 });
        return new Response(await renderVisit(url.searchParams.get('sid') || '', env), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/export.csv' && request.method === 'GET') {
        if (!checkKey(url, env)) return new Response('Não autorizado', { status: 401 });
        return exportCsv(url.searchParams.get('what') || 'visitors', env);
      }
      if (url.pathname === '/' ) return new Response('ok', { headers: cors });
      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 500);
    }
  },
};

/* ---------------- helpers ---------------- */

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(obj, headers = {}, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
function checkKey(url, env) {
  const k = url.searchParams.get('key');
  return !!(env.DASH_KEY && k && timingSafeEqual(k, env.DASH_KEY));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function geo(request) {
  const cf = request.cf || {};
  return {
    ip: request.headers.get('CF-Connecting-IP') || '',
    city: cf.city || '', region: cf.region || '', country: cf.country || '',
    asn: cf.asOrganization ? `${cf.asn} ${cf.asOrganization}` : String(cf.asn || ''),
    ua: request.headers.get('User-Agent') || '',
  };
}
function deviceOf(ua) {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}
const clean = (v, n = 200) => (v == null ? null : String(v).slice(0, n));

/* ---------------- /collect ---------------- */

async function handleCollect(text, request, env) {
  let body;
  try { body = JSON.parse(text); } catch (e) { console.error('collect: corpo inválido'); return; }
  const events = Array.isArray(body.events) ? body.events : [body];
  if (!events.length) return;
  const g = geo(request);
  const now = Date.now();
  const vid = clean(body.vid || events[0].vid, 64);
  const sid = clean(body.sid || events[0].sid, 64);
  const code = clean(body.code || events[0].code, 64);
  const url = clean(body.url, 300);
  const referrer = clean(body.referrer, 300);
  if (!vid || !sid) return;

  const stmts = [];
  let engaged = 0, maxScroll = 0, newSession = false;
  for (const e of events.slice(0, 50)) {
    const name = clean(e.name, 40); if (!name) continue;
    const ts = Number(e.ts) || now;
    const value = e.value == null ? null : Math.round(Number(e.value)) || 0;
    if (name === 'heartbeat') engaged += value || 0;
    if (name === 'scroll') maxScroll = Math.max(maxScroll, value || 0);
    if (name === 'session_start') newSession = true;
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts,vid,sid,code,name,section,value,meta,ip,city,country,ua,url,referrer)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(ts, vid, sid, code, name, clean(e.section, 80), value, e.meta ? clean(JSON.stringify(e.meta), 500) : null,
           g.ip, g.city, g.country, clean(g.ua, 300), url, referrer));
  }
  stmts.push(env.DB.prepare(
    `INSERT INTO visitors (vid,code,first_seen,last_seen,ip,city,region,country,asn,ua,device,sessions,engaged_ms,max_scroll)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(vid) DO UPDATE SET
       last_seen=excluded.last_seen,
       code=COALESCE(excluded.code, visitors.code),
       ip=excluded.ip, city=excluded.city, region=excluded.region, country=excluded.country, asn=excluded.asn,
       ua=excluded.ua, device=excluded.device,
       sessions=visitors.sessions + ?,
       engaged_ms=visitors.engaged_ms + excluded.engaged_ms,
       max_scroll=MAX(visitors.max_scroll, excluded.max_scroll)`
  ).bind(vid, code, now, now, g.ip, g.city, g.region, g.country, g.asn, clean(g.ua, 300), deviceOf(g.ua), engaged, maxScroll, newSession ? 1 : 0));
  await env.DB.batch(stmts);
}

/* ---------------- /waitlist ---------------- */

async function handleWaitlist(request, env) {
  const body = await request.json();
  const g = geo(request);
  let name = clean(body.name, 120), email = clean(body.email, 160), picture = null, sub = null, via = 'form';

  if (body.credential) {
    const p = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID);
    if (!p) return { ok: false, error: 'Token do Google inválido' };
    name = clean(p.name, 120); email = clean(p.email, 160); picture = clean(p.picture, 300); sub = clean(p.sub, 64); via = 'google';
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'E-mail inválido' };

  await env.DB.prepare(
    `INSERT INTO waitlist (ts,vid,code,name,email,picture,google_sub,via,neighborhood,items,ip,city)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET
       name=COALESCE(excluded.name, waitlist.name), picture=COALESCE(excluded.picture, waitlist.picture),
       google_sub=COALESCE(excluded.google_sub, waitlist.google_sub), via=excluded.via,
       neighborhood=COALESCE(excluded.neighborhood, waitlist.neighborhood), items=COALESCE(excluded.items, waitlist.items),
       vid=COALESCE(excluded.vid, waitlist.vid), code=COALESCE(excluded.code, waitlist.code)`
  ).bind(Date.now(), clean(body.vid, 64), clean(body.code, 64), name, email.toLowerCase(), picture, sub, via,
         clean(body.neighborhood, 120), clean(body.items, 300), g.ip, g.city).run();
  return { ok: true, name, email, picture };
}

/** Valida um ID token do Google Identity Services contra os certificados públicos do Google. */
async function verifyGoogleToken(token, clientId) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = JSON.parse(atob(b64url(parts[0])));
  const payload = JSON.parse(atob(b64url(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) return null;
  if (clientId && payload.aud !== clientId) return null;
  if (!payload.email_verified) return null;

  const certs = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600, cacheEverything: true } }).then(r => r.json());
  const jwk = (certs.keys || []).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(atob(b64url(parts[2])), c => c.charCodeAt(0));
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  return ok ? payload : null;
}
function b64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; }

/* ---------------- painel ---------------- */

const SECTIONS = ['O problema','Como foi pensado','Evidências de campo','A solução','A matemática das trocas','O protótipo','Validação e preço','O mercado','Modelo de negócio','A equipe','Financeiro','Próximos passos','Impacto'];

async function renderDash(env) {
  const [visitors, waitlist, sectionTime, topEvents, daily, sessions, byCode] = await Promise.all([
    env.DB.prepare(`SELECT v.*, w.name AS wl_name, w.email AS wl_email,
        (SELECT COUNT(DISTINCT section) FROM events e WHERE e.vid=v.vid AND e.name='section_view') AS sections_seen
      FROM visitors v LEFT JOIN waitlist w ON w.vid=v.vid ORDER BY v.last_seen DESC LIMIT 500`).all(),
    env.DB.prepare(`SELECT * FROM waitlist ORDER BY ts DESC LIMIT 500`).all(),
    env.DB.prepare(`SELECT section, COUNT(DISTINCT vid) AS visitors, SUM(value) AS ms FROM events WHERE name='section_time' GROUP BY section`).all(),
    env.DB.prepare(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT vid) AS visitors FROM events GROUP BY name ORDER BY n DESC`).all(),
    env.DB.prepare(`SELECT date(ts/1000,'unixepoch') AS day, COUNT(DISTINCT vid) AS visitors, COUNT(DISTINCT sid) AS sessions FROM events GROUP BY day ORDER BY day DESC LIMIT 30`).all(),
    env.DB.prepare(`SELECT vid, sid, MIN(ts) AS started, MAX(ts) AS ended,
        SUM(CASE WHEN name='heartbeat' THEN value ELSE 0 END) AS hb_ms,
        SUM(CASE WHEN name='section_time' THEN value ELSE 0 END) AS sec_ms,
        COUNT(DISTINCT CASE WHEN name='section_view' THEN section END) AS sections_seen,
        MAX(CASE WHEN name='section_view' THEN value END) AS furthest,
        MAX(CASE WHEN name='scroll' THEN value END) AS scroll,
        SUM(CASE WHEN name IN ('section_toggle','nav_click','slider_used','demo_focus','outbound','waitlist_open','waitlist_submit','waitlist_google') THEN 1 ELSE 0 END) AS interactions,
        MAX(ip) AS ip, MAX(city) AS city
      FROM events GROUP BY vid, sid ORDER BY started DESC LIMIT 3000`).all(),
    env.DB.prepare(`SELECT code, COUNT(*) AS devices, SUM(sessions) AS sessions, SUM(engaged_ms) AS engaged_ms, MAX(last_seen) AS last_seen, MAX(max_scroll) AS max_scroll
      FROM visitors WHERE code IS NOT NULL AND code<>'' GROUP BY code ORDER BY last_seen DESC`).all(),
  ]);
  const sessByVid = {};
  for (const r of (sessions.results || [])) (sessByVid[r.vid] = sessByVid[r.vid] || []).push(r);
  const V = visitors.results || [], W = waitlist.results || [];
  const secMap = Object.fromEntries((sectionTime.results || []).map(r => [r.section, r]));
  const fmtT = ms => { ms = ms || 0; const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return m ? `${m}min ${s}s` : `${s}s`; };
  const fmtD = ts => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const totalEngaged = V.reduce((a, v) => a + (v.engaged_ms || 0), 0);

  const sessRead = x => Math.max(x.hb_ms || 0, x.sec_ms || 0);
  const sessLine = (x, i, n) => `<tr class="sess" hidden>
      <td></td><td colspan="2"><a class="vl" href="/visit?sid=${encodeURIComponent(x.sid)}&key=KEY">Visita ${n - i} de ${n} →</a>${i === 0 ? ' <span class="m">· mais recente</span>' : ''}</td>
      <td class="m">${esc(x.ip || '')}<br>${esc(x.city || '')}</td><td></td>
      <td>${fmtD(x.started)}</td>
      <td class="r">${fmtT(x.ended - x.started)}</td><td class="r">${fmtT(sessRead(x))}</td>
      <td class="r">${x.sections_seen}/13${x.furthest ? `<br><span class="m">até a ${x.furthest}</span>` : ''}</td>
      <td class="r">${x.scroll || 0}%</td><td class="r">${x.interactions || 0}</td></tr>`;
  const rowsV = V.map(v => {
    const ss = sessByVid[v.vid] || []; const last = ss[0];
    return `<tbody class="vis"><tr class="main" tabindex="0">
    <td class="tg">${ss.length ? '▸' : ''}</td>
    <td>${esc(v.code || '')}<br><span class="m" title="${esc(v.vid)}">${esc(String(v.vid).slice(0, 8))}</span></td>
    <td>${v.wl_name ? `<b>${esc(v.wl_name)}</b><br><span class="m">${esc(v.wl_email)}</span>` : '<span class="m">anônimo</span>'}</td>
    <td><span class="m">${esc(v.ip)}</span><br>${esc([v.city, v.region, v.country].filter(Boolean).join(', '))}</td>
    <td>${esc(v.device)}</td>
    <td>${fmtD(v.last_seen)}<br><span class="m">1ª: ${fmtD(v.first_seen)}</span></td>
    <td class="r">${ss.length || v.sessions} ${(ss.length || v.sessions) === 1 ? 'visita' : 'visitas'}${last ? `<br><span class="m">última: ${fmtT(last.ended - last.started)}</span>` : ''}</td>
    <td class="r">${fmtT(v.engaged_ms)}</td>
    <td class="r">${v.sections_seen}/13</td><td class="r">${v.max_scroll}%</td>
    <td class="r">${ss.reduce((a, x) => a + (x.interactions || 0), 0)}</td>
  </tr>${ss.map((x, i) => sessLine(x, i, ss.length)).join('')}</tbody>`; }).join('');
  const rowsC = (byCode.results || []).map(c => `<tr><td><b>${esc(c.code)}</b></td><td class="r">${c.devices}</td><td class="r">${c.sessions}</td><td class="r">${fmtT(c.engaged_ms)}</td><td class="r">${c.max_scroll}%</td><td>${fmtD(c.last_seen)}</td></tr>`).join('');
  const rowsW = W.map(w => `<tr><td>${fmtD(w.ts)}</td><td>${w.picture ? `<img src="${esc(w.picture)}" referrerpolicy="no-referrer">` : ''} ${esc(w.name)}</td><td>${esc(w.email)}</td><td>${esc(w.via)}</td><td>${esc(w.code || '')}</td><td>${esc(w.neighborhood || '')}</td><td>${esc(w.items || '')}</td><td class="m">${esc(w.city || '')} · ${esc(w.ip || '')}</td></tr>`).join('');
  const rowsS = SECTIONS.map((s, i) => { const r = secMap[s] || {}; const ms = r.ms || 0; const vis = r.visitors || 0; return `<tr><td>${String(i + 1).padStart(2, '0')} · ${esc(s)}</td><td class="r">${vis}</td><td class="r">${fmtT(ms)}</td><td class="r">${vis ? fmtT(ms / vis) : '—'}</td><td><div class="bar"><b style="width:${Math.min(100, V.length ? vis / V.length * 100 : 0)}%"></b></div></td></tr>`; }).join('');
  const rowsE = (topEvents.results || []).map(r => `<tr><td>${esc(r.name)}</td><td class="r">${r.n}</td><td class="r">${r.visitors}</td></tr>`).join('');
  const rowsD = (daily.results || []).map(r => `<tr><td>${esc(r.day)}</td><td class="r">${r.visitors}</td><td class="r">${r.sessions}</td></tr>`).join('');
  const key = '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Troca Aí · Painel</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;background:#f5ead8;color:#201e1d;margin:0;padding:24px}
h1,h2{font-weight:700;margin:0 0 12px}h1{font-size:22px}h2{font-size:16px;margin-top:32px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}
.tile{background:#fff6ea;border:1px solid #e7d3a9;border-radius:14px;padding:14px}.tile b{display:block;font-size:26px}
table{width:100%;border-collapse:collapse;background:#fff6ea;border:1px solid #e7d3a9;border-radius:14px;overflow:hidden;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eadbc0;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#82796a}
td.r,th.r{text-align:right;white-space:nowrap}.m{color:#82796a;font-size:12px}img{width:22px;height:22px;border-radius:50%;vertical-align:middle}
.bar{height:10px;background:#eadbc0;border-radius:99px;overflow:hidden;min-width:120px}.bar b{display:block;height:100%;background:#7a8a5e}
.wrap{overflow-x:auto}a{color:#8c491a}
tr.main{cursor:pointer}tr.main:hover{background:#fbeedb}td.tg{width:18px;color:#8c491a}tbody.vis.open td.tg{transform:rotate(90deg)}tr.sess{background:#f4ebd3}tbody.vis{border-bottom:2px solid #e7d3a9}
</style></head><body>
<h1>Troca Aí · Portfólio — Painel</h1>
<div class="tiles">
  <div class="tile"><b>${V.length}</b>visitantes</div>
  <div class="tile"><b>${V.reduce((a, v) => a + (v.sessions || 0), 0)}</b>sessões</div>
  <div class="tile"><b>${fmtT(totalEngaged)}</b>tempo total de leitura</div>
  <div class="tile"><b>${V.length ? fmtT(totalEngaged / V.length) : '—'}</b>média por visitante</div>
  <div class="tile"><b>${W.length}</b>na lista de espera</div>
</div>
<h2>Visitantes <span class="m">· agrupados por ID do navegador, mais recente primeiro · clique na linha para ver cada visita · <a href="/export.csv?what=visitors&key=KEY">CSV</a> · <a href="/export.csv?what=events&key=KEY">eventos CSV</a></span></h2>
<div class="wrap"><table class="grouped"><thead><tr><th></th><th>Link · ID</th><th>Quem</th><th>IP · local</th><th>Device</th><th>Última visita</th><th class="r">Visitas</th><th class="r">Leitura</th><th class="r">Seções</th><th class="r">Rolagem</th><th class="r">Interações</th></tr></thead>${rowsV || '<tbody><tr><td colspan="11" class="m">Nenhum acesso ainda.</td></tr></tbody>'}</table></div>
<h2>Por link <span class="m">· soma os aparelhos de quem usou o mesmo ?v=</span></h2>
<div class="wrap"><table><thead><tr><th>Link</th><th class="r">Aparelhos</th><th class="r">Visitas</th><th class="r">Leitura</th><th class="r">Rolagem máx.</th><th>Última visita</th></tr></thead><tbody>${rowsC || '<tr><td colspan="6" class="m">Nenhum link com código ainda.</td></tr>'}</tbody></table></div>
<h2>Lista de espera <span class="m">· <a href="/export.csv?what=waitlist&key=KEY">CSV</a></span></h2>
<div class="wrap"><table><thead><tr><th>Quando</th><th>Nome</th><th>E-mail</th><th>Via</th><th>Link</th><th>Bairro</th><th>Itens</th><th>Local</th></tr></thead><tbody>${rowsW || '<tr><td colspan="8" class="m">Ninguém ainda.</td></tr>'}</tbody></table></div>
<h2>Tempo por seção</h2>
<div class="wrap"><table><thead><tr><th>Seção</th><th class="r">Visitantes</th><th class="r">Tempo total</th><th class="r">Média</th><th>Alcance</th></tr></thead><tbody>${rowsS}</tbody></table></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
<div><h2>Eventos</h2><table><thead><tr><th>Evento</th><th class="r">Total</th><th class="r">Visitantes</th></tr></thead><tbody>${rowsE}</tbody></table></div>
<div><h2>Por dia</h2><table><thead><tr><th>Dia</th><th class="r">Visitantes</th><th class="r">Sessões</th></tr></thead><tbody>${rowsD}</tbody></table></div>
</div>
<script>document.querySelectorAll('tbody.vis tr.main').forEach(function(r){function t(){var b=r.parentNode;b.classList.toggle('open');b.querySelectorAll('tr.sess').forEach(function(x){x.hidden=!b.classList.contains('open')})}r.addEventListener('click',t);r.addEventListener('keydown',function(e){if(e.key==='Enter')t()})});document.querySelectorAll('a[href*="key=KEY"]').forEach(a=>{a.href=a.href.replace('KEY',new URLSearchParams(location.search).get('key'))})</script>
</body></html>`;
}

/* ---------------- detalhe da visita ---------------- */

const EVENT_LABEL = {
  session_start: 'Chegou ao site', page_view: 'Página carregada', section_view: 'Entrou na seção', section_time: 'Tempo na seção',
  scroll: 'Rolou a página até', heartbeat: 'Continuava lendo', section_toggle: 'Abriu/recolheu a seção', nav_click: 'Clicou no menu',
  slider_used: 'Mexeu no controle da matemática', demo_focus: 'Interagiu com o protótipo', outbound: 'Clicou em link externo',
  waitlist_open: 'Foi até a lista de espera', waitlist_google: 'Escolheu conta Google', waitlist_submit: 'Entrou na lista de espera',
};
const EVENT_KIND = { section_view: 'sec', section_time: 'quiet', heartbeat: 'quiet', page_view: 'quiet', scroll: 'quiet',
  waitlist_submit: 'win', waitlist_google: 'win', waitlist_open: 'act', demo_focus: 'act', slider_used: 'act', nav_click: 'act', section_toggle: 'act', outbound: 'act', session_start: 'sec' };

async function renderVisit(sid, env) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtT = ms => { ms = Math.max(0, ms || 0); const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return m ? `${m}min ${s}s` : `${s}s`; };
  const fmtD = ts => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const fmtH = ts => new Date(ts).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const { results: ev } = await env.DB.prepare(`SELECT * FROM events WHERE sid=? ORDER BY ts ASC, id ASC LIMIT 5000`).bind(sid).all();
  if (!ev.length) return `<!DOCTYPE html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px;background:#f5ead8">Visita não encontrada. <a href="javascript:history.back()">Voltar</a></body>`;
  const first = ev[0], last = ev[ev.length - 1];
  const [vis, wl, others] = await Promise.all([
    env.DB.prepare(`SELECT * FROM visitors WHERE vid=?`).bind(first.vid).first(),
    env.DB.prepare(`SELECT name,email FROM waitlist WHERE vid=?`).bind(first.vid).first(),
    env.DB.prepare(`SELECT sid, MIN(ts) AS started FROM events WHERE vid=? GROUP BY sid ORDER BY started DESC`).bind(first.vid).all(),
  ]);
  const hb = ev.filter(e => e.name === 'heartbeat').reduce((a, e) => a + (e.value || 0), 0);
  const secMs = ev.filter(e => e.name === 'section_time').reduce((a, e) => a + (e.value || 0), 0);
  const seen = [...new Set(ev.filter(e => e.name === 'section_view').map(e => e.section))];
  const scroll = Math.max(0, ...ev.filter(e => e.name === 'scroll').map(e => e.value || 0));
  const perSec = {}; ev.filter(e => e.name === 'section_time').forEach(e => { perSec[e.section] = (perSec[e.section] || 0) + (e.value || 0); });
  const maxSec = Math.max(1, ...Object.values(perSec));

  // linha do tempo: junta heartbeats consecutivos para não poluir
  const items = []; let hbRun = 0;
  const flushHb = (ts) => { if (hbRun) { items.push({ ts, kind: 'quiet', text: `Continuou lendo por ${fmtT(hbRun)}` }); hbRun = 0; } };
  for (const e of ev) {
    if (e.name === 'heartbeat') { hbRun += e.value || 0; continue; }
    flushHb(e.ts);
    let meta = {}; try { meta = e.meta ? JSON.parse(e.meta) : {}; } catch {}
    let text = EVENT_LABEL[e.name] || e.name;
    if (e.name === 'section_view') text = `Entrou na seção <b>${String(e.value || '').padStart(2, '0')} · ${esc(e.section)}</b>`;
    else if (e.name === 'section_time') text = `Ficou ${fmtT(e.value)} em <b>${esc(e.section)}</b>`;
    else if (e.name === 'scroll') text = `Rolou até ${e.value}% da página`;
    else if (e.name === 'section_toggle') text = `${meta.open ? 'Expandiu' : 'Recolheu'} a seção <b>${esc(e.section)}</b>`;
    else if (e.name === 'nav_click') text = `Clicou no menu: <b>${esc(e.section || '')}</b>`;
    else if (e.name === 'slider_used') text = `Mexeu no controle da matemática (p = ${e.value}%)`;
    else if (e.name === 'outbound') text = `Clicou em link externo: ${esc(meta.href || '')}`;
    else if (e.name === 'session_start') text = `Chegou ao site${meta.ref ? ` vindo de ${esc(meta.ref)}` : ''}${meta.w ? ` <span class="m">· tela ${meta.w}×${meta.h}</span>` : ''}`;
    items.push({ ts: e.ts, kind: EVENT_KIND[e.name] || 'act', text });
  }
  flushHb(last.ts);
  const tl = items.map(i => `<li class="${i.kind}"><time>${fmtH(i.ts)}<span>+${fmtT(i.ts - first.ts)}</span></time><div>${i.text}</div></li>`).join('');
  const secRows = SECTIONS.map((n, i) => perSec[n] ? `<tr><td>${String(i + 1).padStart(2, '0')} · ${esc(n)}</td><td class="r">${fmtT(perSec[n])}</td><td><div class="bar"><b style="width:${perSec[n] / maxSec * 100}%"></b></div></td></tr>` : '').join('');
  const sess = others.results || []; const idx = sess.findIndex(x => x.sid === sid);
  const nav = sess.length > 1 ? `<p class="m">Visita ${sess.length - idx} de ${sess.length} deste visitante · ${idx < sess.length - 1 ? `<a href="/visit?sid=${encodeURIComponent(sess[idx + 1].sid)}&key=KEY">← anterior</a>` : ''} ${idx > 0 ? `<a href="/visit?sid=${encodeURIComponent(sess[idx - 1].sid)}&key=KEY">seguinte →</a>` : ''}</p>` : '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visita · ${esc(first.code || String(first.vid).slice(0, 8))}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;background:#f5ead8;color:#201e1d;margin:0;padding:24px;max-width:980px;margin:0 auto}
h1{font-size:22px;margin:8px 0 4px}h2{font-size:16px;margin:28px 0 10px}a{color:#8c491a}.m{color:#82796a;font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
.tile{background:#fff6ea;border:1px solid #e7d3a9;border-radius:14px;padding:14px}.tile b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;background:#fff6ea;border:1px solid #e7d3a9;border-radius:14px;overflow:hidden;font-size:13px}
td{padding:8px 10px;border-bottom:1px solid #eadbc0}td.r{text-align:right;white-space:nowrap}
.bar{height:10px;background:#eadbc0;border-radius:99px;overflow:hidden;min-width:120px}.bar b{display:block;height:100%;background:#7a8a5e}
ol.tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid #e7d3a9}
ol.tl li{position:relative;display:grid;grid-template-columns:120px 1fr;gap:14px;padding:7px 0 7px 16px}
ol.tl li::before{content:"";position:absolute;left:-21px;top:13px;width:10px;height:10px;border-radius:50%;background:#e7d3a9;border:2px solid #f5ead8}
ol.tl li.sec::before{background:#c67139}ol.tl li.act::before{background:#7a8a5e}ol.tl li.win::before{background:#56633f;width:14px;height:14px;left:-23px;top:11px}
ol.tl li.quiet{color:#82796a}ol.tl li.win{font-weight:600}
time{font-variant-numeric:tabular-nums;color:#201e1d}time span{display:block;color:#82796a;font-size:12px}
</style></head><body>
<a href="/dash?key=KEY">← Painel</a>
<h1>${wl ? esc(wl.name) : (first.code ? esc(first.code) : 'Visitante anônimo')}</h1>
<p class="m">${wl ? esc(wl.email) + ' · ' : ''}${first.code ? 'link ?v=' + esc(first.code) + ' · ' : ''}ID ${esc(first.vid)} · ${esc(vis ? vis.device : '')}</p>
${nav}
<div class="tiles">
  <div class="tile"><b>${fmtD(first.ts)}</b>início</div>
  <div class="tile"><b>${fmtT(last.ts - first.ts)}</b>duração</div>
  <div class="tile"><b>${fmtT(Math.max(hb, secMs))}</b>tempo de leitura</div>
  <div class="tile"><b>${seen.length}/13</b>seções vistas</div>
  <div class="tile"><b>${scroll}%</b>rolagem</div>
</div>
<p class="m">${esc(first.ip || '')} · ${esc([first.city, first.country].filter(Boolean).join(', '))}${vis && vis.asn ? ' · ' + esc(vis.asn) : ''}<br>${esc(first.ua || '')}${first.referrer ? '<br>Veio de: ' + esc(first.referrer) : ''}</p>
${secRows ? `<h2>Tempo por seção nesta visita</h2><table><tbody>${secRows}</tbody></table>` : ''}
<h2>Linha do tempo <span class="m">· ${ev.length} eventos</span></h2>
<ol class="tl">${tl}</ol>
<script>document.querySelectorAll('a[href*="key=KEY"]').forEach(a=>{a.href=a.href.replace('KEY',encodeURIComponent(new URLSearchParams(location.search).get('key')))})</script>
</body></html>`;
}

async function exportCsv(what, env) {
  const table = { visitors: 'visitors', events: 'events', waitlist: 'waitlist' }[what];
  if (!table) return new Response('what inválido', { status: 400 });
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 20000`).all();
  if (!results.length) return new Response('', { headers: { 'Content-Type': 'text/csv' } });
  const cols = Object.keys(results[0]);
  const q = v => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = [cols.join(','), ...results.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
  return new Response('﻿' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${table}.csv"` } });
}
