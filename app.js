/* ClaudeMobileBridge PWA 셸 — P0-b
 * 탭 전환 + 연결상태 폴링(FULL/DESIGN 자동 분기) + 설정 렌더.
 * daemon 미연결 시 자동 DESIGN 모드. (daemon 은 P1 에서 실물.)
 */
'use strict';

// E4 (2026-06-12) — 전역 에러 가시화: 폰엔 devtools 없음 → 어떤 JS 사망도 토스트로 즉시 보임 (진단 공백 재발 방지).
// toast() 정의 전 에러도 잡도록 DOM 직접 (sync onerror + async unhandledrejection 한 쌍 — MDN).
(function () {
  function showErr(msg) {
    try {
      let el = document.getElementById('cmbErr');
      if (!el) {
        el = document.createElement('div'); el.id = 'cmbErr';
        el.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:9999;background:#5c1f1f;color:#ffd7d2;border:1px solid #a33;border-radius:10px;padding:8px 12px;font-size:12px;word-break:break-all';
        el.addEventListener('click', () => el.remove());
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = '⚠️ 앱 오류 (탭하면 닫힘): ' + msg;
    } catch (_) {}
  }
  window.addEventListener('error', (e) => showErr(e.message || String(e.error || 'unknown')));
  window.addEventListener('unhandledrejection', (e) => showErr('(async) ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')));
})();

// daemon 베이스 주소: 환경설정 저장값 우선 → 없으면 접속 방식으로 추정.
//  - daemon 직접 서빙(port 8787 또는 ts.net): origin 이 곧 daemon.
//  - 외부 호스팅(GitHub Pages 등): 저장값 없으면 빈 값 → DESIGN 모드 진입.
//  - https 페이지에 저장값이 http면 mixed-content 차단 → 무시.
function daemonBase() {
  const saved = localStorage.getItem('daemonBase');
  if (saved && !(location.protocol === 'https:' && saved.startsWith('http:'))) return saved;
  if (location.port === '8787') return `${location.protocol}//${location.hostname}:8787`;
  if (location.hostname.endsWith('.ts.net')) return location.origin;
  return '';
}

// A1 — daemon 인증 토큰(config.auth.token 설정 시). ws 에 ?token= 첨부. 빈 값=현행(Tailscale-only). 폰에서 1회 설정: localStorage.cmbToken
function cmbToken() { return localStorage.getItem('cmbToken') || ''; }
function tokenQ() { const t = cmbToken(); return t ? `?token=${encodeURIComponent(t)}` : ''; }
// A1b — daemon fetch 래퍼: 토큰 설정 시 X-CMB-Token 헤더 자동 첨부(http API 인증). 전 daemon fetch 가 이걸 경유.
function dfetch(url, opts) {
  opts = opts || {};
  const t = cmbToken();
  const headers = { ...(opts.headers || {}) };
  if (t) headers['X-CMB-Token'] = t;
  return fetch(url, { ...opts, headers });
}

// 강제 새로고침 — sw 캐시 전삭제 + sw 갱신 후 리로드. PWA 가 옛 코드 캐시를 붙잡고 있을 때 크롬 강제새로고침처럼 비움.
async function forceRefresh() {
  try { toast('🔄 강제 새로고침 — 캐시 비우는 중…'); } catch (_) {}
  try {
    if ('serviceWorker' in navigator) {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map((r) => r.update()));
    }
    const ks = await caches.keys();
    await Promise.all(ks.map((k) => caches.delete(k)));
  } catch (_) {}
  setTimeout(() => location.reload(), 350);
}

// ── 연결 상태 폴링 (C80-P04) ──────────────────────────────
// P2: 자동 polling — visibility-aware + ws 라이브 시 skip + 상태 변경 자동 UI 갱신
const POLL_INTERVAL_MS = 20000; // 20초 — UX(반응성) ↔ 배터리/네트워크 균형
const HEALTH_TIMEOUT_MS = 7000; // 셀룰러+Tailscale DERP 릴레이 첫 패킷 여유 (옛 2500 = 외부망 false-offline 원인 — 2026-06-04 fix)
let POLL_TIMER = null;
let LAST_ONLINE = null; // 첫 호출 = null, 이후 boolean — 변경 감지

// 단일 base /health probe (timeout abort). 성공=true.
async function probeHealth(base, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await dfetch(`${base}/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}

// health 후보 목록 — 현재 base → (https면) origin → 캐시된 reachable(/config). 집 LAN↔셀룰러 주소 mismatch 방어.
function healthCandidates() {
  const seen = new Set(); const list = [];
  const add = (u) => { if (!u) return; u = u.replace(/\/$/, ''); if (!seen.has(u)) { seen.add(u); list.push(u); } };
  add(daemonBase());
  if (location.protocol === 'https:') add(location.origin);
  try { JSON.parse(localStorage.getItem('cmbReachable') || '[]').forEach(add); } catch (_) {}
  // https 페이지에선 http 후보 = mixed-content 차단 → 제거
  return location.protocol === 'https:' ? list.filter((u) => !u.startsWith('http:')) : list;
}

// /config 의 reachable 후보를 캐시(폰 fallback bootstrap) — fire-and-forget.
// R1 (2026-06-13) — 덮어쓰기 → 합집합 merge: peers 없는 옛 daemon 과 연결돼도 이미 배운 다른 PC 주소 보존 (로밍 영구).
function cacheReachableFrom(base) {
  dfetch(`${base}/config`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((c) => {
    if (!c || !Array.isArray(c.reachable) || !c.reachable.length) return;
    let prev = [];
    try { prev = JSON.parse(localStorage.getItem('cmbReachable') || '[]'); } catch (_) {}
    const seen = new Set(); const merged = [];
    [...c.reachable, ...prev].forEach((u) => { u = String(u).replace(/\/$/, ''); if (u && !seen.has(u)) { seen.add(u); merged.push(u); } });
    localStorage.setItem('cmbReachable', JSON.stringify(merged.slice(0, 12)));   // cap — 일회용 터널 URL 누적 방지
  }).catch(() => {});
}

async function checkHealth(opts = {}) {
  const banner = document.getElementById('statusBanner');
  const text = document.getElementById('statusText');
  // 첫 호출 또는 사용자 명시 새로고침일 때만 checking 표시(폴링 노이즈 회피)
  if (LAST_ONLINE === null || opts.manual) {
    banner.dataset.mode = 'checking';
    text.textContent = '상태 확인 중…';
  }
  // 후보 순차 probe — 첫 성공을 winner 로 채택+persist(다음부터 그 주소 우선). 단일 주소 fail=오프라인 오판 방지.
  let online = false;
  for (const base of healthCandidates()) {
    if (await probeHealth(base, HEALTH_TIMEOUT_MS)) {
      online = true;
      const cur = daemonBase().replace(/\/$/, '');
      const switched = base !== cur;
      if (switched) {
        localStorage.setItem('daemonBase', base);   // 도달된 주소로 전환(외부망에서 집 LAN 주소 버림 / 꺼진 PC → 켜진 PC 로밍)
        toast(`🔁 daemon 전환: ${base}`);
      }
      // R1 (2026-06-13) — reachable 캐시 신선화: 옛 "빈 값일 때만" = 한 번 캐시되면 영구 stale → 다른 PC(peers) 주소 영영 못 배움.
      // 전환 시 + 수동 ⟳ 시 + 빈 값일 때 재캐시 (daemon 의 /config reachable 엔 config.peers = 다른 PC 주소 포함).
      if (switched || opts.manual || !localStorage.getItem('cmbReachable')) cacheReachableFrom(base);
      break;
    }
  }
  // 변경 감지 → 토스트
  const changed = LAST_ONLINE !== online;
  if (LAST_ONLINE !== null && changed) {
    toast(online ? '🟢 PC 깨어남 — FULL 모드' : '🌙 PC 꺼짐 — 설계 모드');
  }
  LAST_ONLINE = online;
  applyMode(online);              // 항상 호출 — checking(노랑) 표시 후 결과가 직전과 같아도 색 복원(노랑불 멈춤 버그 수정)
  if (changed) renderFab(currentTab());
  return online;
}

// 자동 polling 시작/정지 — visibility/ws 상태에 맞춰
function schedulePoll() {
  if (POLL_TIMER) { clearTimeout(POLL_TIMER); POLL_TIMER = null; }
  // ws 라이브 세션 중이거나, 폰 화면이 백그라운드면 polling skip
  if (document.hidden) return;
  if (hasLiveSession()) return; // 라이브 세션 있으면 ws onclose 가 health 트리거
  POLL_TIMER = setTimeout(async () => { await checkHealth(); schedulePoll(); }, POLL_INTERVAL_MS);
}

function applyMode(online) {
  const banner = document.getElementById('statusBanner');
  const text = document.getElementById('statusText');
  if (online) {
    banner.dataset.mode = 'full';
    text.textContent = 'PC 연결됨 (FULL)';
    document.querySelector('.full-only').hidden = false;
    document.getElementById('dashOffline').hidden = true;
    loadDashboard(); // FULL 진입 시 승인대기+작업목록+결정필요+라이브 갱신
    flushOutbox();   // V2 — PC-off 동안 보관한 설계(전송 대기) 자동 전송
  } else {
    banner.dataset.mode = 'design';
    text.textContent = 'PC 꺼짐 — 설계 모드';
    document.querySelector('.full-only').hidden = true;
    document.getElementById('dashOffline').hidden = false;
  }
  if (currentTab() === 'design') loadInbox();   // V2 — 설계 탭은 모드 무관 항상 렌더(off=캐시+전송대기)
}

// ★ 2026-05-31 — bg jobs — active / archived 분리 + origin badge (📱 mobile / 🖥 pc) + attached restore
function jobCardHtml(it) {
  const stateBadge = ({
    working: '🟢 working', done: '✓ done', blocked: '⏸ blocked',
    waiting: '⏳ waiting', idle: '💤 idle', failed: '❌ failed',
    cancelled: '⊘ cancelled', error: '⚠️ error', completed: '✓ completed',
  })[it.state] || it.state;
  const originBadge = it.origin === 'mobile' ? '📱' : '🖥';
  const originLabel = it.origin === 'mobile' ? 'mobile' : 'pc';
  const detail = (it.detail || it.intent || '').slice(0, 100);
  const elapsed = Math.floor((Date.now() - it.updatedMs) / 60000);
  const elapsedStr = elapsed < 60 ? `${elapsed}분 전` :
    elapsed < 1440 ? `${Math.floor(elapsed / 60)}시간 전` :
    `${Math.floor(elapsed / 1440)}일 전`;
  // ★ 멀티세션 — 이 job 이 현재 PWA 라이브 세션이면 (이름 매칭) 📞 + tap 시 그 세션으로 restore
  const matchS = sessionByName(it.name);
  const isAttached = !!matchS;
  const attachedBadge = isAttached ? '<span class="attached-badge">📞 진행 중 — 탭으로 복귀</span>' : '';
  const dataAttr = isAttached ? ` data-attached="1" data-sid="${matchS.sid}"` : ` data-jobname="${it.name}"`;
  return `<div class="card job-card"${dataAttr}><strong>${originBadge} ${it.name}</strong><span class="dim">${stateBadge} · ${originLabel} · ${it.id} · ${elapsedStr}</span>${attachedBadge}<div class="dim" style="font-size:12px">${detail}</div></div>`;
}

// §C — 모바일 설계 스펙 카드 (대시보드 합류) + claim/complete 공용 헬퍼 (loadInbox / onJobCardTap 공유)
function specCardHtml(s) {
  const st = { pending: '⏳ 대기', claimed: '🔵 진행 중', running: '🔵 진행 중', blocked: '⛔ 막힘' }[s.status] || '⏳ 대기';
  const env = (s.targetEnv && s.targetEnv !== 'any') ? ` · ${s.targetEnv}` : '';
  const by = s.claimedBy ? ` (${s.claimedBy})` : '';
  // 결정필요 3버튼: ▶ 진행(persist 관리형 세션 + 즉시 열람) / task_save(task md 승격) / 정리(완료·archive)
  const btn = '<div class="task-actions">'
    + `<button class="qr-btn" data-run="${s.id}">${svgi('play')} 진행</button>`
    + `<button class="qr-btn" data-tasksave="${s.id}">${svgi('save')} task_save</button>`
    + `<button class="qr-btn qr-danger" data-clean="${s.id}">${svgi('trash')} 정리</button></div>`;
  // F4 S4 — 옛 신념 기반 배지 (kbStamp ≠ 현행 GMD 해시 — PC 이어받기 시 현행 신념 재검토 필요)
  const stale = s.kbStale ? ' <span class="pill pill-wait">⚠ 옛 신념 기반</span>' : '';
  return `<div class="card spec-card"><strong>${svgi('smartphone')} ${s.title}</strong>${stale}<span class="dim">설계 · ${st}${by}${env}</span>${btn}</div>`;
}

async function specAction(ep, id, reload) {
  try {
    const r = await dfetch(`${daemonBase()}${ep}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    const res = await r.json();
    if (res && res.ok === false) toast(`⚠️ ${res.reason === 'already_claimed' ? '이미 다른 PC 가 진행 중' : (res.reason === 'not_found' ? '스펙 없음' : (res.reason === 'exists_in_inbox' ? '이미 작업 목록에 있음' : res.reason))} ${res.claimedBy ? '(' + res.claimedBy + ')' : ''}`);
    else if (res && res.ok && res.status === 'running') toast(`▶ PC 에서 "${res.title || ''}" 창 띄움 — PC 앞에서 이어받기`);
    else if (res && res.ok && res.savedTo) toast(`💾 task md 로 저장 — "${res.savedTo}" (작업 목록에 뜸)`);
    else if (res && res.ok && res.envMatch === false) toast(`⚠️ 이 설계는 ${res.targetEnv} 대상인데 ${res.claimedBy} 가 가져감 — 환경 확인`);
    else if (res && res.ok && res.restored !== undefined) toast('🔄 부활 — 다시 작업 목록에 떴어요');
    else if (res && res.ok) toast('✓ 처리됨');
  } catch (_) { toast('⚠️ 처리 실패 — daemon 확인'); }
  if (reload) reload();
}

// ② 결정필요 spec 버튼: 이어서(PC 창)/task_save(task md 승격)/정리(완료)
async function onSpecTap(e) {
  const run = e.target.closest('[data-run]');
  const ts = e.target.closest('[data-tasksave]');
  const cl = e.target.closest('[data-clean]');
  if (run) { newSession({ runSpec: run.dataset.run }); return; }   // ▶ 이어서 = 폰 터미널에서 (PC 창 X)
  if (ts) return specAction('/inbox/tasksave', ts.dataset.tasksave, () => { loadSpecs(); loadSessions(); });
  if (cl) return specAction('/inbox/complete', cl.dataset.clean, loadSpecs);
}

// 📞 라이브 터미널 카드 tap = 그 세션으로 복귀
function onLiveTap(e) {
  const msg = e.target.closest('[data-msg]');   // C — 💬 지시 버튼 먼저(복귀보다 우선, 버블링 가드)
  if (msg) { sendDirective(msg.dataset.msg); return; }
  const w = e.target.closest('[data-watch]');   // E3 — 👀 보기: daemon pty 에 reattach 해 진행상황 열람
  if (w) { openByNameOrAttach(w.dataset.watch); return; }
  const card = e.target.closest('[data-attached]');
  if (card) restoreTerminal(Number(card.dataset.sid));
}

