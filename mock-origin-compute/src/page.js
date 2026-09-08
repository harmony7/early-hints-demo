// 擬似オリジンが返すページと資材の定義。
//
// このファイルは Fastly 固有の API を使わない。
// オリジンは「普通のバックエンド」の代役なので、他所へ移せる状態にしておく。

/**
 * デバイスごとに読み込む資材のセット。
 * パターンA(edge 完結型)では edge 側が同じ知識を持ち、
 * パターンB(学習型)では Link ヘッダー経由で edge に伝わる。
 */
export const VARIANTS = {
  desktop: {
    css: '/assets/desktop.css',
    js: '/assets/desktop-app.js',
    hero: '/assets/hero-desktop.svg',
  },
  mobile: {
    css: '/assets/mobile.css',
    js: '/assets/mobile-app.js',
    hero: '/assets/hero-mobile.svg',
  },
};

/**
 * デバイス判定(オリジン側)。
 *
 * **ここでは `fastly:device` を使わない。意図的にそうしている。**
 * このオリジンは「どこにでもある普通のバックエンド」の代役なので、
 * Fastly の API に依存させない。実際、別のホスティングに移しても動く。
 *
 * その結果、判定精度は edge 側に負ける。edge は `fastly:device` で
 * 端末データベースを引けるが、こちらは User-Agent の正規表現しかない。
 * **この非対称こそが「ヒントは edge で組む」理由**でもある。
 *
 * @param {string | null | undefined} userAgent
 */
export function detectDeviceType(userAgent) {
  return /Mobile|Android|iPhone|iPad/i.test(userAgent ?? '') ? 'mobile' : 'desktop';
}

/**
 * 200 レスポンスに付ける Link ヘッダー。
 * パターンB では edge がこの値を KV Store に記憶し、
 * 次回リクエストで 103 として先出しする。
 */
export function buildLinkHeader(variant) {
  return [
    `<${variant.css}>; rel=preload; as=style`,
    `<${variant.js}>; rel=preload; as=script`,
    `<${variant.hero}>; rel=preload; as=image`,
  ].join(', ');
}

/**
 * 資材の Cache-Control。
 *
 * ここは `no-store` にしてはいけない。Early Hints で preload した資材は
 * ブラウザの HTTP キャッシュに入り、その後 HTML から参照されたときに
 * そこから取り出される。保存できないと二重フェッチになり、
 * 先読みの効果が丸ごと消える。
 *
 * 同じ理由で、DevTools の "Disable cache" もオフにしておく必要がある。
 */
export const ASSET_CACHE_CONTROL = 'public, max-age=60';

/**
 * HTML の Cache-Control。
 * こちらは毎回オリジンの think time を再現したいので保存させない。
 */
export const HTML_CACHE_CONTROL = 'no-store';

export const ASSETS = {
  '/assets/desktop.css': {
    type: 'text/css; charset=utf-8',
    body: `:root { --accent: #e01a4f; --max-width: 960px; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 2rem; max-width: var(--max-width); line-height: 1.7; }
h1 { color: var(--accent); font-size: 2.4rem; }
.variant strong { color: var(--accent); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td { border-bottom: 1px solid #ddd; padding: 0.2rem 0.4rem; }
`,
  },
  '/assets/mobile.css': {
    type: 'text/css; charset=utf-8',
    body: `:root { --accent: #0a7cff; --max-width: 420px; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: var(--max-width); line-height: 1.6; }
h1 { color: var(--accent); font-size: 1.6rem; }
.variant strong { color: var(--accent); }
.grid { display: grid; grid-template-columns: 1fr; gap: 1rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td { border-bottom: 1px solid #ddd; padding: 0.2rem 0.4rem; }
`,
  },
  '/assets/desktop-app.js': {
    type: 'text/javascript; charset=utf-8',
    body: `document.getElementById('app-status').textContent = 'desktop-app.js 実行済み';\n`,
  },
  '/assets/mobile-app.js': {
    type: 'text/javascript; charset=utf-8',
    body: `document.getElementById('app-status').textContent = 'mobile-app.js 実行済み';\n`,
  },
  '/assets/hero-desktop.svg': {
    type: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="180"><rect width="880" height="180" fill="#e01a4f"/><text x="24" y="105" font-family="sans-serif" font-size="48" fill="#fff">hero-desktop.svg</text></svg>`,
  },
  '/assets/hero-mobile.svg': {
    type: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="140"><rect width="380" height="140" fill="#0a7cff"/><text x="16" y="80" font-family="sans-serif" font-size="26" fill="#fff">hero-mobile.svg</text></svg>`,
  },
};

