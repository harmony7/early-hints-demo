/// <reference types="@fastly/js-compute" />

// デプロイ用の擬似オリジン。
//
// パターンA/B を実 Fastly サービスで動かすには、Fastly から到達できるオリジンが必要。
// 外部にサーバを用意する代わりに、think time を持つ「遅いアプリサーバ」を
// もう一つの Compute サービスとして立てる。
//
// このサービス自身は Early Hints を一切送らない(edge 側の仕事なので)。
//
// 3 つのパターンすべてのオリジンを兼ねる:
//   パターンA … HTML を返すだけ(edge が資材を知っている)
//   パターンB … 200 に Link ヘッダーを付ける(edge がそれを学習する)
//   パターンC … /build-manifest.json を公開する(edge がそれを読む)

import {
  ASSETS,
  ASSET_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  MANIFEST_PATH,
  VARIANTS,
  buildLinkHeader,
  buildManifest,
  detectDeviceType,
  isHtmlPath,
  renderHtml,
} from './page.js';

const THINK_TIME = 2000;
const ASSET_DELAY = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

addEventListener('fetch', (event) => event.respondWith(handler(event)));

async function handler(event) {
  const { pathname } = new URL(event.request.url);

  if (pathname === '/healthz') {
    return new Response('ok\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // パターンC が読むマニフェスト。
  // 全 variant を 1 つのレスポンスで返し、Vary は付けない。
  // どの variant を使うかは edge が決める(理由は page.js の buildManifest 参照)。
  if (pathname === MANIFEST_PATH) {
    return new Response(JSON.stringify(buildManifest(), null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // ビルドごとにしか変わらないので長めに持たせてよい。
        // デバイス非依存なので、これで全リクエストが同じ 1 オブジェクトを共有できる。
        'cache-control': 'public, max-age=300',
      },
    });
  }

  const asset = ASSETS[pathname];
  if (asset) {
    await sleep(ASSET_DELAY);
    return new Response(asset.body, {
      headers: {
        'content-type': asset.type,
        'cache-control': ASSET_CACHE_CONTROL,
      },
    });
  }

  if (isHtmlPath(pathname)) {
    const headers = event.request.headers;
    const deviceType = detectDeviceType(headers.get('user-agent'));
    const variant = VARIANTS[deviceType];

    // ここが Early Hints で隠したい「オリジンが考えている時間」
    await sleep(THINK_TIME);

    const body = renderHtml({
      deviceType,
      variant,
      thinkTime: THINK_TIME,
      assetDelay: ASSET_DELAY,
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': HTML_CACHE_CONTROL,
        link: buildLinkHeader(variant), // パターンB の学習元になるヘッダー
        // `Vary: user-agent` は付けない。User-Agent はブラウザのバージョンごとに
        // 異なるため、共有キャッシュが 1 リクエスト 1 オブジェクトまで断片化する。
        // このページは no-store なのでそもそもキャッシュされないが、
        // 仮にキャッシュさせたいなら、edge で device を少数の値に正規化して
        // その独自ヘッダーに対して Vary させるのが定石。
      },
    });
  }

  return new Response('not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