// (legacy onJobCardTap — 미사용, 안전 보존)
async function onJobCardTap(e) {
  const card = e.target.closest('.job-card');
  if (!card) return;
  if (card.dataset.attached === '1') {
    restoreTerminal(Number(card.dataset.sid));
  } else {
    // 본인 PWA spawn 영역 외 = PC Agent Launcher 영역 안내 (claude.exe attach 명령이 node-pty 환경 X — 옛 검증)
    toast(`ℹ️ "${card.dataset.jobname}" 은 PC Agent Launcher 에서 attach`);
  }
}

// E5 (2026-05-31) — 빈 상태 (아이콘 + 제목 + 힌트 → FAB 1차 액션 유도)
function emptyHtml(icon, title, hint) {
  return `<div class="empty empty-rich"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-hint">${hint}</div></div>`;
}

// D10 (2026-06-12) — SVG 라인 아이콘 (index.html sprite 참조). 이모지 chrome 아이콘 통일 — OS emoji font 무관 + currentColor.
function svgi(id) { return `<svg class="svgi" aria-hidden="true"><use href="#i-${id}"/></svg>`; }

// ── V2 (2026-06-11) — ⚠️ 승인 센터: 외출 중 승인 대체제 (PC-on 폰 역할 ①) ──────
// daemon /prompts = 승인 대기 중인 세션 목록. 알림 못 받았어도 대시보드 열면 바로 보임.
// 일반 프롬프트 = [✅ 승인][❌ 거부][💬 지시][👀 열기] / 위험(danger) = blind 승인 차단 → 열어서 컨텍스트 확인.
async function loadPrompts() {
  const wrap = document.getElementById('promptWrap');
  const el = document.getElementById('promptList');
  if (!wrap || !el) return;
  let items = [];
  try { const r = await dfetch(`${daemonBase()}/prompts`, { cache: 'no-store' }); if (r.ok) items = await r.json(); } catch (_) {}
  if (!items.length) { wrap.hidden = true; el.innerHTML = ''; return; }
  wrap.hidden = false;
  el.innerHTML = items.map((p) => {
    const age = Math.max(0, Math.floor((Date.now() - (p.ts || Date.now())) / 60000));
    const txt = slEscHtml((p.text || '').slice(0, 180));
    // F2 (2026-06-12) — 직전 출력 tail 미리보기 (stripAnsi ~10줄, daemon ptyTail): 열지 않고 "무엇을 승인하는지" 컨텍스트.
    //   danger 카드일수록 중요 → danger 는 기본 펼침. progressive disclosure (<details>) 로 카드 비대화 회피.
    const tail = (p.tail || '').trim();
    const tailHtml = tail ? `<details class="prompt-tail"${p.danger ? ' open' : ''}><summary>직전 출력 보기</summary><pre>${slEscHtml(tail)}</pre></details>` : '';
    // D8 — Toss 단일 행동 위계: 승인 = filled 1차 / 거부 = 빨강 / 지시·열기 = ghost 보조. danger = 기존 가드 불변 (blind approve 차단)
    const btns = p.danger
      ? `<button class="qr-btn qr-danger" data-popen="${p.name}">${svgi('eye')} 열어서 확인 (위험)</button><button class="qr-btn qr-no" data-preject="${p.name}">${svgi('x')} 거부</button>`
      : `<button class="qr-btn qr-yes" data-papprove="${p.name}">${svgi('check')} 승인</button><button class="qr-btn qr-no" data-preject="${p.name}">${svgi('x')} 거부</button><button class="qr-btn qr-aux" data-pmsg="${p.name}">${svgi('msg')} 지시</button><button class="qr-btn qr-aux" data-popen="${p.name}">${svgi('eye')} 열기</button>`;
    return `<div class="card prompt-card"><strong class="${p.danger ? 'ic-danger' : 'ic-warn'}">${svgi(p.danger ? 'flame' : 'alert')} ${p.name}</strong><span class="dim">${age}분째 대기 · ${p.kind === 'menu' ? '선택 메뉴' : 'y/n'}</span><div class="dim prompt-text">${txt}</div>${tailHtml}<div class="task-actions">${btns}</div></div>`;
  }).join('');
}

async function promptReply(name, action) {
  try {
    const r = await dfetch(`${daemonBase()}/push/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action }),
    });
    const res = await r.json();
    // E8 — 실제 보낸 키(y/1/Esc) echo: "뭘 보냈는지" 투명 (서버 키스트로크 규칙과 동일 매핑)
    if (res && res.ok) {
      haptic(25);
      const key = action === 'approve' ? (res.kind === 'menu' ? '1↵' : 'y↵') : (res.kind === 'yn' ? 'n↵' : 'Esc');
      toast(`${action === 'approve' ? '✅ 승인' : '❌ 거부'} 전송 — 키 ${key}`);
    }
    else toast(`⚠️ ${(res && res.reason) || '전송 실패'}`);
  } catch (_) { toast('⚠️ 전송 실패 — daemon 확인'); }
  setTimeout(loadPrompts, 800);
}

// 이름으로 세션 열기 — 이미 붙어있으면 복귀, 아니면 daemon pty 에 reattach (관리형/persist 세션 포함)
function openByNameOrAttach(name) {
  if (!openSessionByName(name)) newSession({ reattachName: name });
}

function onPromptTap(e) {
  const a = e.target.closest('[data-papprove]'); if (a) return promptReply(a.dataset.papprove, 'approve');
  const r = e.target.closest('[data-preject]'); if (r) return promptReply(r.dataset.preject, 'reject');
  const m = e.target.closest('[data-pmsg]'); if (m) return sendDirective(m.dataset.pmsg);
  const o = e.target.closest('[data-popen]'); if (o) return openByNameOrAttach(o.dataset.popen);
}

// ② 결정 필요 — 모바일에서 만든 작업(spec)만. bg jobs(~/.claude/jobs)는 사용자 혼란이라 대시보드서 제거(2026-05-31).
async function loadSpecs() {
  const el = document.getElementById('specList');
  if (!el) return;
  try {
    const r = await dfetch(`${daemonBase()}/inbox`, { cache: 'no-store' });
    const specs = r.ok ? (await r.json()).filter((s) => s.status !== 'done' && s.status !== 'archived') : [];
    // E14 — 결정 필요(pending) 개수를 설치 PWA 앱 아이콘 배지로 (iOS 16.4+ PWA·데스크탑 지원 / Android Chromium 무동작 → Web Push 가 OS 배지 유도)
    if ('setAppBadge' in navigator) { try { specs.length ? navigator.setAppBadge(specs.length) : navigator.clearAppBadge(); } catch (_) {} }
    el.innerHTML = specs.length ? specs.map(specCardHtml).join('')
      : emptyHtml('📱', '모바일에서 만든 작업이 없어요', '설계 탭에서 ✎ 캡처하면 여기 떠요');
  } catch (_) { el.innerHTML = emptyHtml('⚠️', 'daemon 연결 안 됨', '상단 ⟳ 로 새로고침'); }
}

// 📞 진행 중 작업 — E3 (2026-06-12 사용자 명시): 폰 attach 세션 + daemon 의 모든 라이브 pty(/ptys)
// (스펙 ▶ 진행 / 🚀 task / pc-alias 세션) 합쳐 표시. 미부착은 👀 보기 = reattach 로 진행상황 열람.
async function loadLive() {
  const wrap = document.getElementById('liveWrap');
  const el = document.getElementById('liveList');
  if (!wrap || !el) return;
  let ptys = [];
  try { const r = await dfetch(`${daemonBase()}/ptys`, { cache: 'no-store' }); if (r.ok) ptys = await r.json(); } catch (_) {}
  const attached = new Set([...SESSIONS.values()].map((s) => s.name));
  const cards = [...SESSIONS.values()].map((s) =>
    `<div class="card job-card" data-attached="1" data-sid="${s.sid}"><strong>${svgi('phone')} ${s.name}</strong><span class="pill pill-call">연결됨 · 탭으로 복귀</span><div class="task-actions"><button class="qr-btn qr-aux" data-msg="${s.name}">${svgi('msg')} 지시</button></div></div>`
  );
  for (const p of (Array.isArray(ptys) ? ptys : [])) {
    if (attached.has(p.name)) continue;   // 이미 폰에 붙어있으면 위 복귀 카드가 담당
    // D7 — GitHub Mobile Live Activities 4-state 어휘: 진행 = 초록 pulse / 승인 대기 = 호박
    const pill = p.promptPending ? '<span class="pill pill-wait">⚠️ 승인 대기 중</span>' : '<span class="pill pill-run">진행 중</span>';
    cards.push(`<div class="card job-card"><strong>${svgi('monitor')} ${p.name}</strong>${pill}<div class="task-actions"><button class="qr-btn" data-watch="${p.name}">${svgi('eye')} 보기</button><button class="qr-btn qr-aux" data-msg="${p.name}">${svgi('msg')} 지시</button></div></div>`);
  }
  if (!cards.length) { wrap.hidden = true; el.innerHTML = ''; return; }
  wrap.hidden = false;
  el.innerHTML = cards.join('');
}

// C (2026-06-04) — attach 없이 라이브 세션에 한 줄 방향 지시 전송 (/push/reply action:message → pty 주입). 승인/거부와 별개.
async function sendDirective(name) {
  const text = await editPrompt(`💬 "${name}" 에 방향 지시 (한 줄 전송 — 승인 아님)`, '');
  if (text == null || !text.trim()) return;
  try {
    const r = await dfetch(`${daemonBase()}/push/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action: 'message', text }),
    });
    const res = await r.json();
    toast(res && res.ok ? '💬 지시 전송됨' : `⚠️ ${(res && res.reason) || '전송 실패'}`);
  } catch (_) { toast('⚠️ 전송 실패 — daemon 확인'); }
}

// 대시보드 일괄 갱신 (승인 대기 + 작업목록 task md + 결정필요 spec + 라이브 터미널 + 완료 bg 부활)
function loadDashboard() { loadPrompts(); loadSessions(); loadSpecs(); loadLive(); loadBgArchived(); loadArrivalCard(); }

// ③ 완료된 bg 작업 — 🔄 부활 (2026-06-04, 사용자 명시 "토큰착취 부활").
//   bg jobs active 목록은 혼란이라 안 띄우고(2026-05-31 제거 유지), *완료(archived)분만* collapsible drawer.
//   부활 = intent 로 새 bridge(daemon pty) 세션 — 사용자가 보며 진행(자율 재실행 X). 구독토큰 pty.
let BG_ARCHIVED = [];   // 최신 archived 목록 (click 핸들러가 closure 대신 이 모듈 변수 참조 — stale 회피)
async function loadBgArchived() {
  const wrap = document.getElementById('bgArchivedWrap');
  const el = document.getElementById('bgArchivedList');
  if (!wrap || !el) return;
  try { const r = await dfetch(`${daemonBase()}/jobs`, { cache: 'no-store' }); BG_ARCHIVED = (r.ok ? ((await r.json()).archived || []) : []); }
  catch (_) { BG_ARCHIVED = []; }
  if (!BG_ARCHIVED.length) { wrap.hidden = true; el.innerHTML = ''; return; }
  wrap.hidden = false;
  el.innerHTML = `<details class="arch-group"><summary class="dim">✓ 완료된 bg 작업 (${BG_ARCHIVED.length}) — 탭하면 펼침 · 🔄 부활 가능</summary>`
    + BG_ARCHIVED.map((it) => {
        const org = it.origin === 'mobile' ? svgi('smartphone') : svgi('monitor');
        const intent = (it.intent || it.detail || '(intent 없음)').slice(0, 80);
        return `<div class="card job-card"><strong>${org} ${it.name}</strong><span class="dim">✓ ${it.state} · ${it.id}</span><div class="dim" style="font-size:12px">${intent}</div> <button class="qr-btn" data-revive-job="${it.id}">🔄 부활</button></div>`;
      }).join('')
    + '</details>';
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('click', (e) => {
      const rb = e.target.closest('[data-revive-job]');
      if (!rb) return;
      const job = BG_ARCHIVED.find((x) => x.id === rb.dataset.reviveJob);
      if (!job) { toast('⚠️ 작업 정보 없음 — 새로고침'); return; }
      const intent = (job.intent || job.detail || '').trim();
      if (!intent && !confirm('이 작업은 intent 가 비어있어요. 빈 세션으로 부활할까요?')) return;
      toast('🔄 부활 — 새 터미널에서 이어서 (사용자 주시)');
      newSession({ prompt: intent || `이전 bg 작업 "${job.name}" 이어서 진행`, cwd: job.cwd || undefined, name: (job.name || 'bg') + '-rv' });
    });
  }
}

