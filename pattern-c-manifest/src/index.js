/// <reference types="@fastly/js-compute" />

// パターンC: マニフェスト型(バックエンドが資材の一覧を公開する)
//
// バックエンドがビルド時に生成した「route → 必要な資材」の JSON を公開し、
// edge がそれを取得・キャッシュしてヒントを組み立てる。
//
// パターンA の弱点(edge が資材の一覧を二重に持つ)と
// パターンB の弱点(初回アクセスに効かない)の両方を解消できる。
// 代わりにバックエンド側にマニフェストを出す実装コストがかかる。
//
// 必要な SDK バージョン: @fastly/js-compute >= 3.40.1
//   マニフェストを取ってからヒントを決めるので、`await` の後に
//   sendEarlyHints を呼ぶ必要がある。3.40.0 以前は同期呼び出しのみ。
//
// 動作確認用に `?hints=off` を付けると 103 を送らない(Before の比較用)。

import { CacheOverride } from 'fastly:cache-override';
import { Device } from 'fastly:device';

addEventListener('fetch', (event) => event.respondWith(handler(event)));

const MANIFEST_PATH = '/build-manifest.json';

/**
 * マニフェストを取得する。
 *
 * 毎リクエストでオリジンまで行かせないよう TTL を付けるのが実務上の要点。
 * デプロイごとにしか変わらないので、長めに持たせてよい。
 *
 * マニフェストは**デバイスに依存しない**(全 variant が入っている)。
 * だから `Vary` が要らず、全リクエストが同じ 1 オブジェクトを共有できる。
 * デバイスで出し分けて `Vary: user-agent` を付けると、
 * User-Agent の種類だけキャッシュが分裂して TTL の意味がなくなる。
 */
async function getManifest(url) {
  const response = await fetch(new URL(MANIFEST_PATH, url), {
    backend: 'origin',
    cacheOverride: new CacheOverride({ ttl: 300 }),
  });
  return response.json();
}

/** デバイス判定。パターンA / B と同じロジック。 */
function detectDeviceType(userAgent) {
  // 空文字を渡すと Device.lookup が TypeError を投げるので先に弾く
  if (!userAgent) return 'desktop';

  const device = Device.lookup(userAgent);
  if (device?.isMobile === true || device?.isTablet === true) return 'mobile';
  if (device?.isDesktop === true) return 'desktop';
  return 'desktop'; // 判定できない場合の既定値
}

function buildHints(entries) {
  return entries.map((entry) => {
    const rel = entry.rel ?? 'preload';
    const as = entry.as ? `; as=${entry.as}` : '';
    return ['Link', `<${entry.href}>; rel=${rel}${as}`];
  });
}

/**
 * ヒントを送る価値があるリクエストか。
 * ブラウザが Early Hints を処理するのはトップレベルのナビゲーションだけ。
 */
function shouldSendHints(request) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);
  if (url.searchParams.get('hints') === 'off') return false; // Before 比較用
  if (url.pathname === MANIFEST_PATH) return false;

  // `Sec-Fetch-Dest: document` はトップレベルのナビゲーションだけを指すので
  // これ 1 本で足りる(iframe は `iframe`、fetch/XHR は `empty`)
  const dest = request.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;

  return true;
}

async function handler(event) {
  const request = event.request;

  if (shouldSendHints(request)) {
    // ヒントはあくまで best-effort。
    // マニフェストが取れなくても本体のレスポンスは必ず通す。
    try {
      const url = new URL(request.url);
      const manifest = await getManifest(url);
      // route を引いてから、この人向けの variant を選ぶ
      const deviceType = detectDeviceType(request.headers.get('user-agent'));
      const entries = manifest[url.pathname]?.[deviceType];
      if (entries) {
        event.sendEarlyHints(buildHints(entries));
        console.log(`hints from manifest: ${deviceType} / ${entries.length} 件`);
      }
    } catch (err) {
      console.error(`manifest が取れなかったのでヒントは送らない: ${err}`);
    }
  }

  return fetch(request, { backend: 'origin' });
}
