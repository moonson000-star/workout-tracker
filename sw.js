// 오프라인 지원: 앱 파일을 캐시하고, 네트워크 우선으로 최신 버전을 받아옴
const CACHE = 'workout-tracker-v11';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'calc.js', 'exercises.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 같은 사이트 파일은 브라우저 HTTP 캐시(GitHub Pages는 약 10분)를 건너뛰고 서버에 최신 여부를 확인
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  const network = sameOrigin ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    network
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