// #2 (2026-05-31) — task md 목록(tasks/active) = 대시보드 상단 카드 + 🚀 진행 (PC Agent Launcher 진행 버튼 모바일판)
async function loadSessions() {
  const el = document.getElementById('sessionList');
  if (!el) return;
  // D6 (2026-06-12) — 첫 로드만 카드형 스켈레톤 (NN/g: 최종 레이아웃과 모양 일치, 폴링 재로드 시 X)
  if (!el.dataset.loaded) el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try {
    const r = await dfetch(`${daemonBase()}/sessions`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const items = await r.json();
    if (!items.length) { el.innerHTML = ''; el.dataset.loaded = '1'; return; }
    el.innerHTML = items.map((it) => {
      const pct = it.progress ? it.progress.pct : 0;
      const prog = it.progress ? `${it.progress.pct}% · ${it.progress.done}/${it.progress.total}` : '';
      return `<div class="card task-card"><strong>${svgi('file')} ${it.title}</strong>`
        + `<span class="dim">${it.status || 'ALIVE'}${prog ? ' · ' + prog : ''}</span>`
        + `<div class="task-bar"><div class="task-bar-fill" style="width:${pct}%"></div></div>`
        + `<div class="task-actions"><button class="qr-btn" data-runtask="${it.id}">${svgi('rocket')} 진행</button></div></div>`;
    }).join('');
    el.dataset.loaded = '1';
  } catch (_) { el.innerHTML = ''; el.dataset.loaded = '1'; }
}

// 가벼운 토스트 (브라우저 Notification 권한 회피 — DOM only)
function toast(msg) {
  let el = document.getElementById('cmbToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cmbToast';
    el.className = 'cmb-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── 탭 전환 (C80-P01) ─────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  renderFab(name);
  if (name === 'dashboard') loadDashboard();
  if (name === 'design') loadInbox();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

// ── 하단 1차 액션 (C80-P03) ──────────────────────────────
// V2 (2026-06-11) — 대시보드 FAB 제거: 폰에서 freeform 새 bg/세션 생성 X (사용자 명시).
//   폰의 "만들기" = 설계 캡처/붙여넣기 뿐 — 실행 진입은 스펙 ▶ 진행 / task md 🚀 진행.
function renderFab(name) {
  const bar = document.getElementById('fabBar');
  bar.innerHTML = '';
  if (name === 'design') {
    bar.appendChild(mkBtn(`${svgi('pen')} 아이디어 캡처`, 'btn-primary', captureDesign));
    bar.appendChild(mkBtn(`${svgi('clipboard')} 스펙 붙여넣기`, 'btn-ghost', pasteSpec));
  }
}

// D10 — label 은 정적 문자열만 (innerHTML — svgi 아이콘 포함 가능. 사용자 입력 넣지 말 것)
function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.innerHTML = label; b.addEventListener('click', onClick);
  return b;
}

let CFG = null; // 최근 /config 결과 캐시
let KB_SELFTEST = null; // DK12 — 마지막 설계 KB self-test 결과

// Project URL: 사용자 설정(localStorage) 우선, 없으면 daemon config
// V2.1 (2026-06-12) — placeholder/무효 URL 가드: config.example 의 'https://claude.ai/project/<id>' 가
// live config 에 그대로 남으면 "설정됨" 오판 → 쓰레기 URL 이동 → claude.ai 무한 로딩 (실측). 무효 = 미설정 취급 → 마법사.
function validProjectUrl(u) { return (u && /^https:\/\//.test(u) && !u.includes('<')) ? u : ''; }
function projectUrl() {
  const p = (typeof kbActiveProfile === 'function') ? kbActiveProfile() : null;
  if (p && validProjectUrl(p.projectUrl)) return validProjectUrl(p.projectUrl);
  return validProjectUrl(localStorage.getItem('projectUrl')) || validProjectUrl(CFG?.design?.projectUrl) || '';
}
// (V2 2026-06-11 — 옛 Apps Script 경로 제거: 미설정 dead-end + 셋업 마찰. PC-off write = 폰 outbox 가 대체.)
// DK3 (belief-agnostic KB 포인터) — PC-off 설계가 읽을 KB 폴더(Drive folderId) + 매니페스트 파일명. 폴더 교체 = 다른 KB(지인). 빈 값 = 미설정(현행 안 깨짐).
// 실 KB read 는 claude.ai Project 커넥터(클라우드)가 수행 — 이 포인터는 *설정/참조*용(같은 folderId 를 Project 커넥터에도 연결). DK4/DK7 이 소비.
// DK7 — 다중 KB 프로필. localStorage.kbProfiles(JSON 배열 [{label,folderId,manifest,projectUrl}]) 또는 CFG.design.profiles. 활성 1개 = kbActiveProfile.
// 프로필 없으면 DK3 단일 설정(kbFolderId/kbManifest)으로 fallback → 현행/단일 모드 안 깨짐(backward-compatible).
function kbProfiles() {
  try { const ls = localStorage.getItem('kbProfiles'); const a = ls ? JSON.parse(ls) : (CFG?.design?.profiles); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function kbActiveIdx() {
  const n = kbProfiles().length; if (!n) return -1;
  let i = parseInt(localStorage.getItem('kbActiveProfile') || '0', 10);
  if (isNaN(i) || i < 0 || i >= n) i = 0;
  return i;
}
function kbActiveProfile() { const i = kbActiveIdx(); return i < 0 ? null : kbProfiles()[i]; }
function kbFolderId() { const p = kbActiveProfile(); if (p && p.folderId) return p.folderId; return localStorage.getItem('kbFolderId') || CFG?.design?.knowledge?.folderId || ''; }
function kbManifest() { const p = kbActiveProfile(); if (p && p.manifest) return p.manifest; return localStorage.getItem('kbManifest') || CFG?.design?.knowledge?.manifest || 'DESIGN_MANIFEST.md'; }
// DK4 — 캡처를 KB-aware 로: 설정된 KB 포인터(DK3/활성 프로필 DK7)를 스펙 body 에 *참조*로 실어 PC(/PW_resume) 또는 Project 가 어느 매니페스트를 로드·준수할지 알게.
// folderId 미설정이면 빈 문자열 = 현행 동일(안 깨짐). 폴더/프로필만 바꾸면 다른 KB(지인) 지시가 자동으로 실림 — 내 경로 박지 X.
function kbContextLine() {
  const fid = kbFolderId();
  if (!fid) return '';
  const man = kbManifest();
  const lbl = ((kbActiveProfile()?.label) || CFG?.design?.knowledge?.label || '').trim();
  return `\n\n## 설계 KB (belief-agnostic)\n- 폴더(Drive): ${fid}${lbl ? ` (${lbl})` : ''}\n- 매니페스트: ${man}\n- 지시: 위 폴더의 ${man} 를 읽고 거기 선언된 rules/beliefs/skills/tools 를 준수해 설계.`;
}
// E11 (R2) — 클라(폰) ULID: server.js ulid() 와 동일 알고리즘 (PC-off Apps Script 경로의 충돌-0 id).
const CLIENT_ULID_ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function clientUlid() {
  let t = Date.now(), ts = '';
  for (let i = 0; i < 10; i++) { ts = CLIENT_ULID_ENC[t % 32] + ts; t = Math.floor(t / 32); }
  let r = '';
  for (let i = 0; i < 16; i++) r += CLIENT_ULID_ENC[Math.floor(Math.random() * 32)];
  return ts + r;
}
// ── 🅳 Web Push (카톡식 알림 — 앱 닫혀도 알림 드로어) ──────────────────────
// 선결: https(secure context) 필수 — http Tailscale IP 는 막힘. tailscale serve 8787 → ts.net 주소로 접속.
function pushLabel() {
  if (!('Notification' in window) || !('PushManager' in window)) return '미지원';
  if (!window.isSecureContext) return '⚠ https 필요 (ts.net)';
  if (Notification.permission === 'granted') return localStorage.getItem('pushSubscribed') === '1' ? '✓ 켜짐' : '권한됨 (탭하여 구독)';
  if (Notification.permission === 'denied') return '✗ 차단됨 (브라우저 설정에서 허용)';
  return '꺼짐 (탭하여 켜기)';
}
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('이 브라우저는 푸시 미지원'); return; }
  if (!window.isSecureContext) { toast('⚠ https 필요 — PC 에서 "tailscale serve 8787" 후 ts.net 주소로 접속'); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('알림 권한 거부됨'); renderSettings(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const vr = await dfetch(`${daemonBase()}/push/vapid`, { cache: 'no-store' });
    const v = await vr.json();
    if (!v.ok || !v.publicKey) { toast('⚠ daemon 푸시 비활성 — PC 에서 npm install web-push 후 재시작'); return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(v.publicKey) });
    await dfetch(`${daemonBase()}/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    localStorage.setItem('pushSubscribed', '1');
    toast('🔔 푸시 알림 켜짐 — 승인 필요 시 알림이 옵니다');
    renderSettings();
  } catch (e) { toast('푸시 구독 실패: ' + e.message); }
}
// PWA 열 때마다 조용히 재등록 — daemon 재시작으로 구독이 날아가도 폰 열면 복구(이중 안전: daemon push-subs.json + 이쪽).
async function resyncPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!window.isSecureContext || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await dfetch(`${daemonBase()}/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  } catch (_) {}
}

// ── 설정 렌더 (C80-P05 그룹 리스트) ──────────────────────
// F4 — 미러 신선도 (daemon /mirror — heartbeat 나이. 검출은 시스템이, 사용자는 이 줄만 봄)
let MIRROR = null;
function mirrorLabel() {
  if (!MIRROR || !MIRROR.configured) return '미설정 (PC mirror-sync 1회 실행 시 자동)';
  if (MIRROR.fresh) return `✓ ${Math.round(MIRROR.ageH)}h 전 동기`;
  return `⚠ ${Math.floor(MIRROR.ageH / 24)}일째 멈춤 — 외주설계가 옛 신념일 수 있음`;
}

async function renderSettings() {
  try { const mr = await dfetch(`${daemonBase()}/mirror`, { cache: 'no-store' }); MIRROR = mr.ok ? await mr.json() : null; } catch (_) { MIRROR = null; }
  try {
    const r = await dfetch(`${daemonBase()}/config`, { cache: 'no-store' });
    if (r.ok) {
      CFG = await r.json();
      if (Array.isArray(CFG.reachable) && CFG.reachable.length) localStorage.setItem('cmbReachable', JSON.stringify(CFG.reachable));   // 폰 fallback 후보 갱신
    }
  } catch (_) {}
  const cfg = CFG;
  const g = (id) => document.getElementById(id);
  // edit: 탭하면 prompt 로 localStorage 값 수정
  const row = (ico, label, value, edit) =>
    `<li${edit ? ` data-edit="${edit}"` : ''}><span class="ico">${ico}</span><span class="label">${label}</span><span class="value">${value ?? '미설정'}</span></li>`;

  g('grpKb').innerHTML =
    row(svgi('folder'), 'KB 경로', cfg?.kbPath || '데몬 연결 시 표시') +
    row(svgi('folder'), '프로젝트', cfg ? `${(cfg.projectRoots || []).length}개` : '—') +
    row(svgi('folder'), 'task 경로', cfg?.tasksPath || '—');

  g('grpConn').innerHTML =
    row(svgi('link'), 'daemon 주소', daemonBase(), 'daemonBase') +
    row(svgi('key'), 'daemon 토큰', cmbToken() ? '설정됨' : '미설정 (config.auth.token 과 동일하게)', 'cmbToken') +
    row(document.getElementById('statusBanner').dataset.mode === 'full' ? svgi('zap') : svgi('moon'),
        '상태', document.getElementById('statusText').textContent) +
    row(svgi('bell'), '푸시 알림', pushLabel(), 'pushToggle');

  g('grpDesign').innerHTML =
    row(svgi('bulb'), '설계 셋업 마법사', projectUrl() ? '셋업됨 (탭=다시 보기)' : '미셋업 — 탭 (1회, 2분)', 'wizard') +
    row(svgi('msg'), 'Project 링크', projectUrl() ? '설정됨' : '미설정 (탭)', 'projectUrl') +
    row(svgi('cloud'), 'Drive inbox', cfg?.design?.inboxPath || cfg?.design?.driveInboxFolderId || '미설정') +
    row(svgi('compass'), '설계 KB 폴더', kbFolderId() ? '설정됨' : '미설정 (Drive folderId — belief-agnostic)', 'kbFolderId') +
    row(svgi('file'), 'KB 매니페스트', kbManifest(), 'kbManifest') +
    row(svgi('layers'), 'KB 프로필', (kbProfiles().length ? `${kbActiveProfile()?.label || ('#' + (kbActiveIdx() + 1))} (${kbActiveIdx() + 1}/${kbProfiles().length}, 탭=전환)` : '단일 (DK3 설정 사용)'), 'kbProfileSwitch') +
    row(svgi('pen'), 'KB 프로필 편집', 'JSON 배열', 'kbProfilesJson') +
    row(svgi('search'), '설계 KB 검증', (KB_SELFTEST ? (KB_SELFTEST.ok ? '✅ 통과' : (KB_SELFTEST.partial ? '➖ 부분' : '⚠️ 일부 실패')) : '탭하여 self-test'), 'kbSelftest') +
    row(svgi(MIRROR && MIRROR.configured && !MIRROR.fresh ? 'alert' : 'cloud'), 'KB 미러 신선도', mirrorLabel());
}

// 설정 값 입력 — PWA standalone 에서 window.prompt() 가 무시되는 제약 우회: 앱 내부 커스텀 모달.
// editModal 없으면(옛 셸) prompt() fallback. resolve(값) 또는 resolve(null)=취소.
// opts.preset = { label, value } — 입력칸 위 ghost 버튼 (탭=입력칸 채움). 예: 캡처 내용의 "제목이랑 같음" (2026-06-12 사용자 명시).
function editPrompt(label, cur, opts) {
  return new Promise((resolve) => {
    const m = document.getElementById('editModal');
    if (!m) { resolve(prompt(label, cur)); return; }
    document.getElementById('editLabel').textContent = label;
    const inp = document.getElementById('editInput');
    inp.value = cur || '';
    m.hidden = false;
    setTimeout(() => { inp.focus(); }, 50);
    const okBtn = document.getElementById('editOk');
    const cancelBtn = document.getElementById('editCancel');
    const preBtn = document.getElementById('editPreset');
    const done = (val) => {
      m.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      inp.removeEventListener('keydown', onKey);
      if (preBtn) { preBtn.removeEventListener('click', onPreset); preBtn.hidden = true; }
      resolve(val);
    };
    const onOk = () => done(inp.value);
    const onCancel = () => done(null);
    const onKey = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); done(inp.value); } };
    const onPreset = () => { inp.value = opts.preset.value; inp.focus(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    inp.addEventListener('keydown', onKey);
    if (preBtn && opts && opts.preset) { preBtn.textContent = opts.preset.label; preBtn.hidden = false; preBtn.addEventListener('click', onPreset); }
  });
}

// 설정 행 탭 → 값 편집 (event delegation)
async function onSettingsTap(e) {
  const li = e.target.closest('[data-edit]');
  if (!li) return;
  const key = li.dataset.edit;

  if (key === 'pushToggle') { enableNotifications(); return; }   // 🅳 푸시 알림 켜기/구독
  if (key === 'wizard') { openWizard(); return; }   // V2 — 설계 셋업 마법사

  if (key === 'kbProfileSwitch') {   // DK7 — 활성 KB 프로필 순환 (내 KB ↔ 지인 KB 빠른 전환)
    const arr = kbProfiles();
    if (arr.length < 2) { toast(arr.length ? '프로필 1개 — ✏ 편집에서 추가' : 'KB 프로필 없음 — ✏ 편집에서 JSON 추가'); return; }
    const next = (kbActiveIdx() + 1) % arr.length;
    localStorage.setItem('kbActiveProfile', String(next));
    toast(`KB 프로필 → ${arr[next].label || ('#' + (next + 1))}`);
    renderSettings();
    return;
  }
  if (key === 'kbProfilesJson') {   // DK7 — 프로필 목록 JSON 경량 CRUD (per-필드 모달 대신 배열 1개)
    const cur = localStorage.getItem('kbProfiles')
      || JSON.stringify(CFG?.design?.profiles || [{ label: '내 KB', folderId: '', manifest: 'DESIGN_MANIFEST.md', projectUrl: '' }]);
    const v = await editPrompt('KB 프로필 JSON 배열 [{label,folderId,manifest,projectUrl}]', cur);
    if (v === null) return;
    try {
      const a = JSON.parse(v);
      if (!Array.isArray(a)) throw new Error('not array');
      localStorage.setItem('kbProfiles', JSON.stringify(a));
      localStorage.setItem('kbActiveProfile', '0');
      toast(`KB 프로필 ${a.length}개 저장`); renderSettings();
    } catch (_) { alert('JSON 형식 오류 — [{...}] 배열이어야 함'); }
    return;
  }
  if (key === 'kbSelftest') {   // DK12 — belief-agnostic KB self-test 4색 (alert 안 씀: standalone 차단 회피)
    toast('설계 KB 검증 중…');
    try {
      const r = await dfetch(`${daemonBase()}/design/selftest`);
      KB_SELFTEST = await r.json();
      const c = KB_SELFTEST.checks || {};
      let detail;
      if (KB_SELFTEST.ok) detail = '✅ KB 검증 통과 — ' + ((c.paths && c.paths.msg) || (c.inbox && c.inbox.msg) || '');
      else {
        const fails = Object.keys(c).filter((k) => c[k] && c[k].ok === false).map((k) => `${k}: ${c[k].msg}`);
        detail = '⚠️ KB 검증 — ' + (fails.join(' / ') || '확인 필요');
      }
      renderSettings();
      toast(detail.trim());
    } catch (_) { toast('⚠️ 검증 실패 — PC 연결/daemon 확인'); }
    return;
  }

  // 편집형 (localStorage 키)
  const labels = {
    daemonBase: 'daemon 주소 (http://호스트:8787)',
    cmbToken: 'daemon 인증 토큰 (PC config.auth.token 과 동일 값 입력)',
    projectUrl: 'Claude Project 링크 (https://claude.ai/project/…)',
    kbFolderId: '설계 KB 폴더 Drive ID (PC-off 설계가 읽을 폴더 — 바꾸면 다른 KB. claude.ai Project 커넥터에도 같은 폴더 연결)',
    kbManifest: 'KB 매니페스트 파일명 (기본 DESIGN_MANIFEST.md — 폴더 자기-기술 규약)',
  };
  const cur = localStorage.getItem(key) || (key === 'daemonBase' ? daemonBase() : '');
  const v = await editPrompt(labels[key] || key, cur);
  if (v !== null) { localStorage.setItem(key, v.trim()); renderSettings(); checkHealth(); }
}

// ── inbox 목록 (P3 — daemon /inbox) ──
// V2 (2026-06-11) — 설계 탭은 PC 꺼져도 dead-end 없음: 전송 대기(outbox) + 마지막 동기 캐시(읽기 전용).
async function loadInbox() {
  renderOutbox();   // 📤 전송 대기 — 폰 로컬 (PC 무관)
  renderMirrorBadge();
  renderSkillLauncher();
  const list = document.getElementById('inboxList');
  const note = document.getElementById('inboxNote');
  let items = [], arch = [], live = true;
  try {
    const r = await dfetch(`${daemonBase()}/inbox`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    items = await r.json();
    try { const ra = await dfetch(`${daemonBase()}/inbox/archived`, { cache: 'no-store' }); if (ra.ok) arch = await ra.json(); } catch (_) {}
    localStorage.setItem('cmbInboxCache', JSON.stringify({ ts: Date.now(), items, arch }));   // PC-off 열람용 캐시
    if (note) note.hidden = true;
  } catch (_) {
    live = false;
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem('cmbInboxCache') || 'null'); } catch (_) {}
    items = (cache && cache.items) || [];
    arch = (cache && cache.arch) || [];
    if (note) {
      note.hidden = false;
      note.textContent = cache
        ? `🌙 PC 꺼짐 — ${new Date(cache.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 동기 목록 (읽기 전용). 새 캡처는 📤 전송 대기로 보관 → PC 켜지면 자동 전송.`
        : '🌙 PC 꺼짐 — 새 캡처는 📤 전송 대기로 보관되고, PC 켜지면 자동 전송됩니다.';
    }
  }
  if (!items.length && !arch.length) {
    list.innerHTML = emptyHtml('📝', '캡처된 설계가 없어요', '✎ 아이디어 캡처 또는 🧠 설계 대화로 시작');
    return;
  }
  const activeHtml = items.map((it) => {
    const st = { pending: '⏳ 대기', claimed: '🔵 진행 중', running: '🔵 진행 중', done: '✓ 완료', blocked: '⛔ 막힘', archived: '✓ 완료' }[it.status] || '⏳ 대기';
    const org = it.origin === 'mobile' ? svgi('smartphone') : svgi('monitor');
    const env = (it.targetEnv && it.targetEnv !== 'any') ? ` · ${it.targetEnv}` : '';
    const by = it.claimedBy ? ` (${it.claimedBy})` : '';
    let btn = '';
    if (live) {   // PC-off 캐시 표시 중엔 버튼 X (읽기 전용)
      if (it.status === 'pending' || !it.status) btn = `<div class="task-actions"><button class="qr-btn" data-run="${it.id}">${svgi('play')} 진행</button><button class="qr-btn" data-claim="${it.id}">${svgi('save')} task저장</button></div>`;
      else if (it.status === 'claimed' || it.status === 'running') btn = `<div class="task-actions"><button class="qr-btn" data-open-spec="${it.id}">${svgi('eye')} 보기</button><button class="qr-btn" data-done="${it.id}">완료</button></div>`;
    }
    const staleP = it.kbStale ? ' <span class="pill pill-wait">⚠ 옛 신념 기반</span>' : '';   // F4 S4
    return `<div class="card spec-card"><strong>${org} ${it.title}</strong>${staleP}<span class="dim">${st}${by}${env}</span>${btn}</div>`;
  }).join('');
  const archHtml = arch.length ? (
    live
      ? `<details class="arch-group"><summary class="dim">✓ 완료 (${arch.length}) — 탭하면 펼침 · 🔄 부활 가능</summary>`
        + arch.map((it) => {
          const org = it.origin === 'mobile' ? svgi('smartphone') : svgi('monitor');
          return `<div class="card spec-card"><strong>${org} ${it.title}</strong><span class="dim">✓ 완료</span> <button class="qr-btn" data-revive="${it.id}">🔄 부활</button></div>`;
        }).join('')
        + '</details>'
      : `<div class="dim">✓ 완료 ${arch.length}건 — PC 켜면 부활 가능</div>`
  ) : '';
  list.innerHTML = activeHtml + archHtml;
  // §D — 진행/보기/claim/complete/revive 위임 핸들러 (1회 바인딩)
  if (!list._wired) {
    list._wired = true;
    list.addEventListener('click', (e) => {
      const run = e.target.closest('[data-run]');
      const op = e.target.closest('[data-open-spec]');
      const c = e.target.closest('[data-claim]');
      const d = e.target.closest('[data-done]');
      const rv = e.target.closest('[data-revive]');
      if (run) { newSession({ runSpec: run.dataset.run }); return; }   // V2 — ▶ 진행 = persist 관리형 세션 + 즉시 열람 (PC 창 X)
      if (op) { openByNameOrAttach(sessionNameForSpec(op.dataset.openSpec)); return; }
      if (rv) { specAction('/inbox/revive', rv.dataset.revive, loadInbox); return; }
      if (!c && !d) return;
      specAction(c ? '/inbox/claim' : '/inbox/complete', c ? c.dataset.claim : d.dataset.done, loadInbox);
    });
  }
}

// daemon sessionNameFor('spec', id) 와 동일 규칙 — 진행 중 spec 의 관리형 세션 이름 (👀 보기)
function sessionNameForSpec(id) {
  return ('spec-' + String(id).replace(/[^\w가-힣.-]/g, '_')).slice(0, 60);
}

// DK8 — captureDesign 입력을 native prompt() → editPrompt 모달로. PWA standalone 에서 prompt()/confirm() 은 차단·즉시 null(Chrome JS Dialog Policy). editPrompt = #editModal 사용 + IME 처리(L0-MIM) → 한국어 안정. 어느 단계든 취소(✕)=null 반환→캡처 중단.
async function captureFields() {
  const title = await editPrompt('설계 제목', '');
  if (!title || !title.trim()) return null;
  const env = await editPrompt('실행 환경 (CPMD / PWMD / HMD / any)', 'any');
  if (env === null) return null;
  // 2026-06-12 사용자 명시 — 내용 = 멀티라인(아이디어는 한 줄 아님) + "제목이랑 같음" preset (제목칸에 내용을 쓴 경우 중복 입력 회피)
  const body = await editText('아이디어 / 의도 (PC 가 이어받아 실행할 작업)', '', { preset: { label: '제목이랑 같음', value: title.trim() } });
  if (body === null) return null;
  return { title: title.trim().slice(0, 80), targetEnv: (env.trim() || 'any'), body };
}

// 2026-06-12 사용자 명시 — 저장 직전 제목 재추천 (PW_save 의 slug 추천 패턴).
// PC-off 라 LLM 없음 → 본문 첫 머리글/첫 문장 휴리스틱 (정직: PW_save 만큼 똑똑하진 않음 — 제목칸에 내용을 쓴 케이스 보정용).
function suggestTitle(f) {
  const body = (f.body || '').trim();
  if (!body || body === f.title) return '';
  const h = body.match(/^#+\s*(.+)$/m);
  let s = (h ? h[1] : body.split(/\r?\n/)[0]).trim();
  s = s.replace(/^[-*\d.)\s]+/, '');
  const cut = s.search(/[.!?。]\s/);   // 첫 문장 끝 (lookbehind 회피 — 옛 Safari regex 파싱 안전)
  if (cut >= 0) s = s.slice(0, cut + 1);
  s = s.trim();
  if (s.length > 40) s = s.slice(0, 40).replace(/\s+\S*$/, '') + '…';
  return (s && s !== f.title) ? s : '';
}

// ── V2 (2026-06-11) — 폰 로컬 전송 대기함 (outbox) ───────────────────────────
// PC-off 캡처의 dead-end 영구 제거: 외부 의존(Apps Script/커넥터) 0 — 캡처는 *무조건* 성공.
// PC-off → localStorage 큐 보관 → PC 깨면(applyMode online) 자동 /inbox/create 전송.
function outboxItems() { try { const a = JSON.parse(localStorage.getItem('cmbOutbox') || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
function outboxSave(a) { localStorage.setItem('cmbOutbox', JSON.stringify(a)); }
function outboxAdd(f) { const a = outboxItems(); a.push({ oid: clientUlid(), ts: Date.now(), title: f.title, targetEnv: f.targetEnv || 'any', body: f.body || '' }); outboxSave(a); }

let OUTBOX_FLUSHING = false;
async function flushOutbox() {
  if (OUTBOX_FLUSHING) return;
  let a = outboxItems();
  if (!a.length) return;
  OUTBOX_FLUSHING = true;
  let sent = 0;
  try {
    for (const it of [...a]) {
      try {
        const r = await dfetch(`${daemonBase()}/inbox/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: it.title, targetEnv: it.targetEnv, body: it.body + kbContextLine() }),
        });
        const res = await r.json();
        if (res && res.id) { a = a.filter((x) => x.oid !== it.oid); outboxSave(a); sent++; }
        else break;   // daemon 거부 — 보관 유지, 다음 기회
      } catch (_) { break; }   // 연결 끊김 — 보관 유지, 다음 기회
    }
  } finally { OUTBOX_FLUSHING = false; }
  if (sent) {
    const now = new Date().toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    localStorage.setItem('cmbLastFlush', JSON.stringify({ ts: Date.now(), count: sent }));
    toast(`✅ 설계 ${sent}건 PC 전송 완료 (${now})`);
    if (currentTab() === 'design') loadInbox();
  }
}

function renderOutbox() {
  const wrap = document.getElementById('outboxWrap');
  const el = document.getElementById('outboxList');
  if (!wrap || !el) return;
  const a = outboxItems();
  if (!a.length) { wrap.hidden = true; el.innerHTML = ''; return; }
  wrap.hidden = false;
  el.innerHTML = a.map((it) => {
    const when = new Date(it.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const env = (it.targetEnv && it.targetEnv !== 'any') ? ` · ${it.targetEnv}` : '';
    return `<div class="card spec-card"><strong>📤 ${slEscHtml(it.title)}</strong><span class="dim">전송 대기 · ${when}${env}</span><div class="task-actions"><button class="qr-btn qr-danger" data-obx-del="${it.oid}">🗑 삭제</button></div></div>`;
  }).join('');
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('click', (e) => {
      const d = e.target.closest('[data-obx-del]');
      if (!d) return;
      outboxSave(outboxItems().filter((x) => x.oid !== d.dataset.obxDel));
      renderOutbox(); toast('🗑 삭제됨');
    });
  }
}

// ── 설계 캡처 (V2 — 모드 무관 항상 성공) ──
async function captureDesign() {
  const f = await captureFields();
  if (!f) return;
  // 저장 직전 제목 재추천 (2026-06-12 사용자 명시 — PW_save 패턴): 추천이 있으면 1회 확인 (수정 가능), 취소 = 원제목 유지
  const sug = suggestTitle(f);
  if (sug) {
    const pick = await editPrompt('제목 추천 — 그대로 확인 또는 수정 (취소=원제목 유지)', sug, { preset: { label: `원제목 유지: ${f.title.slice(0, 30)}`, value: f.title } });
    if (pick !== null && pick.trim()) f.title = pick.trim().slice(0, 80);
  }
  await submitSpec(f);
}

// 캡처/붙여넣기 공용 제출 — PC-on: daemon inbox / PC-off(또는 호출 실패): 폰 outbox (절대 안 잃음)
async function submitSpec(f) {
  if (document.getElementById('statusBanner').dataset.mode === 'full') {
    try {
      const r = await dfetch(`${daemonBase()}/inbox/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: f.title, targetEnv: f.targetEnv, body: f.body + kbContextLine() }),   // DK4 KB-aware
      });
      const res = await r.json();
      if (res && res.id) { toast(`📥 "${res.title || f.title}" 캡처됨`); loadInbox(); return; }
    } catch (_) {}
  }
  outboxAdd(f);
  renderOutbox();
  toast('📤 보관됨 — PC 켜지면 자동 전송');
}

// ── V2 — 📋 스펙 붙여넣기 (Claude 설계 대화 산출물 수거) ─────────────────────
// Drive 커넥터는 파일 write 불가(읽기 전용) — 설계 대화의 스펙은 복사 → 여기 붙여넣기 → outbox/inbox.
function parseSpecText(t) {
  t = (t || '').trim();
  if (!t) return null;
  t = t.replace(/^```[a-z]*\r?\n/i, '').replace(/\r?\n```$/, '').trim();   // 코드펜스 벗기기
  let env = 'any';
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);   // frontmatter 있으면 targetEnv 만 흡수
  if (fm) { const m = fm[1].match(/targetEnv:\s*(\S+)/); if (m) env = m[1]; t = t.slice(fm[0].length).trim(); }
  if (!t) return null;
  const tm = t.match(/^#\s+(.+)$/m);
  const title = (tm ? tm[1].trim() : t.split(/\r?\n/)[0]).slice(0, 80);
  return { title, targetEnv: env, body: t };
}

async function pasteSpec() {
  const t = await editText('📋 스펙 붙여넣기 — 설계 대화의 산출 스펙(markdown) 전체', '');
  if (t == null) return;
  const f = parseSpecText(t);
  if (!f) { toast('⚠️ 내용이 비어있어요'); return; }
  await submitSpec(f);
}

// 멀티라인 입력 모달 (#textModal — editPrompt 의 textarea 판). opts.preset = { label, value } (editPrompt 와 동일).
function editText(label, cur, opts) {
  return new Promise((resolve) => {
    const m = document.getElementById('textModal');
    if (!m) { resolve(prompt(label, cur)); return; }
    document.getElementById('textLabel').textContent = label;
    const inp = document.getElementById('textInput');
    inp.value = cur || '';
    m.hidden = false;
    setTimeout(() => { inp.focus(); }, 50);
    const okBtn = document.getElementById('textOk');
    const cancelBtn = document.getElementById('textCancel');
    const preBtn = document.getElementById('textPreset');
    const done = (val) => {
      m.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      if (preBtn) { preBtn.removeEventListener('click', onPreset); preBtn.hidden = true; }
      resolve(val);
    };
    const onOk = () => done(inp.value);
    const onCancel = () => done(null);
    const onPreset = () => { inp.value = opts.preset.value; inp.focus(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    if (preBtn && opts && opts.preset) { preBtn.textContent = opts.preset.label; preBtn.hidden = false; preBtn.addEventListener('click', onPreset); }
  });
}

// ── V2 — 🧠 설계 대화 + 셋업 마법사 (옛 "링크 미설정" alert dead-end 영구 제거) ──
// PC-off 설계 지능 = claude.ai Project(Drive 커넥터가 GMD 전체 read) — 구독 안, 추가 과금 0.
function openDesignChat() {
  const url = projectUrl();
  if (url) { openExternal(url); return; }
  toast('Project 미설정 — 셋업 마법사 (1회, 약 2분)');
  openWizard();
}

// V2.1 — 외부 링크는 PWA 창 안 직접 이동(location.href) X: 브라우저 UI 없는 standalone 안에서 claude.ai 가
// 갇혀 무한 로딩/복귀 불가. window.open(_blank) = OS 가 브라우저(또는 Claude 앱 App Link)로 열음. 차단 시 fallback.
function openExternal(url) {
  const w = window.open(url, '_blank', 'noopener');
  if (!w) location.href = url;
}

function openWizard() { const m = document.getElementById('wizModal'); if (m) m.hidden = false; }

// brief 본문 (Project 지침 칸 복사용) — docs/DESIGN_BRIEF.template.md §=== 와 동일 내용 유지 의무 (한쪽 수정 시 같이).
const DESIGN_BRIEF_TEXT = `당신은 이 Project 에 연결된 Google Drive 지식 폴더(KB)를 기반으로 사용자의 수정·고도화 설계를 돕는다. 코드를 작성하지 않는다 — 설계 스펙만 산출한다. (실행은 사용자의 PC 가 켜진 뒤 에이전트가 한다.)

## 1. 시작 시 항상 (KB 로딩)
1. 연결된 폴더 루트에서 DESIGN_MANIFEST.md (없으면 .design-kb.json) 를 찾아 읽는다.
2. 매니페스트의 priority_order 순서대로, 매니페스트가 선언한 모든 목록 키(rules / beliefs / skills / agents / tools 등)가 가리키는 파일들을 로드한다. 모든 경로는 폴더 기준 상대경로 (* glob 허용).
3. 매니페스트가 없으면: "이 폴더에 DESIGN_MANIFEST.md 가 없다"고 알리고, 보이는 구조로 최선 추론하되 추론임을 명시한다 (지어내지 않음).

## 2. 준수 (Boundaries 3-tier)
Always: rules 준수 / beliefs 의 미감·원칙을 산출물에 반영 / 매니페스트가 선언한 항목만 사용.
Ask-first: 규칙 충돌 시 임의 우선순위 X — 사용자에게 묻기 / KB 밖 범위면 확인.
Never: 코드 실행·파일 변경 / 민감 데이터 본문 복제(경로·참조만) / 선언 안 된 규칙 추측 적용.

## 3. 산출 — 설계 스펙만
요청에 대해: # 제목 / ## 의도 / ## 수락 기준 / ## 완료 기준 (EARS: WHEN…THEN…SHALL) / ## 검증 방법 / ## 제약·환경(targetEnv) / ## 관련 에이전트·스킬 / ## 참조(폴더 상대경로만).

## 4. 전달 (중요 — 정직)
이 커넥터는 기존 파일 수정/이동이 불가하고, 새 파일 생성은 Google Docs 형식만 가능하다 — 사용자의 PC 가 읽는 markdown 큐와 호환되지 않는다. 그러므로 파일 저장을 시도하지 말고, 스펙이 확정되면 전체를 하나의 markdown 코드블록으로 출력하라 — 사용자가 복사해 폰 앱의 "📋 스펙 붙여넣기"로 가져간다. PC 가 켜지면 자동으로 작업 큐에 들어간다.

## 5. 경계
너는 설계만 한다. 매니페스트가 선언한 만큼만 안다. 민감 데이터는 경로/참조로만.`;

// ── 멀티 세션 라이브 터미널 (P1-b → multi, 2026-05-31) ─────────
// daemon 은 ws 연결당 독립 pty → 멀티세션 = PWA 측 세션 컬렉션 + overlay 상단 탭바.
// 세션 = { sid, name, ws, term, fit, pane, ping, status, pid }. 활성 1개만 보이고 나머지 살아있음.
const SESSIONS = new Map(); // sid -> session
let ACTIVE_SID = null;
let PENDING_OPEN = null;   // C (2026-06-04) — 알림 탭/딥링크(?session=)로 바로 열 세션 이름. restoreLiveSessions 복원 후 자동 진입.
let TERM_PUSHED = false;   // E4 — 터미널 overlay 가 history 에 push 됐는지 (Android 백버튼/iOS swipe nav stack)
let SID_SEQ = 0;
let TERM_COMPOSING = false; // 공용 입력 바 IME flag (A6)

function wsBase() {
  // daemonBase 의 http:// → ws://, https:// → wss://
  const b = daemonBase();
  return b.replace(/^http/, 'ws');
}

function hasLiveSession() {
  for (const s of SESSIONS.values()) if (s.ws && s.ws.readyState === 1) return true;
  return false;
}
function activeSession() { return ACTIVE_SID != null ? SESSIONS.get(ACTIVE_SID) : null; }
function sessionByName(name) {
  for (const s of SESSIONS.values()) if (s.name === name) return s;
  return null;
}
// C (2026-06-04) — 이름으로 그 세션 터미널 바로 열기 (알림 탭 → 그 task 진입). 없으면 false.
function openSessionByName(name) {
  if (!name) return false;
  const s = sessionByName(name);
  if (s) { restoreTerminal(s.sid); return true; }
  return false;
}

// 새 세션 생성 — 🚀 새 bg / 🚀 진행(runTask) / ▶ 이어서(runSpec) / overlay ＋ 탭. 항상 *새* pty.
// opts = { cwd, runTask:taskId, runSpec:specId, prompt } — runTask/runSpec 시 claude 에 이어받기 prompt 자동 주입(폰 터미널, PC 창 X).
function newSession(opts) {
  opts = (opts && typeof opts === 'object') ? opts : {};
  const cwd = opts.cwd;
  if (typeof Terminal === 'undefined') {
    alert('xterm.js 로드 실패 — 인터넷 확인 또는 PWA 새로고침');
    return;
  }
  const overlay = document.getElementById('termOverlay');
  const body = document.getElementById('termBody');
  overlay.hidden = false;
  pushTermHistory();   // E4 — 백버튼/swipe 가 PWA 닫지 않고 minimize
  requestWakeLock();   // E12 — 터미널 보는 동안 화면 유지

  const sid = ++SID_SEQ;
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.dataset.sid = String(sid);
  body.appendChild(pane);

  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13, cursorBlink: false, convertEol: true,
    disableStdin: true,   // #8 (2026-05-31): 모바일 입력 단일화 — xterm 본문=출력 전용, 입력은 하단 bar 하나로
    scrollback: 3000,     // #4 스크롤 여유
    theme: { background: '#000000', foreground: '#ececec' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  // #4 스크롤 렉 — WebGL GPU 렌더러(canvas/DOM 보다 빠름). 모바일 context loss 시 dispose(자동 DOM fallback).
  try {
    if (window.WebglAddon) {
      const webgl = new WebglAddon.WebglAddon();
      if (webgl.onContextLoss) webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      term.loadAddon(webgl);
    }
  } catch (_) {}

  const s = { sid, name: `세션 ${sid}`, ws: null, term, fit, pane, ping: null, status: 'connecting', pid: null, buf: '', scanTimer: null, quickReplies: [] };
  SESSIONS.set(sid, s);

  // xterm 키 입력 → 이 세션의 ws 로 (다른 세션 영향 X)
  term.onData((d) => { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'input', data: d })); });

  setActiveSession(sid);

  // race 해소: fit 먼저 → cols/rows 확정 후 ws 연결 + spawn
  setTimeout(() => {
    try { fit.fit(); } catch (_) {}
    const cols = term.cols || 80, rows = term.rows || 24;
    term.write(`[연결 중… cols=${cols} rows=${rows}]\r\n`);
    const ws = new WebSocket(`${wsBase()}/pty${tokenQ()}`);   // A1 — 토큰 설정 시 ws 인증
    s.ws = ws;
    ws.onopen = () => {
      if (opts.reattachName) {
        // 페이지 재진입 — 살아있는 pty 에 다시 붙기 (spawn 아님). 서버가 scrollback 을 replay 해줌.
        term.write(`[재연결 중… ${opts.reattachName}]\r\n`);
        ws.send(JSON.stringify({ type: 'reattach', name: opts.reattachName }));
      } else {
        term.write('[ws open — spawn 요청]\r\n');
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', cwd, cols, rows, name: opts.name, runTask: opts.runTask, runSpec: opts.runSpec, prompt: opts.prompt }));
      }
      startSessionPing(s); // keep-alive 15s (모바일 idle/백그라운드 disconnect 회피)
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ready') {
        s.name = m.sessionName || `세션 ${sid}`;
        s.pid = m.pid; s.status = 'ready'; s.cwd = m.cwd || s.cwd;   // statusline 정확도 — 세션 cwd 보관(transcript 매칭용)
        term.write(`[ready pid=${m.pid} name=${s.name}]\r\n`);
        // 충돌 조율 — 같은 폴더에 다른 세션이 작업 중이면 경고(인지). 같은 파일 동시 편집 시 나중 저장이 덮어씀.
        if (m.cwdPeers && m.cwdPeers.length) {
          term.write(`\r\n\x1b[33m⚠ 같은 폴더에 다른 세션 작업 중: ${m.cwdPeers.join(', ')}\r\n   같은 파일을 동시에 고치면 나중 저장이 덮어쓸 수 있어요(다른 파일이면 OK).\x1b[0m\r\n`);
          toast(`⚠️ 이 폴더에 세션 ${m.cwdPeers.length}개 동시 작업 중`);
        }
        if (ACTIVE_SID === sid) { updateTermTitle(); focusTermInput(); }
        renderSessionTabs();
        loadLive(); // 라이브 터미널 섹션 갱신
        return;
      }
      // 재연결 성공 — 직후 'data' 로 scrollback 이 흘러와 화면 복원됨
      if (m.type === 'reattached') {
        s.name = m.name || s.name;
        s.pid = m.pid; s.status = 'ready';
        try { s.fit.fit(); ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows })); } catch {}
        if (ACTIVE_SID === sid) { updateTermTitle(); focusTermInput(); }
        renderSessionTabs(); loadLive();
        return;
      }
      if (m.type === 'reattach-fail') {
        s.status = 'exited';
        term.write(`\r\n[복원 실패 — "${m.name}" 세션이 만료됐어요(10분 경과). 탭의 ✕ 로 닫고 새로 시작하세요.]\r\n`);
        renderSessionTabs(); if (ACTIVE_SID === sid) updateTermTitle();
        return;
      }
      if (m.type === 'data') { term.write(m.data); scheduleScan(s, m.data); return; }
      if (m.type === 'pong') return; // keep-alive 응답 (silent)
      if (m.type === 'file-ready') return; // 🅲 첨부 메타 ack (silent)
      if (m.type === 'file-saved') { toast(`📎 ${m.name} → PC 저장, 경로 입력됨 (Enter 로 전송)`); return; }
      if (m.type === 'exit') {
        s.status = 'exited'; term.write(`\r\n[종료 code=${m.code}]\r\n`);
        renderSessionTabs(); if (ACTIVE_SID === sid) updateTermTitle(); return;
      }
      if (m.type === 'error') { term.write(`\r\n[에러] ${m.message}\r\n`); return; }
    };
    ws.onclose = (ev) => {
      s.status = 'closed';
      // ws close code 진단: 1000=정상 / 1001=이탈 / 1006=네트워크 / 1011=서버
      const codeHint = { 1000: '정상 종료', 1001: '페이지 이탈', 1006: '네트워크 끊김', 1011: '서버 오류' }[ev.code] || `code=${ev.code}`;
      term.write(`\r\n[ws close — ${codeHint}]\r\n탭의 ✕ 로 닫거나 ＋ 로 새 세션 시작.\r\n`);
      toast(`⚠️ "${s.name}" 연결 끊김 (${codeHint})`);
      stopSessionPing(s);
      renderSessionTabs(); if (ACTIVE_SID === sid) updateTermTitle();
      checkHealth().then(schedulePoll);
    };
    ws.onerror = () => { term.write('\r\n[ws error]\r\n'); };
  }, 100);

  // 화면 회전/리사이즈 → 활성 세션 resize
  window.addEventListener('resize', termResize);
  setTimeout(termResize, 400);
  renderSessionTabs();
}

