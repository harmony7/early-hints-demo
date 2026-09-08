# 103 Early Hints on Fastly Compute

HTTP **103 Early Hints** を Fastly Compute(JavaScript SDK)で**動的に**組み立てる
実装パターンを、実際に動く形で置いてあります。

オリジンが重い間、ブラウザは何もできずに待っています。
103 Early Hints はその待ち時間に「これから必要になる資材」を先に教える仕組みです。
ヒントを静的に仕込むだけでは、デバイスや文脈に応じた出し分けができません。
edge で組み立てれば、リクエストの文脈を見てその場で決められます。

Fastly Tech Meetup vol.1(2026-09-10)の登壇デモです。

## 最初に知っておくべきこと

> ### ⚠️ `fastly compute serve`(Viceroy)では 103 は実装されておりません
>
> ローカルでは「Viceroy のログに 103 が出ているか」までが確認の限界で、
> ブラウザでの効果は**実サービスにデプロイして**確認する必要があります。

## 3 つのパターン

| | A: edge 完結型 | B: 学習型 | C: マニフェスト型 |
|---|---|---|---|
| ヒントの出所 | edge が持つ静的な定義 | オリジンのレスポンス(KV Store に記憶) | ビルド時生成の JSON |
| 初回アクセス | ○ | × | ○ |
| 必須条件 | オリジンが必要とするリソース一覧を edge にあらかじめ保存 | オリジンのレスポンスが Link ヘッダーを出力すること | マニフェストを公開するビルド環境が必要(webpack、Vite、Next.js、Rails など) |
| 主な弱点 | 定義がビルド成果物とズレても気づけない | KV 読み取り分だけ先出しが遅れる | ビルドツールごとに形式が違う |

パターンB は Shopify や Cloudflare の Early Hints 実装と同じ系統です。

選び方の軸は 2 つだけです:

```
バックエンドを触れない            → A
触れるが、最小限にしたい          → B
初回アクセスから正確に効かせたい  → C
```

## ディレクトリ

| パス | 役割 |
| --- | --- |
| `mock-origin-compute/` | 擬似オリジン。**think time 2 秒**を持つ「遅いアプリサーバ」 |
| `pattern-a-device/` | `fastly:device` で端末を判定し、その場で 103 を組む |
| `pattern-b-learning/` | オリジンの `Link` を KVStore に学習し、次回リクエストで先出し |
| `pattern-c-manifest/` | オリジンが公開する資材マニフェストを読んで 103 を組む |

擬似オリジンは 3 パターンすべてのバックエンドを兼ねます:

- HTML を返す(A 用)
- 200 に `Link: rel=preload` を付ける(B の学習元)
- `/build-manifest.json` を公開する(C 用)

## 動かす

### 1. デプロイする(ブラウザで効果を見るならこちら)

オリジンも Compute サービスなので、外部にサーバを立てる必要はありません。

```bash
# 1) 擬似オリジン
cd mock-origin-compute
npm install
fastly compute publish --non-interactive --domain <好きな名前>.edgecompute.app
```

割り当てられたドメインを控えて、各パターンの `fastly.toml` の
`REPLACE-ME.edgecompute.app` を置き換えます:

```toml
[setup.backends.origin]
address = "<origin-domain>"
port = 443
```

```bash
# 2) 各パターン
cd ../pattern-a-device && npm install && fastly compute publish --non-interactive --domain <名前>.edgecompute.app
```

パターンB は `[setup.kv_stores]` を書いてあるので、KV ストア `early-hints-cache` の
作成も publish の流れで行われます。

### 2. ローカルで動かす(コードの確認まで)

```bash
npm --prefix mock-origin-compute install
npm --prefix mock-origin-compute start      # 127.0.0.1:8080

npm --prefix pattern-a-device install
npm --prefix pattern-a-device start         # 127.0.0.1:7676
```

`curl` では 103 は見えません。Viceroy のログに出る

```
WARN Guest returned informational response (103 ...) which will not be sent to the client
```

が、103 を正しく組み立てられている証拠になります。

## 103 が届いているかを確認する

**HTTP/2 で見る必要があります。** Fastly は 103 を HTTP/2 / HTTP/3 でのみ送ります。
`curl` は `-v` を付けないと 1xx を表示しません:

```bash
curl -sv --http2 -o /dev/null \
  -H 'sec-fetch-mode: navigate' -H 'sec-fetch-dest: document' \
  https://<pattern-a-domain>/ 2>&1 | grep -iE '^< (HTTP|link)'
```

```
< HTTP/2 103
< link: </assets/desktop.css>; rel=preload; as=style
< link: </assets/desktop-app.js>; rel=preload; as=script
< link: </assets/hero-desktop.svg>; rel=preload; as=image
< HTTP/2 200
< link: </assets/desktop.css>; rel=preload; as=style, ...
```

