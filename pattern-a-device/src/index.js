/// <reference types="@fastly/js-compute" />

// パターンA: edge 完結型(デバイス判定)
//
// edge がリクエストの文脈(ここでは User-Agent)だけを見て、
// ビルド時に決まっているリソースセットからその場で 103 Early Hints を組み立てる。
// バックエンドは一切関与しないので、初回アクセスから効く。
//
// 動作確認用に `?hints=off` を付けると 103 を送らない(Before の比較用)。

import { Device } from 'fastly:device';

addEventListener('fetch', (event) => event.respondWith(handler(event)));

/**
 * デバイスごとに先読みさせたいリソース(オリジンが返す HTML と対応させておく)。
 *
 * 本番では preload だけでなく preconnect も併記しておくとよい。
 * Safari は Early Hints の preload に対応しておらず preconnect のみなので、
 * 別オリジンの資材があるなら
 *   ['Link', '<https://cdn.example.com>; rel=preconnect']
 * を足しておくと、Safari でも接続確立だけは先に済ませられる。
 */
const HINT_RESOURCES = {
  mobile: [
    ['Link', '</assets/mobile.css>; rel=preload; as=style'],
    ['Link', '</assets/mobile-app.js>; rel=preload; as=script'],
    ['Link', '</assets/hero-mobile.svg>; rel=preload; as=image'],
  ],
  desktop: [
    ['Link', '</assets/desktop.css>; rel=preload; as=style'],
    ['Link', '</assets/desktop-app.js>; rel=preload; as=script'],
    ['Link', '</assets/hero-desktop.svg>; rel=preload; as=image'],
  ],
};

/**
 * デバイス判定。Fastly の端末データベースを引く。
 * 自前の User-Agent 正規表現より精度が高く、メンテナンスも不要。
 */
function detectDeviceType(userAgent) {
  // 空文字を渡すと Device.lookup が TypeError を投げるので先に弾く
  if (!userAgent) return 'desktop';

  const device = Device.lookup(userAgent);
  if (device?.isMobile === true || device?.isTablet === true) return 'mobile';
  if (device?.isDesktop === true) return 'desktop';
  return 'desktop'; // 判定できない場合の既定値
}

/**
 * 103 を送る価値があるリクエストか。
 *
 * ブラウザが Early Hints を処理するのはトップレベルのナビゲーションだけ。
 * サブリソースの取得や fetch() に送っても無視されるだけなので、絞っておく。
 */
function shouldSendHints(request) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);
  if (url.searchParams.get('hints') === 'off') return false; // Before 比較用
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;

  // `Sec-Fetch-Dest: document` は「トップレベルのナビゲーション」だけを指す。
  // iframe は `iframe`、fetch/XHR は `empty` になるので、これ 1 本で足りる
  // (`Sec-Fetch-Mode: navigate` は iframe のナビゲーションも通してしまう)。
  //
  // ヘッダーが無いとき(curl や古いブラウザ)は通す。ヒントを送っても
  // 無視されるだけなので、弾くほどのものではない。
  const dest = request.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;

  return true;
}

async function handler(event) {
  const request = event.request;

  if (shouldSendHints(request)) {
    const deviceType = detectDeviceType(request.headers.get('user-agent'));
    // オリジンへ問い合わせる前に 103 を送るのがポイント。
    // ブラウザはオリジンが考えている間に資材の取得を始められる。
    event.sendEarlyHints(HINT_RESOURCES[deviceType]);
  }

  return await fetch(request, { backend: 'origin' });
}