// ── statusline ANSI 파서 (폰 전용 — 색 + 카테고리 레이아웃) ──
// daemon /statusline 은 statusline.ps1 의 raw 출력(ANSI 256-color ESC 포함)을 그대로 보냄.
// 폰 textContent 로는 ESC 가 안 보여 "[38;5;152m" 같은 코드만 노출 → 여기서 색/카테고리로 재구성.
const SL_ESC = String.fromCharCode(27);
const SL_CODE_RE = new RegExp(SL_ESC + '\\[([0-9;]*)m', 'g');
let slRaw = '';   // 복사용 원본 보관

function ansi256ToHex(n) {
  const hx = (R, G, B) => '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (n < 16) {
    const base = ['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5',
                  '#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff'];
    return base[n] || '#dddddd';
  }
  if (n >= 232) { const v = 8 + (n - 232) * 10; return hx(v, v, v); }
  let i = n - 16;
  const r = Math.floor(i / 36); i -= r * 36;
  const g = Math.floor(i / 6); const b = i - g * 6;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return hx(c(r), c(g), c(b));
}
function slEscHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function slStrip(s) { return s.replace(SL_CODE_RE, ''); }
function slFirstColor(line) {
  SL_CODE_RE.lastIndex = 0; let m;
  while ((m = SL_CODE_RE.exec(line))) {
    const mm = (m[1] || '').match(/38;5;(\d+)/);
    if (mm) return ansi256ToHex(parseInt(mm[1], 10));
  }
  return null;
}
// info 줄(모델/사용량/한도)용 — ANSI 색을 inline span 으로 보존
function slAnsiToHtml(line) {
  let html = '', color = null, last = 0, m;
  SL_CODE_RE.lastIndex = 0;
  while ((m = SL_CODE_RE.exec(line))) {
    const text = line.slice(last, m.index);
    if (text) html += color ? `<span style="color:${color}">${slEscHtml(text)}</span>` : slEscHtml(text);
    const code = m[1] || '';
    if (code === '' || code === '0') color = null;
    else { const mm = code.match(/38;5;(\d+)/); if (mm) color = ansi256ToHex(parseInt(mm[1], 10)); }
    last = SL_CODE_RE.lastIndex;
  }
  const tail = line.slice(last);
  if (tail) html += color ? `<span style="color:${color}">${slEscHtml(tail)}</span>` : slEscHtml(tail);
  return html;
}
// 폰 전용 카테고리 레이아웃 — 스킬/직원 줄은 라벨(색) + 알약 칩, 정보 줄은 색 보존
function renderStatuslineHtml(raw) {
  if (!raw || !slStrip(raw).trim()) return '<div class="sl-info">(빈 statusline)</div>';
  const lines = raw.replace(/\r/g, '').split('\n').filter((l) => slStrip(l).trim().length);
  let html = '';
  for (const line of lines) {
    const plain = slStrip(line);
    const cm = plain.match(/^\[([A-Z])\]\s*([^:]+):\s*(.*)$/);
    // 스킬/직원 줄만 칩 레이아웃 — 한도줄([L], | () % 포함)은 정보 줄로
    if (cm && cm[3] && !/[|()%]/.test(cm[3])) {
      const color = slFirstColor(line) || 'var(--text)';
      const items = cm[3].split(/\s+/).filter(Boolean);
      html += '<div class="sl-cat">'
            + `<span class="sl-cat-label" style="color:${color}">[${cm[1]}] ${slEscHtml(cm[2].trim())}</span>`
            + `<span class="sl-cat-items">${items.map((it) => `<span class="sl-pill">${slEscHtml(it)}</span>`).join('')}</span>`
            + '</div>';
    } else {
      html += `<div class="sl-info">${slAnsiToHtml(line)}</div>`;
    }
  }
  return html;
}