/**
 * パターンC(マニフェスト型)が読む「route → variant → 資材」の一覧。
 *
 * 本来はビルド時に生成するもの。ここでは擬似オリジンがその場で組んでいる。
 *
 * **全 variant をまとめて返し、`Vary` は付けない。**
 * デバイスごとに出し分けて `Vary: user-agent` を付けると、
 * User-Agent はブラウザのバージョンごとに違うため、
 * キャッシュが 1 リクエストにつき 1 オブジェクトまで断片化して意味がなくなる。
 * マニフェスト自体はビルドの成果物でデバイスに依存しないので、
 * まとめて配って **選ぶのは edge の仕事**にするのが素直。
 */
export function buildManifest() {
  const entriesFor = (v) => [
    { href: v.css, as: 'style' },
    { href: v.js, as: 'script' },
    { href: v.hero, as: 'image' },
  ];
  return {
    '/': {
      desktop: entriesFor(VARIANTS.desktop),
      mobile: entriesFor(VARIANTS.mobile),
    },
  };
}

export const MANIFEST_PATH = '/build-manifest.json';

export function isHtmlPath(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

/**
 * デモページ本体。計測値をページ内に表示するので、
 * DevTools を開かなくても Before/After の差が読める。
 */
export function renderHtml({ deviceType, variant, thinkTime, assetDelay }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>103 Early Hints デモ</title>
<link rel="stylesheet" href="${variant.css}">
</head>
<body>
<h1>待たせない、優しいエッジ</h1>
<p class="variant">判定されたデバイス: <strong>${deviceType}</strong> / 適用 CSS: <strong>${variant.css}</strong></p>
<img src="${variant.hero}" alt="hero">
<div class="grid">
  <section>
    <h2>ページの状態</h2>
    <p id="app-status">app.js 未実行</p>
    <p>オリジンの think time: <strong>${thinkTime}ms</strong><br>
       各資材の遅延: <strong>${assetDelay}ms</strong></p>
    <p><a href="?hints=off">?hints=off で 103 を止める(Before)</a> /
       <a href="?">103 あり(After)</a></p>
  </section>
  <section>
    <h2>Navigation Timing</h2>
    <table id="timings"><tbody></tbody></table>
    <p><small><strong>responseStart(= TTFB)は 103 の到達時刻を含む</strong>ので、
    Early Hints を有効にすると「オリジンの処理が速くなっていなくても」下がって見える。
    オリジンが実際にどれだけ考えていたかは finalResponseHeadersStart との差に出る。</small></p>
  </section>
</div>
<script src="${variant.js}" defer></script>
<script>
addEventListener('load', () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const tbody = document.querySelector('#timings tbody');
  if (!nav || !tbody) return;
  const row = (label, text) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    const b = document.createElement('td');
    a.textContent = label;
    b.textContent = text;
    b.style.textAlign = 'right';
    tr.append(a, b);
    tbody.appendChild(tr);
  };
  const ms = (v) => {
    if (v === undefined) return 'このブラウザでは未対応';
    if (v === 0) return '0(該当なし)';
    return v.toFixed(1) + ' ms';
  };
  row('requestStart', ms(nav.requestStart));
  // 103 が届いた時刻。103 が無ければ 0 になる
  row('firstInterimResponseStart (103 の到達)', ms(nav.firstInterimResponseStart));
  // TTFB の定義。103 を含むので Early Hints で下がる
  row('responseStart (= TTFB, 103 を含む)', ms(nav.responseStart));
  // 実際の 200 のヘッダー到達時刻。標準名と Chrome 独自名の両方を出す
  row('finalResponseHeadersStart (標準名)', ms(nav.finalResponseHeadersStart));
  row('firstResponseHeadersStart (Chrome 133+)', ms(nav.firstResponseHeadersStart));
  row('responseEnd', ms(nav.responseEnd));
  row('domContentLoadedEventEnd', ms(nav.domContentLoadedEventEnd));
  row('loadEventEnd', ms(nav.loadEventEnd));
  for (const r of performance.getEntriesByType('resource')) {
    row(new URL(r.name).pathname, '開始 ' + r.startTime.toFixed(1) + ' ms / ' + r.duration.toFixed(1) + ' ms');
  }
});
</script>
</body>
</html>
`;
}
