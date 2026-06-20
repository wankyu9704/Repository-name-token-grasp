/* ClaudeMobileBridge — service worker (앱 셸 캐시, 오프라인 구동) */
const CACHE = 'cmb-shell-v92';   // bump 시 index.html 의 .ver-chip 도 같은 번호로
const SHELL = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // daemon API(/health, /config, /sessions …)는 캐시 X — 항상 네트워크
  if (url.port === '8787' || /\/(health|config|sessions|inbox|push|prompts|ptys|jobs|design|files|statusline|tunnel)/.test(url.pathname)) return;
  // 앱 셸 = network-first: 항상 최신 받고(갱신 자동), 네트워크 실패 시에만 캐시 fallback(오프라인).
  // 옛 cache-first 는 새 코드 배포해도 PWA 가 옛 캐시를 계속 읽던 문제 → network-first 로 해소.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// 🅳 Web Push — 앱 닫혀도 알림 드로어/잠금화면(카톡식). userVisibleOnly 강제로 showNotification 필수.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Claude', {
    body: d.body || '입력을 기다립니다',
    tag: d.name || 'claude',          // 같은 세션 알림은 1개로 합침(도배 방지)
    renotify: true,
    icon: './icon.png',
    badge: './icon.png',
    data: { name: d.name || '', danger: !!d.danger, base: d.base || '' },
    // E11+A2 — 일반 프롬프트=[승인]/[거부]. 위험 프롬프트(d.danger)=승인 버튼 제거(blind approve 차단, SymJack 류), 거부만 + 탭하면 앱에서 컨텍스트 확인.
    // G2 (2026-06-04) — 정보성(d.info, idle/완료)=액션 버튼 0(승인 대상 아님), 탭하면 앱 열림.
    actions: d.info ? [] : (d.danger ? [{ action: 'reject', title: '❌ 거부' }] : [{ action: 'approve', title: '✅ 승인' }, { action: 'reject', title: '❌ 거부' }]),
  }));
});
// 알림 탭/액션 — E11: [승인]/[거부] 액션은 앱 안 열고 daemon 에 직접 전송. body 탭 = 열린 PWA 포커스(없으면 새 창).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const name = (e.notification.data && e.notification.data.name) || '';
  if (e.action === 'approve' || e.action === 'reject') {
    // E2 (2026-06-12) — waitUntil 은 *인자로 받은 Promise 만* 추적 (부분 래핑 = sw 조기 종료 위험) → 단일 async IIFE.
    // 실패 silent 제거: 전송 실패/거부 응답 시 재알림 (tag 고정 = 도배 방지) — "승인했는데 안 됨" 즉시 인지.
    e.waitUntil((async () => {
      let failReason = '';
      try {
        const base = (e.notification.data && e.notification.data.base) || '';
        const replyUrl = base ? `${base}/push/reply` : './push/reply';
        const r = await fetch(replyUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action: e.action }),
          keepalive: true,
          mode: base ? 'cors' : 'same-origin',
        });
        const res = await r.json().catch(() => null);
        if (!res || !res.ok) failReason = (res && res.reason) || ('HTTP ' + r.status);
      } catch (err) { failReason = '네트워크/daemon 연결 실패'; }
      if (failReason) {
        await self.registration.showNotification('⚠️ 전송 실패 — 앱 열어 확인', {
          body: (name ? name + ': ' : '') + failReason,
          tag: (name || 'claude') + '-replyfail',
          icon: './icon.png', badge: './icon.png',
          data: { name, info: true },
        });
      }
    })());
    return;
  }
  // C (2026-06-04) — body 탭 = 그 task 터미널 자동 진입. 열린 PWA 있으면 포커스 + 세션명 전달, 없으면 ?session= 딥링크로 새 창.
  const target = name ? `./?session=${encodeURIComponent(name)}` : './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.focus) { if (name) c.postMessage({ type: 'open-session', name }); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