// 칸 늘리기 — ⛶ 전체화면 토글: 헤더 title + 멀티세션 탭 접어 출력 영역 최대(터미널 칸 부족 완화).
function toggleFullscreen() {
  const ov = document.getElementById('termOverlay');
  if (!ov) return;
  ov.classList.toggle('fs');
  setTimeout(fitTermToViewport, 60);   // chrome 접은 뒤 output 재맞춤(fit)
}

// statusline 토글 — 폰 세션은 statusline 끄지만 ℹ︎ 버튼으로 창에서 보기(색+카테고리) + 복사 + 닫기
async function showStatusline() {
  const modal = document.getElementById('slModal');
  const txt = document.getElementById('slText');
  slRaw = '';
  txt.innerHTML = '<div class="sl-info">불러오는 중…</div>';
  modal.hidden = false;
  try {
    const s = activeSession();
    const q = (s && s.cwd) ? `?cwd=${encodeURIComponent(s.cwd)}` : '';   // 현 세션 transcript 로 토큰/bar 정확도 ↑
    const r = await dfetch(`${daemonBase()}/statusline${q}`, { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok) { slRaw = j.text || ''; txt.innerHTML = renderStatuslineHtml(slRaw); }
    else { txt.innerHTML = `<div class="sl-info">실패: ${slEscHtml((j && j.reason) || 'unknown')}</div>`; }
  } catch (_) { txt.innerHTML = '<div class="sl-info">실패 — daemon 확인</div>'; }
}

// 🅲 첨부 — 📎 누르면 시트(🖼 사진 갤러리/카메라 / 📁 PC 파일 검색). 둘 다 경로/이미지를 claude 에 전달.
function attachFile() {
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== 1) { toast('⚠️ 터미널 세션을 먼저 열어주세요'); return; }
  document.getElementById('attachSheet').hidden = false;
}
// 🅲-1 갤러리/카메라 이미지 → WS binary 로 PC 저장 → claude 가 경로 이미지 자동 읽음(#36391).
function pickGallery() {
  document.getElementById('attachSheet').hidden = true;
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== 1) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';   // 갤러리 + 카메라 선택 sheet (Android/iOS)
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      s.ws.send(JSON.stringify({ type: 'file-meta', name: f.name, size: f.size }));
      f.arrayBuffer().then((buf) => { try { s.ws.send(buf); toast(`📎 ${f.name} 전송 중…`); } catch (_) { toast('⚠️ 전송 실패'); } });
    } catch (_) { toast('⚠️ 첨부 실패 — 세션 확인'); }
  };
  inp.click();
}
// 🅲-2 PC 파일 검색 — daemon /files (허용 root 안 readdir/검색) → 폴더 navigate / 파일 탭 시 경로 pty 주입.
function openFileBrowser() {
  document.getElementById('attachSheet').hidden = true;
  document.getElementById('fileModal').hidden = false;
  document.getElementById('fileSearch').value = '';
  loadFiles('', '');
}
async function loadFiles(dir, q) {
  const list = document.getElementById('fileList');
  list.innerHTML = '<div class="sl-info">불러오는 중…</div>';
  try {
    const r = await dfetch(`${daemonBase()}/files?dir=${encodeURIComponent(dir || '')}&q=${encodeURIComponent(q || '')}`, { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) { list.innerHTML = `<div class="sl-info">${(j.reason || '오류')}</div>`; return; }
    list._curDir = j.dir;
    document.getElementById('fileDir').textContent = '📁 ' + (j.dir.split(/[\\/]/).filter(Boolean).pop() || j.dir);
    let html = '';
    if (j.parent) html += `<div class="file-row" data-dir="${j.parent}">↩ .. (상위 폴더)</div>`;
    html += j.items.map((it) => it.isDir
      ? `<div class="file-row" data-dir="${it.path}">📁 ${it.name}</div>`
      : `<div class="file-row file-pick" data-file="${it.path}">📄 ${it.name}</div>`).join('');
    list.innerHTML = html || '<div class="sl-info">(비어있음)</div>';
  } catch (_) { list.innerHTML = '<div class="sl-info">실패 — daemon 확인</div>'; }
}
function onFileListTap(e) {
  const d = e.target.closest('[data-dir]');
  const f = e.target.closest('[data-file]');
  if (d) { loadFiles(d.dataset.dir, document.getElementById('fileSearch').value); return; }
  if (f) {
    const s = activeSession();
    if (s && s.ws && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: 'input', data: `"${f.dataset.file}" ` }));   // 경로 주입(claude 가 읽음)
      toast('📄 경로 입력됨 (Enter 로 전송)');
    }
    document.getElementById('fileModal').hidden = true;
  }
}

