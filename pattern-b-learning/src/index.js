/// <reference types="@fastly/js-compute" />

// パターンB: 学習型(バックエンドの Link ヘッダーを edge が覚えて次回先出し)
//
// バックエンドは普段どおり 200 レスポンスに `Link: <...>; rel=preload` を付けるだけ。
// edge はそのヘッダーを KV Store に記憶し、次回の同じリクエストでは
// オリジンに問い合わせる前に 103 Early Hints として先出しする。
//
// 弱点: 初回アクセスには効かない(KV が空なので何も先出しできない)。
// Shopify / Cloudflare の Early Hints 実装もこの系統。
//
// 必要な SDK バージョン: @fastly/js-compute >= 3.40.1
//   3.40.0 以前は「FetchEvent ハンドラの同期実行中か」の判定があり、
//   `await store.get()` を挟むこのパターンは動かない。
//
// 動作確認用に `?hints=off` を付けると 103 を送らない(Before の比較用)。

import { Device } from 'fastly:device';
import { KVStore } from 'fastly:kv-store';

addEventListener('fetch', (event) => event.respondWith(handler(event)));

const STORE_NAME = 'early-hints-cache';

/** デバイス判定。Fastly の端末データベースを引く。 */
function detectDeviceType(userAgent) {
  // 空文字を渡すと Device.lookup が TypeError を投げるので先に弾く
  if (!userAgent) return 'desktop';

  const device = Device.lookup(userAgent);
  if (device?.isMobile === true || device?.isTablet === true) return 'mobile';
  if (device?.isDesktop === true) return 'desktop';
  return 'desktop'; // 判定できない場合の既定値
}

/**
 * キャッシュキーは「ヒントが同一になる単位」で切る。
 * このオリジンはデバイスごとに違う資材を参照するので、device を鍵に含める。
 *
 * ここを URL だけにすると、あるユーザー向けに組んだヒントが
 * 別のユーザーに配られてしまう。パーソナライズされたヒント
 * (地域・ログイン状態・セッション等)を扱うときの最重要ポイント。
 *
 * 逆に、鍵を細かくしすぎるのも同じくらい駄目。
 * User-Agent をそのまま鍵にすると、ブラウザのバージョンごとに別エントリになり、
 * 学習したヒントがほぼ再利用されない。
 * **「ヒントが変わる次元」だけを、取りうる値が少ない形で入れる。**
 */
function buildCacheKey(request) {
  const url = new URL(request.url);
  // KV のキーには `#;?^|` と改行を含められないので、区切りには `:` を使う
  return `${url.pathname}:${detectDeviceType(request.headers.get('user-agent'))}`;
}

/**
 * ヒントの**学習と先出し**の対象にするリクエストか。
 *
 * パターンA の `shouldSendHints` と名前が違うのは意図的。あちらは
 * 「103 を送るか」だけを決めるが、こちらは KV の読み書きごと通すかを決める。
 * false なら素通しのプロキシになり、学習もしない。
 *
 * **`?hints=off` をここに入れてはいけない。**
 * off でも「学習は続ける / 送出だけ止める」のが正しい(下の `hintsEnabled`)。
 * ここに入れると Before の計測中に学習が止まり、
 * 「1回目は効かない、2回目から効く」の対比が
 * どの URL を先に踏んだかで変わってしまう。
 */
function shouldHandle(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  // `Sec-Fetch-Dest: document` はトップレベルのナビゲーションだけを指すので
  // これ 1 本で足りる(iframe は `iframe`、fetch/XHR は `empty`)
  const dest = request.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  return true;
}

async function handler(event) {
  const request = event.request;
  const url = new URL(request.url);

  if (!shouldHandle(request)) {
    return fetch(request, { backend: 'origin' });
  }

  const store = new KVStore(STORE_NAME);
  const cacheKey = buildCacheKey(request);
  const hintsEnabled = url.searchParams.get('hints') !== 'off';

  // ① オリジンへのリクエストを先に投げる。**ここでは await しない。**
  //
  //    KV の読み取りには実測で 200ms ほどかかる。これを直列にすると
  //    その 200ms がまるごとページの表示時間に乗ってしまう。
  //    先に投げておけば、KV 読み取りはオリジンの think time に隠れる。
  //
  //    `Promise.all` は使えない。あれは両方揃うまで待つので、
  //    ヒントを送れるのがオリジンの応答後になり、先読みの窓が消える。
  //    **KV の結果は早く、オリジンの結果は遅く**受け取る必要がある。
  const originPromise = fetch(request, { backend: 'origin' });

  // ② 前回学習した Link ヘッダーがあれば 103 で先出し(①と並行して走る)
  if (hintsEnabled) {
    try {
      const cachedEntry = await store.get(cacheKey);
      if (cachedEntry) {
        const linkHeaderValue = await cachedEntry.text();
        event.sendEarlyHints(parseLinkHeader(linkHeaderValue));
        console.log(`early hints sent from cache: ${cacheKey}`);
      } else {
        console.log(`cache miss (初回アクセスには効かない): ${cacheKey}`);
      }
    } catch (err) {
      // ヒントは best-effort。KV が落ちてもページは返す。
      console.error(`KV から読めなかったのでヒントは送らない: ${err}`);
    }
  }

  // ③ オリジンの応答を待つ
  const response = await originPromise;

  // ④ 今回の Link ヘッダーを次回用に学習し直す
  //    レスポンス返却をブロックしないよう waitUntil に逃がす
  const linkHeader = response.headers.get('link');
  if (linkHeader) {
    event.waitUntil(
      store.put(cacheKey, linkHeader, { ttl: 3600 }).then(
        () => console.log(`learned: ${cacheKey} -> ${linkHeader}`),
        (err) => console.error(`failed to learn ${cacheKey}: ${err}`),
      ),
    );
  }

  return response;
}

/**
 * `<a>; rel=preload, <b>; rel=preload` を sendEarlyHints が受け取れる形に分解する。
 *
 * 単純な `split(', ')` は `rel="preload, next"` のような引用符内のカンマで壊れるので、
 * 引用符の外のカンマだけで区切る。
 */
function parseLinkHeader(value) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);

  return values
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => ['Link', v]);
}