103 の `Link` は 1 本ずつ別ヘッダー、200 の `Link` はカンマ区切りの 1 本、
という違いもここで見えます。

### Before / After

どのパターンも **`?hints=off`** を付けると 103 を送りません。1 つのサービスで比較できます。

パターンB は Before/After ではなく「1 回目 / 2 回目」の比較になります。
初回は KV が空なので 103 が出ません。もう一度試すには KV のキーを消します:

```bash
fastly kv-store-entry delete --store-id <store-id> --key '/:desktop'
```

## 実装するときの落とし穴

実際に踏んで確認したものです。

| 落とし穴 | 内容 |
| --- | --- |
| **Viceroy では届かない** | `fastly compute serve` では 103 が破棄される。バージョンを上げても直らない |
| **Viceroy では端末判定も効かない** | `Device.lookup()` はローカルでは常に `null` を返す(端末データベースが無いため)。この実装では既定値の `desktop` に落ちるので、**ローカルでは常にデスクトップ扱いになる**。デバイス別の挙動を見るには実サービスが要る |
| **HTTP/2 以降が必須** | Fastly は 103 を HTTP/2 / HTTP/3 でのみ送る。平文 HTTP/1.1 は対象外 |
| **資材を `no-store` にすると無意味** | Early Hints の preload はブラウザの HTTP キャッシュ経由で使われる。保存できないと二重フェッチになり効果が消える |
| **DevTools の "Disable cache" も同様** | オンにすると Early Hints の効果が消える |
| **信頼されない証明書も NG** | Chrome は信頼されない証明書では HTTP キャッシュを無効化する |
| **ナビゲーションのみ** | ブラウザはトップレベルのナビゲーションにしか適用しない。`sec-fetch-dest: document` で絞る(`document` はトップレベルだけを指す。iframe は `iframe`、fetch/XHR は `empty`) |
| **`preload` / `preconnect` のみ** | `prefetch` は Early Hints では使えない |
| **KV のキーに使えない文字** | `#;?^\|` と改行は使えない。区切りに `\|` を使って `TypeError` を踏んだ |
| **`@fastly/js-compute` は 3.40.1 以降** | B と C は `await` の後に `sendEarlyHints` を呼ぶため。3.40.0 以前は `must be called synchronously from within a FetchEvent handler` で例外になる。**現在の既定は 3.45.1 なので通常は問題にならない**(古いバージョンに固定している場合だけ) |
| **キャッシュキー設計** | パーソナライズしたヒントを URL だけで鍵にすると、他のユーザーに漏れる |
| **`Vary: User-Agent` を使わない** | User-Agent はブラウザのバージョンごとに違うので、共有キャッシュが 1 リクエスト 1 オブジェクトまで断片化する。device を少数の値に正規化して、その独自ヘッダーに対して Vary させる。キャッシュキーも同じ考え方(細かすぎると再利用されない) |
| **TTFB は見かけ上改善する** | `responseStart` は 103 の到達時刻を含む。実処理時間は `finalResponseHeadersStart` を見る |

### Safari 向けのフォールバック

Safari は Early Hints の **`preload` に対応しておらず、`preconnect` のみ**です。
別オリジンの資材があるなら、preload と一緒に preconnect も入れておくと、
Safari でも接続の確立だけは先に済ませられます。

```js
['Link', '<https://cdn.example.com>; rel=preconnect']
```

## SDK の対応状況

| SDK | API | 対応バージョン |
| --- | --- | --- |
| JavaScript | `event.sendEarlyHints(headers)` | **3.36.0**(`await` の後に呼べるのは **3.40.1** 以降) |
| Go | `w.WriteHeader(fsthttp.StatusEarlyHints)` | **1.6.0** |
| Rust / Python / C++ | 専用 API なし | — |

Compute から 103 が使えるようになったのは 2025 年 11 月です
(Viceroy 0.16.0 → Go SDK 1.6.0 → JS SDK 3.36.0)。

## 参考

- [Fastly Documentation: Early Hints](https://www.fastly.com/documentation/reference/http/early-hints/)
- [Fastly: Exploring 103 Early Hints Beyond Server Push](https://www.fastly.com/blog/beyond-server-push-experimenting-with-the-103-early-hints-status-code)(Mark Nottingham, 2020)
- [Chrome for Developers: Faster page loads using server think-time with Early Hints](https://developer.chrome.com/docs/web-platform/early-hints)
- [RFC 8297: An HTTP Status Code for Indicating Hints](https://www.rfc-editor.org/rfc/rfc8297)