// #8 (2026-05-31): 입력 통로 단일화 — xterm(읽기전용) 대신 하단 입력칸으로 포커스 유도
function focusTermInput() {
  const ti = document.getElementById('termInput');
  if (ti) { try { ti.focus(); } catch {} }
}

// ── E12 Wake Lock — 세션 모니터링/긴 출력 보는 동안 화면 자동 꺼짐 방지 (Android Chrome 84+ / iOS 16.4+, https 필수) ──
let WAKE_LOCK = null;
function termOverlayOpen() { const ov = document.getElementById('termOverlay'); return !!(ov && !ov.hidden); }
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || WAKE_LOCK) return;
  try { WAKE_LOCK = await navigator.wakeLock.request('screen'); WAKE_LOCK.addEventListener('release', () => { WAKE_LOCK = null; }); } catch (_) {}
}
function releaseWakeLock() { if (WAKE_LOCK) { try { WAKE_LOCK.release(); } catch (_) {} WAKE_LOCK = null; } }
// ── E13 Haptic — 승인 탭/위험 확인 촉각 (Android 만; iOS WebKit 전면 미지원 → graceful no-op) ──
function haptic(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (_) {} } }

// 활성 세션 전환 — pane 토글 + fit + focus + 탭바/타이틀 갱신
function setActiveSession(sid) {
  if (!SESSIONS.has(sid)) return;
  ACTIVE_SID = sid;
  for (const s of SESSIONS.values()) s.pane.style.display = (s.sid === sid) ? 'block' : 'none';
  const s = SESSIONS.get(sid);
  try { s.fit && s.fit.fit(); } catch {}
  focusTermInput();
  updateTermTitle();
  renderSessionTabs();
  renderQuickReplies(s);   // E9 — 세션 전환 시 해당 세션 탭 버튼 재표시
  fitTermToViewport();     // 버그1 — overlay 열림/전환 시 키보드 높이 반영
}

function updateTermTitle() {
  const t = document.getElementById('termTitle');
  const s = activeSession();
  if (!s) { t.textContent = 'Claude'; return; }
  const statTxt = { connecting: '연결 중', closed: '끊김', exited: '종료', error: '오류' }[s.status];
  t.textContent = s.status === 'ready' ? s.name : `${s.name} (${statTxt || s.status})`;
}

// overlay 상단 세션 탭바 — 각 탭 = 상태점 + 이름 + ✕(닫기), 끝에 ＋(새 세션)
function renderSessionTabs() {
  const bar = document.getElementById('termTabs');
  if (!bar) return;
  const items = [...SESSIONS.values()].map((s) => {
    const dot = s.status === 'ready' ? '🟢' : s.status === 'connecting' ? '🟡' : '⚪';
    const act = s.sid === ACTIVE_SID ? ' is-active' : '';
    return `<button class="term-tab${act}" data-sid="${s.sid}"><span class="st-dot">${dot}</span><span class="st-name">${s.name}</span><span class="st-x" data-close="${s.sid}">✕</span></button>`;
  });
  // V2 — ＋(freeform 새 세션) 제거: 폰에서 새 작업 생성은 설계 캡처 → ▶ 진행 경로만
  bar.innerHTML = items.join('');
  bar.hidden = SESSIONS.size === 0;
}

// 탭바 탭 (event delegation): ✕=닫기 / 탭=전환 (V2 — ＋ 새 세션 제거)
function onSessionTabTap(e) {
  const closeEl = e.target.closest('[data-close]');
  if (closeEl) { e.stopPropagation(); closeSession(Number(closeEl.dataset.close)); return; }
  const tab = e.target.closest('.term-tab');
  if (tab && tab.dataset.sid) setActiveSession(Number(tab.dataset.sid));
}

// 세션 1개 종료 — pty kill + dispose + pane 제거. 활성이었으면 다른 세션으로, 없으면 overlay 닫기.
// V2.1 — 진행형 persist 세션(spec-/task-) 보호: ✕ 가 외출 중 작업을 즉사시키지 않게 *detach 만* (pty 유지).
//   진짜 종료는 그 세션 안에서 /exit (claude 종료 = pty 자연 소멸). 일반 세션(부활/알림 등)은 기존대로 kill.
function closeSession(sid) {
  const s = SESSIONS.get(sid);
  if (!s) return;
  stopSessionPing(s);
  const isWorkSession = /^(spec|task)-/.test(s.name || '');
  if (s.ws) {
    try {
      if (!isWorkSession) s.ws.send(JSON.stringify({ type: 'kill' }));
      s.ws.close();
    } catch {}
  }
  if (isWorkSession) toast(`▶ "${s.name}" 작업은 PC 에서 계속 — 종료하려면 세션 안에서 /exit`);
  if (s.term) { try { s.term.dispose(); } catch {} }
  if (s.pane && s.pane.parentNode) s.pane.parentNode.removeChild(s.pane);
  SESSIONS.delete(sid);
  if (ACTIVE_SID === sid) {
    const next = SESSIONS.keys().next();
    if (!next.done) setActiveSession(next.value);
    else {
      ACTIVE_SID = null;
      document.getElementById('termOverlay').hidden = true;
      releaseWakeLock();   // E12 — 마지막 세션 종료 → 화면 유지 해제
      window.removeEventListener('resize', termResize);
    }
  }
  renderSessionTabs();
  loadLive(); // 라이브 터미널 섹션 갱신
}

// header ✕ = 활성 세션 종료 (남으면 다음, 없으면 overlay 닫힘)
function closeActiveSession() { if (ACTIVE_SID != null) closeSession(ACTIVE_SID); }

function termResize() {
  const s = activeSession();
  if (!s || !s.fit || !s.ws) return;
  try {
    s.fit.fit();
    if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
  } catch {}
}

// 버그1 (2026-05-31): 모바일 키보드가 올라오면 visualViewport 높이가 줄어듦 →
// fixed overlay 를 그 높이로 줄여 입력칸이 키보드 위에 보이고, term 을 다시 fit + 하단 정렬(최신 출력 보임).
function fitTermToViewport() {
  const ov = document.getElementById('termOverlay');
  if (!ov || ov.hidden) return;
  const vv = window.visualViewport;
  if (vv) { ov.style.height = vv.height + 'px'; ov.style.top = vv.offsetTop + 'px'; }
  const s = activeSession();
  if (s && s.fit) {
    try {
      s.fit.fit();
      if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
      s.term && s.term.scrollToBottom();
    } catch {}
  }
}

// minimize: overlay 만 숨김, 모든 세션 유지 (사용자 명시 대시보드 ↔ 터미널 양방향)
// ── E4 (2026-05-31) — History API 뒤로가기 nav stack ──
// overlay open 시 pushState → Android 백버튼 / iOS edge-swipe / 뒤로 chevron → popstate → minimize (PWA 닫힘 X).
function pushTermHistory() {
  if (TERM_PUSHED) return;                          // 탭 여러 개여도 overlay 당 1 entry
  try { history.pushState({ m: 'term' }, ''); TERM_PUSHED = true; } catch (_) {}
}
function goBackTerminal() {                          // 뒤로 chevron — history.back 경유 (popstate 가 실제 minimize, 제스처와 일관)
  if (TERM_PUSHED) { try { history.back(); return; } catch (_) {} }
  minimizeTerminal();
}
function onTermPopstate() {
  TERM_PUSHED = false;                               // 이 entry 소비
  const ov = document.getElementById('termOverlay');
  if (ov && !ov.hidden) minimizeTerminal();          // overlay 열려있으면 닫기(=뒤로). 이미 닫혀있으면 flag 소비만(무해).
}

function minimizeTerminal() {
  const _qr = document.getElementById('quickReplies'); if (_qr) _qr.hidden = true;   // E9 — overlay 숨길 때 버튼바도 숨김
  releaseWakeLock();   // E12 — 터미널 숨기면 화면 유지 해제
  if (SESSIONS.size === 0) { document.getElementById('termOverlay').hidden = true; return; }
  document.getElementById('termOverlay').hidden = true;
  toast(`${SESSIONS.size}개 세션 백그라운드 유지 — 📞 열린 터미널 에서 복귀`);
  loadLive(); // 라이브 터미널 섹션 갱신
}

// 복귀: overlay 표시 (+ 특정 sid 활성화). 세션 객체 그대로.
function restoreTerminal(sid) {
  if (SESSIONS.size === 0) { toast('복귀 실패 — 세션 없음'); return; }
  document.getElementById('termOverlay').hidden = false;
  pushTermHistory();   // E4 — 복귀 시 다시 push (minimize 시 소비됨)
  requestWakeLock();   // E12 — 복귀 시 화면 유지 재획득
  if (sid != null && SESSIONS.has(sid)) setActiveSession(sid);
  else if (ACTIVE_SID != null && SESSIONS.has(ACTIVE_SID)) setActiveSession(ACTIVE_SID);
  else setActiveSession(SESSIONS.keys().next().value);
}

// 페이지 재진입(크롬 홈버튼/탭 복귀/PWA 재시작) 시 — 서버에 살아있는 pty 가 있으면 자동 복원(화면까지).
async function restoreLiveSessions() {
  if (SESSIONS.size > 0) { if (PENDING_OPEN) { openSessionByName(PENDING_OPEN); PENDING_OPEN = null; } return; }   // 이미 세션 있으면 중복 복원 X (단 알림 탭 PENDING_OPEN 은 즉시 진입)
  let list;
  try {
    const r = await dfetch(`${daemonBase()}/ptys`, { cache: 'no-store' });
    if (!r.ok) return;
    list = await r.json();
  } catch { return; }                        // daemon 오프라인 — 조용히 패스
  if (!Array.isArray(list) || !list.length) return;
  const wasOpen = localStorage.getItem('cmbTermOpen') === '1';
  const lastActive = localStorage.getItem('cmbActiveName') || '';
  for (const info of list) newSession({ reattachName: info.name, cwd: info.cwd });
  if (lastActive) { const s = sessionByName(lastActive); if (s) setActiveSession(s.sid); }
  if (!wasOpen) { document.getElementById('termOverlay').hidden = true; loadLive(); }  // 직전 대시보드였으면 백그라운드 유지
  if (PENDING_OPEN) { openSessionByName(PENDING_OPEN); PENDING_OPEN = null; }  // C — 알림 탭으로 온 세션은 wasOpen 무관 *마지막에* 진입(overlay 숨김 덮어쓰기)
  toast(`📞 ${list.length}개 세션 복원 — 끊긴 대화 이어집니다`);
}

// per-session keep-alive ping 15s (모바일 OS idle/백그라운드 + Tailscale 휘발성 + 셀룰러↔WiFi 전환)
function startSessionPing(s) {
  stopSessionPing(s);
  s.ping = setInterval(() => {
    if (s.ws && s.ws.readyState === 1) { try { s.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {} }
  }, 15000);
}
function stopSessionPing(s) {
  if (s && s.ping) { clearInterval(s.ping); s.ping = null; }
}

// ── E9 (2026-05-31) — CLI 프롬프트 → 탭 승인 버튼 (타이핑 승인 → 터치) ──
// 염려 보완: (a) ANSI strip (b) 보수적 감지(≥2 연속 숫자옵션 OR 명시 y/n 만) (c) debounce 200ms(redraw 부분파싱 회피)
//   (d) 전송값 미리보기 hint (e) raw 입력바 항상 유지(fallback) (f) danger 옵션 confirm(E10). 화살표-전용 메뉴/파싱 실패 = raw 입력으로.
function stripAnsi(str) {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC
    .replace(/\x1b[@-Z\\-_]/g, '')                       // 2-char escape
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')           // CSI (색·커서)
    .replace(/\r/g, '\n');
}

function detectPrompt(rawBuf) {
  const tail = stripAnsi(rawBuf).split('\n').slice(-30);   // 끝 30줄
  const tailStr = tail.join('\n');
  // (1) y/n permission — 사용자 최신: No 왼쪽(1), Yes 오른쪽(2). isNo 마커 → renderQuickReplies 가 No 다음 spacer.
  if (/\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|\(Y\/n\)|\(y\/N\)/i.test(tailStr)) {
    return [
      { label: 'No', value: 'n\r', danger: false, isNo: true },
      { label: 'Yes', value: 'y\r', danger: false, isNo: false },
    ];
  }
  // (2) 번호 메뉴 — claude 권한 프롬프트는 박스(│ ❯ 1. Yes)로 그려짐 → box drawing prefix 허용(안 뜨던 원인).
  const opts = [];
  for (const line of tail) {
    const m = line.match(/^[\s│|>❯·*+\-]*(\d{1,2})[.)]\s+(\S.*?)\s*$/);
    if (m && parseInt(m[1], 10) === opts.length + 1) opts.push({ n: opts.length + 1, raw: m[2].trim() });
  }
  if (opts.length >= 2) {
    // 라벨 단어(No/Yes/Yes-all) — 매칭 안 되는 긴 옵션은 번호만.
    const lbl = (raw) => {
      if (/don'?t ask|always|모두|항상/i.test(raw)) return 'Yes-all';
      if (/^yes\b|^y\b|^예/i.test(raw)) return 'Yes';
      if (/^no\b|tell claude|differently|취소|cancel|다르게/i.test(raw)) return 'No';
      return null;
    };
    let mapped = opts.map((o) => ({
      label: lbl(o.raw) || `${o.n}`,
      value: `${o.n}\r`,          // value=claude 실제 번호(정확). 표시 순서만 재배치.
      danger: /삭제|delete|remove|force|덮어|overwrite|영구|reset|drop/i.test(o.raw),
      isNo: /^no\b|tell claude|differently|취소|cancel|다르게/i.test(o.raw),
    }));
    // 사용자 최신: No 왼쪽(1) / Yes·Yes-all 오른쪽. Yes/No 단어 구성일 때만 No 먼저 정렬(긴 옵션 섞이면 claude 순서 유지).
    const allWord = mapped.every((m) => /^(No|Yes|Yes-all)$/.test(m.label));
    if (allWord) mapped.sort((a, b) => (b.isNo ? 1 : 0) - (a.isNo ? 1 : 0));
    return mapped;
  }
  return null;
}

function scheduleScan(s, chunk) {
  s.buf = (s.buf + chunk).slice(-6000);           // 롤링 6KB (박스 프롬프트 길이 여유)
  if (s.scanTimer) clearTimeout(s.scanTimer);
  s.scanTimer = setTimeout(() => {                // debounce — 출력 정착 후 1회
    s.scanTimer = null;
    const found = detectPrompt(s.buf);
    if (found) {                                  // 프롬프트 감지 → set + render
      s.quickReplies = found;
      if (s.sid === ACTIVE_SID) renderQuickReplies(s);
    }
    // #3 sticky — found null 이면 기존 버튼 *유지* (사용자 답 전까지 안 사라짐). clear 는 키 전송 시(탭/Enter).
  }, 120);
}

function renderQuickReplies(s) {
  const bar = document.getElementById('quickReplies');
  if (!bar) return;
  const btns = (s && s.sid === ACTIVE_SID) ? (s.quickReplies || []) : [];
  if (!btns.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  // 한 줄 컴팩트 — No 왼쪽 / Yes(들) 오른쪽. No→Yes 전환 지점에 spacer(flex-grow)로 간격(오터치 방지).
  bar.innerHTML = btns.map((b, i) => {
    const spacer = (!b.isNo && i > 0 && btns[i - 1].isNo) ? '<span class="qr-spacer"></span>' : '';
    return spacer + `<button class="qr-btn${b.danger ? ' qr-danger' : ''}${b.isNo ? ' qr-no' : ''}" data-qr="${i}">${b.label}</button>`;
  }).join('');
}

function clearQuickReplies(s) {
  if (s) { s.quickReplies = []; s._manualOpen = false; if (s.scanTimer) { clearTimeout(s.scanTimer); s.scanTimer = null; } }
  const bar = document.getElementById('quickReplies');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }   // hidden = display:none → 공간 0 (칸 안 먹음)
}

// #2 수동 트리거 — 자동 감지(detectPrompt)가 못 잡을 때 사용자가 🔢 눌러 범용 승인 버튼 강제 표시.
// 글 보존(termInput 안 건드림) — 치던 글 날리지 않고 탭으로 답. Yes 왼쪽 / No 오른쪽(isNo spacer).
function showManualReplies() {
  const s = activeSession();
  if (!s) { toast('⚠️ 터미널 세션을 먼저 열어주세요'); return; }
  // 토글 — 이미 수동 버튼 떠있으면 다시 누르면 접기(display:none → 칸 안 먹음).
  if (s._manualOpen) { clearQuickReplies(s); return; }
  s._manualOpen = true;
  s.quickReplies = [
    { label: 'No', value: 'n\r', isNo: true },
    { label: 'Yes', value: 'y\r', isNo: false },
    { label: '1', value: '1\r' }, { label: '2', value: '2\r' }, { label: '3', value: '3\r' },
    { label: 'Esc', value: '\x1b' },
  ];
  renderQuickReplies(s);
}

function onQuickReplyTap(e) {
  const btn = e.target.closest('[data-qr]');
  if (!btn) return;
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== 1) { toast('⚠️ 세션 연결 끊김 — 입력칸에 직접'); return; }
  const b = (s.quickReplies || [])[Number(btn.dataset.qr)];
  if (!b) return;
  if (b.danger && !confirm(`위험 선택 "${b.label}" — 전송할까요?`)) return;   // E10 verified 가드
  haptic(b.danger ? [40, 30, 40] : 25);   // E13 — 승인 탭 촉각(위험=2단 진동, Android 만)
  s.ws.send(JSON.stringify({ type: 'input', data: b.value }));
  clearQuickReplies(s);
}

// 보조 입력 — 한국어 IME (A1 blur 강제 commit + A5 rAF + A6 composing flag). 활성 세션 ws 로 전송.
// ★ 2026-05-30 정정 — A2 buffer 영구 제거 (double-set race → "4글자에 1번 중복"). blur+rAF 이 flush 보장.
function termSendLine() {
  const input = document.getElementById('termInput');
  if (TERM_COMPOSING) {
    input.blur(); // ↵ 버튼은 keydown 아님 → isComposing 가드 무효 → blur 로 IME 강제 commit
    requestAnimationFrame(() => { flushTermInput(input); input.focus(); });
    return;
  }
  flushTermInput(input);
}

function flushTermInput(input) {
  const v = input.value;
  input.value = '';
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== 1) return;
  s.ws.send(JSON.stringify({ type: 'input', data: v + '\r' }));
  clearQuickReplies(s);   // #1 — 직접 타이핑으로 답함 = 프롬프트 응답 → 버튼 clear
}

// G1 (2026-06-04 polish) — 원격 음성 입력. 공식 Claude voice 는 *로컬 마이크* 라 web/SSH 원격 미지원 → 폰 브라우저 Web Speech API 로 메움(차별).
//   transcript 를 termInput 에 주입(자동 전송 X — 사용자가 보고 ↵). https(ts.net)=secure context 필수(충족). 미지원(일부 iOS Safari)=🎤 숨김(graceful).
let VOICE_REC = null, VOICE_ON = false;
function initVoiceInput() {
  const mic = document.getElementById('termMic');
  if (!mic) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { mic.hidden = true; return; }   // 미지원 브라우저 = 숨김
  mic.hidden = false;
  mic.addEventListener('click', () => {
    if (VOICE_ON) { try { VOICE_REC && VOICE_REC.stop(); } catch {} return; }   // 다시 탭 = 멈춤
    const input = document.getElementById('termInput');
    const base = input.value;   // 기존 입력 뒤에 이어붙임
    const rec = new SR();
    rec.lang = 'ko-KR'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    rec.onstart = () => { VOICE_ON = true; mic.textContent = '⏹'; toast('🎤 듣는 중… (다시 탭하면 멈춤)'); };
    rec.onresult = (e) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      input.value = (base ? base + ' ' : '') + txt;   // 실시간 반영 — 보내기 전 편집 가능
    };
    rec.onerror = (e) => { toast(`🎤 ${e.error === 'not-allowed' ? '마이크 권한 거부 — 브라우저 설정 확인' : (e.error === 'no-speech' ? '음성 없음' : '오류: ' + e.error)}`); };
    rec.onend = () => { VOICE_ON = false; mic.textContent = '🎤'; VOICE_REC = null; try { input.focus(); } catch {} };
    VOICE_REC = rec;
    try { rec.start(); } catch (_) { toast('🎤 시작 실패 — 마이크 권한/HTTPS 확인'); }
  });
}

// ── init ──────────────────────────────────────────────────
// ── E3 (2026-05-31) — pull-to-refresh (main 스크롤 최상단에서 당겨 새로고침; 수직 제스처 — E4 가로 swipe 와 직교, 충돌 0) ──
function initPullToRefresh() {
  const main = document.querySelector('main');
  if (!main) return;
  let startY = 0, pulling = false, dist = 0;
  main.addEventListener('touchstart', (e) => {
    if (main.scrollTop <= 0 && e.touches.length === 1) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
    else pulling = false;
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist > 0) {
      main.classList.add('ptr-pull'); main.style.transform = `translateY(${Math.min(dist * 0.4, 64)}px)`;
      const ind = document.getElementById('ptrIndicator');   // #7 — 우측 상단 인디케이터: 당김 따라 회전, 임계 넘으면 강조
      if (ind) { ind.classList.add('show'); ind.classList.toggle('ready', dist > 90); ind.style.transform = `rotate(${Math.min(dist * 2, 360)}deg)`; }
    }
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    main.style.transition = 'transform .2s'; main.style.transform = '';
    const ind = document.getElementById('ptrIndicator');   // #7 — 인디케이터 숨김
    if (ind) { ind.classList.remove('show', 'ready'); ind.style.transform = ''; }
    setTimeout(() => { main.style.transition = ''; main.classList.remove('ptr-pull'); }, 220);
    if (dist > 90) {                                  // 임계 넘으면 현재 탭 reload
      toast('🔄 새로고침');
      const tab = currentTab();
      if (tab === 'dashboard') loadDashboard();
      else if (tab === 'design') loadInbox();
      else if (tab === 'settings') renderSettings();
    }
  }, { passive: true });
}

// ── E2 (2026-05-31) — swipe-to-action (충돌 회피: 왼쪽 swipe 만 = iOS edge-back(왼→오) 과 방향 직교 / 세로스크롤 우선 / 버튼 위 시작 무시) ──
// 스펙 카드 왼쪽 swipe → 그 카드의 primary 버튼(이어받기/완료) 동작 (제스처 단축, 버튼과 동일 — 중복 아닌 빠른 경로).
function initSwipeActions(container) {
  if (!container || container._swipeWired) return;
  container._swipeWired = true;
  let card = null, x0 = 0, y0 = 0, dx = 0, locked = null;   // locked: null | 'h' | 'v'
  container.addEventListener('touchstart', (e) => {
    card = null;
    if (e.touches.length !== 1) return;
    const c = e.target.closest('.spec-card');
    if (!c || e.target.closest('button')) return;            // 버튼 위 시작 = 탭 우선, swipe X
    card = c; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; locked = null;
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!card) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!locked) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) locked = 'h';
      else if (Math.abs(dy) > 12) { card = null; return; }   // 세로 = 스크롤 양보
      else return;
    }
    if (locked === 'h') {
      e.preventDefault();                                    // 가로 swipe 중 스크롤 방지
      const t = Math.max(Math.min(dx, 0), -110);             // 왼쪽만 (iOS back 과 직교)
      card.style.transition = ''; card.style.transform = `translateX(${t}px)`;
      card.style.opacity = String(1 + t / 220);
    }
  }, { passive: false });
  container.addEventListener('touchend', () => {
    if (!card || locked !== 'h') { card = null; return; }
    const trigger = dx < -80;
    const c = card; card = null;
    c.style.transition = 'transform .18s, opacity .18s'; c.style.transform = ''; c.style.opacity = '';
    if (trigger) {
      const runId = (c.querySelector('[data-run]') || {}).dataset?.run;
      const claimId = (c.querySelector('[data-claim]') || {}).dataset?.claim;
      const doneId = (c.querySelector('[data-done]') || {}).dataset?.done;
      const reload = currentTab() === 'design' ? loadInbox : loadSpecs;
      if (runId) newSession({ runSpec: runId });                   // swipe primary = ▶ 이어서 (폰 터미널)
      else if (claimId) specAction('/inbox/claim', claimId, reload);
      else if (doneId) specAction('/inbox/complete', doneId, reload);
    }
  }, { passive: true });
}

function init() {
  // E6 — 탭 = delegation 1개 + bind-first: init 후반 어디서 에러가 나도 탭 전환만은 절대 안 죽음
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t && t.dataset.tab) showTab(t.dataset.tab);
  });
  // 우측상단 ⟳ — 짧게 탭: 상태/데이터 갱신(빠름) + 새 sw 조용히 체크 / 길게(0.6s): 강제 새로고침(캐시 비우고 리로드 = 크롬 강제새로고침처럼)
  {
    const rb = document.getElementById('refreshBtn');
    let rbTimer = null, rbLong = false;
    rb.addEventListener('click', async () => {
      if (rbLong) { rbLong = false; return; }   // 길게눌러 강제새로고침 발동한 경우 click 무시
      await checkHealth({ manual: true }); renderSettings(); renderFab(currentTab()); schedulePoll();
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.update())).catch(() => {});
    });
    const startLong = () => { rbLong = false; rbTimer = setTimeout(() => { rbLong = true; forceRefresh(); }, 600); };
    const cancelLong = () => { if (rbTimer) { clearTimeout(rbTimer); rbTimer = null; } };
    rb.addEventListener('pointerdown', startLong);
    rb.addEventListener('pointerup', cancelLong);
    rb.addEventListener('pointerleave', cancelLong);
    rb.addEventListener('pointercancel', cancelLong);
  }

  // P2: visibility 변화 → polling on/off (배터리/네트워크 절약)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (POLL_TIMER) { clearTimeout(POLL_TIMER); POLL_TIMER = null; }
    } else {
      checkHealth().then(schedulePoll); // 화면 복귀 즉시 1회 확인 후 폴 재개
      if (termOverlayOpen()) requestWakeLock();   // E12 — 백그라운드서 자동 해제된 wake lock 재획득
    }
  });
  document.getElementById('newDesignChat').addEventListener('click', openDesignChat);
  // F4 — 클라우드 1차 설계: claude.ai/code (Claude 앱 Code 탭) → gmd-design-kb repo 선택 → 설계 지시.
  //   세션은 Anthropic 클라우드에서 자율 진행 (앱 닫아도) → inbox/ 커밋 → PC 켜지면 mirror-sync 가 자동 수거.
  const cloudBtn = document.getElementById('newCloudDesign');
  if (cloudBtn) cloudBtn.addEventListener('click', () => {
    openExternal('https://claude.ai/code');
    toast('☁ repo gmd-design-kb 선택 → 설계 지시. 중간 컨펌 후 PC 자동 도착');
  });
  document.querySelectorAll('.settings-group').forEach((g) => g.addEventListener('click', onSettingsTap));
  // V2 — ⚠️ 승인 센터 (외출 중 승인 대체제)
  const pl = document.getElementById('promptList');
  if (pl) pl.addEventListener('click', onPromptTap);
  // V2 — 설계 셋업 마법사 (PC-off 설계 dead-end 영구 제거)
  {
    const wz = (id) => document.getElementById(id);
    if (wz('wizClose')) wz('wizClose').addEventListener('click', () => { wz('wizModal').hidden = true; });
    if (wz('wizOpenProjects')) wz('wizOpenProjects').addEventListener('click', () => openExternal('https://claude.ai/projects'));   // V2.2 — ① 단계 직행
    if (wz('wizCopyBrief')) wz('wizCopyBrief').addEventListener('click', () => {
      // V2.1 — clipboard API 는 https 전용: http(Tailscale IP) 접속 시 undefined → 본문을 모달로 띄워 수동 복사 fallback
      const manual = () => { document.getElementById('wizModal').hidden = true; editText('brief 본문 — 전체 선택 후 복사 (자동 복사 미지원 환경)', DESIGN_BRIEF_TEXT).then(() => { document.getElementById('wizModal').hidden = false; }); };
      if (navigator.clipboard) navigator.clipboard.writeText(DESIGN_BRIEF_TEXT).then(() => toast('📋 brief 복사됨 — Project 지침 칸에 붙여넣기'), manual);
      else manual();
    });
    if (wz('wizSetUrl')) wz('wizSetUrl').addEventListener('click', async () => {
      const v = await editPrompt('Claude Project 링크 (https://claude.ai/project/…)', projectUrl());
      if (v !== null) { localStorage.setItem('projectUrl', v.trim()); toast(v.trim() ? '🔗 저장됨 — 설계 대화 준비 완료' : '🔗 비움'); renderSettings(); }
    });
    // V2.3 — ⑤ 연결 확인용 테스트 질문 복사 (셋업 성공/실패를 첫 사용자도 즉시 판별)
    const WIZ_TEST_PROMPT = '프로젝트 지식에서 DESIGN_MANIFEST.md 파일을 찾아 핵심을 요약해줘. 못 찾으면 지식 목록에 어떤 파일/폴더가 보이는지 그대로 알려줘.';
    if (wz('wizCopyTest')) wz('wizCopyTest').addEventListener('click', () => {
      const manual = () => { document.getElementById('wizModal').hidden = true; editText('확인 질문 — 전체 선택 후 복사 (자동 복사 미지원 환경)', WIZ_TEST_PROMPT).then(() => { document.getElementById('wizModal').hidden = false; }); };
      if (navigator.clipboard) navigator.clipboard.writeText(WIZ_TEST_PROMPT).then(() => toast('📋 확인 질문 복사됨 — 설계 대화에 붙여넣고 전송'), manual);
      else manual();
    });
    if (wz('wizOpenChat')) wz('wizOpenChat').addEventListener('click', () => {
      const u = projectUrl();
      if (u) openExternal(u);
      else toast('먼저 🔗 Project URL 저장');
    });
  }
  // ① 작업 목록(task md) "🚀 진행" → 폰 터미널에서 이어받기 (PC 창 X — 외출 중 폰 조작)
  document.getElementById('sessionList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-runtask]');
    if (b) newSession({ runTask: b.dataset.runtask });
  });
  // ② 결정 필요(spec) 버튼: 이어서/task_save/정리
  document.getElementById('specList').addEventListener('click', onSpecTap);
  // 📞 라이브 터미널 카드 → 복귀
  document.getElementById('liveList').addEventListener('click', onLiveTap);
  document.getElementById('quickReplies').addEventListener('click', onQuickReplyTap);   // E9 탭 승인
  // #1 입력 보존 — quick-reply 탭이 termInput focus 를 안 뺏게(치던 글·키보드 유지). mousedown 막으면 click 은 발생.
  document.getElementById('quickReplies').addEventListener('mousedown', (e) => { if (e.target.closest('[data-qr]')) e.preventDefault(); });
  document.querySelectorAll('[data-goto]').forEach((el) =>
    el.addEventListener('click', (e) => { e.preventDefault(); showTab(el.dataset.goto); }));

  // 멀티세션 터미널 overlay 이벤트 + 한국어 IME 가드 (A1+A3+A6 — A2 buffer 제거 정정)
  document.getElementById('termClose').addEventListener('click', closeActiveSession);
  document.getElementById('termMinimize').addEventListener('click', goBackTerminal);   // E4 — history.back 경유
  window.addEventListener('popstate', onTermPopstate);   // E4 — Android 백버튼/iOS swipe → overlay minimize
  // 세션 영속 — 페이지 이탈 직전 상태 저장(터미널 열림 여부 + 활성 세션명) → 재진입 시 restoreLiveSessions 가 복원
  window.addEventListener('pagehide', () => {
    const ov = document.getElementById('termOverlay');
    localStorage.setItem('cmbTermOpen', (ov && !ov.hidden && SESSIONS.size > 0) ? '1' : '0');
    const s = activeSession();
    localStorage.setItem('cmbActiveName', s ? s.name : '');
  });
  initPullToRefresh();   // E3 — 당겨서 새로고침
  resyncPush();          // 🅳 — 권한 있으면 daemon 에 구독 재등록(재시작 복구)
  // 버그1 — 모바일 키보드(visualViewport) 변화 시 터미널 overlay 높이 재조정
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitTermToViewport);
    window.visualViewport.addEventListener('scroll', fitTermToViewport);
  }
  initSwipeActions(document.getElementById('specList'));    // E2 — 결정필요 카드 왼쪽 swipe → 이어서
  initSwipeActions(document.getElementById('inboxList'));
  document.getElementById('termSend').addEventListener('click', termSendLine);
  document.getElementById('termAttach').addEventListener('click', attachFile);   // 🅲 첨부 시트
  document.getElementById('attachClose').addEventListener('click', () => { document.getElementById('attachSheet').hidden = true; });
  document.getElementById('attachGallery').addEventListener('click', pickGallery);    // 🅲-1 갤러리/카메라
  document.getElementById('attachFiles').addEventListener('click', openFileBrowser);  // 🅲-2 PC 파일 검색
  document.getElementById('fileClose').addEventListener('click', () => { document.getElementById('fileModal').hidden = true; });
  document.getElementById('fileList').addEventListener('click', onFileListTap);
  document.getElementById('fileSearch').addEventListener('input', (e) => { const l = document.getElementById('fileList'); loadFiles(l._curDir || '', e.target.value); });
  document.getElementById('termManual').addEventListener('click', showManualReplies);   // #2 승인 버튼 강제 표시
  initVoiceInput();   // G1 — 🎤 음성 입력 (Web Speech, 미지원 시 숨김)
  document.getElementById('termStatus').addEventListener('click', showStatusline);   // ℹ︎ statusline 창
  document.getElementById('termFullscreen').addEventListener('click', toggleFullscreen);   // ⛶ 칸 넓게(헤더/탭 접기)
  document.getElementById('slClose').addEventListener('click', () => { document.getElementById('slModal').hidden = true; });
  document.getElementById('slCopy').addEventListener('click', () => {
    const t = slStrip(slRaw || document.getElementById('slText').textContent || '');   // ANSI 제거본 복사
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('📋 복사됨'), () => toast('복사 실패'));
    else toast('복사 미지원');
  });
  // #8: xterm 본문 탭 → 하단 입력칸으로 포커스 + 흔들림 힌트 (입력 통로 단일 유도)
  document.getElementById('termBody').addEventListener('click', () => {
    focusTermInput();
    const bar = document.querySelector('.term-input-bar');
    if (bar) { bar.classList.remove('shake'); void bar.offsetWidth; bar.classList.add('shake'); setTimeout(() => bar.classList.remove('shake'), 340); }
  });
  document.getElementById('termTabs').addEventListener('click', onSessionTabTap);
  const ti = document.getElementById('termInput');
  // A6: composition lifecycle 추적 (TERM_COMPOSING global flag — input event buffer 영구 제거)
  ti.addEventListener('compositionstart', () => { TERM_COMPOSING = true; });
  ti.addEventListener('compositionend', () => { TERM_COMPOSING = false; });
  ti.addEventListener('keydown', (e) => {
    // A3: keydown Enter 가드 = 3중 (composing flag + e.isComposing + e.keyCode 229)
    if (e.key === 'Enter' && !TERM_COMPOSING && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      termSendLine();
    }
  });

  showTab('dashboard');
  // C (2026-06-04) — 알림 탭 딥링크 ?session=<name> → 그 세션 자동 진입 (restoreLiveSessions 가 PENDING_OPEN 처리). 동기 설정이라 아래 .then 콜백보다 먼저.
  try { const sp = new URLSearchParams(location.search).get('session'); if (sp) PENDING_OPEN = sp; } catch (_) {}
  checkHealth().then(() => { renderSettings(); renderFab(currentTab()); schedulePoll(); restoreLiveSessions(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // 앱이 이미 열려있을 때 알림 body 탭 → sw 가 세션명 postMessage → 그 세션 진입(없으면 복원 후 진입)
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-session' && e.data.name) {
        if (!openSessionByName(e.data.name)) { PENDING_OPEN = e.data.name; restoreLiveSessions(); }
      }
    });
  }
}

function currentTab() {
  return document.querySelector('.tab.is-active')?.dataset.tab || 'dashboard';
}

// ── M1: mirror 상태 배지 (설계 탭) ──
async function renderMirrorBadge() {
  let el = document.getElementById('mirrorBadge');
  if (!el) {
    el = document.createElement('div'); el.id = 'mirrorBadge';
    el.style.cssText = 'padding:6px 12px;font-size:12px;border-radius:8px;margin:4px 0';
    const list = document.getElementById('inboxList');
    if (list) list.parentElement.insertBefore(el, list);
  }
  try {
    const r = await dfetch(`${daemonBase()}/mirror`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const m = await r.json();
    if (!m.configured) { el.hidden = true; return; }
    el.hidden = false;
    if (m.fresh) {
      const ago = m.ageH < 1 ? '방금' : `${Math.floor(m.ageH)}시간 전`;
      el.textContent = `☁ KB 동기 정상 (${ago})`;
      el.style.background = '#1a2e1a'; el.style.color = '#7ee87e';
    } else {
      const days = Math.floor(m.ageH / 24);
      el.textContent = `⏳ KB mirror ${days}일+ 미동기 — 클라우드 설계가 옛 기준`;
      el.style.background = '#2e2a1a'; el.style.color = '#e8c87e';
    }
  } catch (_) {
    el.hidden = true;
  }
  // 전송 완료 카드
  try {
    const flush = JSON.parse(localStorage.getItem('cmbLastFlush') || 'null');
    let fc = document.getElementById('flushCard');
    if (flush && Date.now() - flush.ts < 3600000) {
      if (!fc) {
        fc = document.createElement('div'); fc.id = 'flushCard';
        fc.style.cssText = 'padding:6px 12px;font-size:12px;border-radius:8px;margin:4px 0;background:#1a2e1a;color:#7ee87e';
        el.parentElement.insertBefore(fc, el.nextSibling);
      }
      const when = new Date(flush.ts).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      fc.textContent = `✅ 설계 ${flush.count}건 PC 전송 완료 (${when})`;
      fc.hidden = false;
    } else if (fc) { fc.hidden = true; }
  } catch (_) {}
}

// ── M4: 스킬 런처 버튼 + 모달 (설계 탭) ──
function renderSkillLauncher() {
  if (document.getElementById('skillLauncherBtn')) return;
  const cloud = document.getElementById('newCloudDesign');
  if (!cloud) return;
  const btn = document.createElement('button');
  btn.id = 'skillLauncherBtn';
  btn.className = 'qr-btn';
  btn.textContent = '📋 스킬';
  btn.style.cssText = 'margin-left:6px';
  cloud.parentElement.insertBefore(btn, cloud.nextSibling);
  btn.addEventListener('click', showSkillModal);
}

const MOBILE_SKILLS = [
  { icon: '🔍', name: '리서치', cmd: 'mobile-research 절차대로 리서치 해줘', desc: '서칭+학습 — 레퍼런스 수집' },
  { icon: '🗂', name: '정리', cmd: 'mobile-curate 절차대로 정리 해줘', desc: '카탈로그 검토+추천' },
  { icon: '🎯', name: '폴리시 (분석)', cmd: 'mobile-polish-plan 절차대로 분석 해줘', desc: '고도화 분석 (코드 X)' },
];

function showSkillModal() {
  let modal = document.getElementById('skillModal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'skillModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.7);display:flex;align-items:flex-end;justify-content:center';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:#1a1a2e;border-radius:16px 16px 0 0;padding:16px;width:100%;max-width:440px;max-height:70vh;overflow-y:auto';
    sheet.innerHTML = '<div style="text-align:center;font-weight:bold;margin-bottom:12px">📋 모바일 스킬</div>'
      + MOBILE_SKILLS.map((s) =>
        `<div style="background:#252540;border-radius:10px;padding:10px 12px;margin:6px 0">`
        + `<div style="font-weight:bold">${s.icon} ${s.name}</div>`
        + `<div style="font-size:12px;color:#999;margin:2px 0">${s.desc}</div>`
        + `<div style="display:flex;align-items:center;gap:6px;margin-top:6px">`
        + `<code style="flex:1;font-size:11px;background:#1a1a2e;padding:4px 6px;border-radius:6px;word-break:break-all">"${s.cmd}"</code>`
        + `<button class="qr-btn skill-copy" data-skill-cmd="${s.cmd}" style="white-space:nowrap">복사</button>`
        + `</div></div>`
      ).join('')
      + '<div style="font-size:11px;color:#666;margin-top:8px;text-align:center">⚠ PC 전용: push / pull / sync</div>'
      + '<button id="skillModalClose" class="qr-btn" style="width:100%;margin-top:10px">닫기</button>';
    modal.appendChild(sheet);
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
      const cp = e.target.closest('.skill-copy');
      if (cp) {
        const cmd = cp.dataset.skillCmd;
        if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(() => toast('📋 복사됨'), () => toast('복사 실패'));
        else { modal.hidden = true; editText('스킬 호출 문구 — 선택 후 복사', cmd).then(() => { modal.hidden = false; }); }
      }
    });
    document.getElementById('skillModalClose').addEventListener('click', () => { modal.hidden = true; });
  }
  modal.hidden = false;
}

// ── M1: 대시보드 도착 카드 (FULL 모드) ──
async function loadArrivalCard() {
  let el = document.getElementById('arrivalCard');
  if (!el) {
    el = document.createElement('div'); el.id = 'arrivalCard';
    el.style.cssText = 'cursor:pointer';
    el.className = 'card';
    const dash = document.getElementById('specList');
    if (dash) dash.parentElement.insertBefore(el, dash);
    el.addEventListener('click', () => showTab('design'));
  }
  try {
    const r = await dfetch(`${daemonBase()}/inbox`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const items = await r.json();
    const pending = items.filter((it) => it.status === 'pending');
    const cloud = pending.filter((it) => it.origin === 'mobile-cloud' || it.origin === 'mobile');
    if (!pending.length) { el.hidden = true; return; }
    el.hidden = false;
    const when = pending[0].createdAt ? new Date(pending[0].createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const src = cloud.length ? '☁' : '📤';
    el.innerHTML = `<strong>${src} 설계 ${pending.length}건 도착</strong><span class="dim">${when ? when + ' · ' : ''}탭하면 설계 탭</span>`;
  } catch (_) { el.hidden = true; }
}

document.addEventListener('DOMContentLoaded', init);
