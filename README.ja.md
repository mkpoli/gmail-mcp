# gmail-mcp

Gmail を Claude などの AI アシスタントにつなぐ。複数アカウントを同時に、自分のサーバーから。

[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![MCP](https://img.shields.io/badge/protocol-MCP-6E56CF)](https://modelcontextprotocol.io/)
[![23 tools](https://img.shields.io/badge/tools-23-0b7285)](#できること)
[![tests](https://img.shields.io/badge/tests-61_passing-success?logo=bun&logoColor=white)](#開発)

*[English README](./README.md)*

**gmail-mcp** は Gmail を Claude をはじめとする [MCP](https://modelcontextprotocol.io/) クライアントにつなぐ。**検索と閲覧**、引用付きの**送信と全員返信**、**転送**、**添付とインライン画像**、下書き・ラベル・スレッドの操作までを、**複数の Google アカウントで同時に**扱える。

置き場所は**自分の Cloudflare Worker**。同じ接続先に、ノート PC の Claude Code からも、ブラウザの claude.ai からも、スマートフォンからも届く。接続1つにつき Google アカウントは1つ、リフレッシュトークンは**自分の** Cloudflare アカウントから外に出ない。

ここに来る理由はたいてい二つある。Claude と Google の公式 Gmail コネクタは、読むことと下書きまではできるが**送信ができず**、アシスタント1つにつき Google アカウントも1つに限られる。送信できる実装の多くはローカルのプロセスで、机の前では快適でも、外出先のスマートフォンからは見えない。

<div align="center">
<img src="./docs/comparison.svg" alt="Gmail MCP サーバーの機能比較" width="820">
</div>

[google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) はこの分野でもっとも完成度が高い。Gmail だけでなく Workspace 全体を扱い、Gmail の署名の付加や URL からの添付取得など、gmail-mcp にない機能もある。複数アカウントの扱いは、呼び出しのたびに宛先アカウントを引数で渡す設計だ。接続そのものにメールボックスを結びつける gmail-mcp では、引数を間違えてもどこにも届かない。

[shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) のツール数は64、こちらは23。差の大半は不在応答・代理アクセス・S/MIME といった `gmail.settings.*` の領域で、gmail-mcp はこのスコープを要求しない。権限が漏れたとしても、その範囲には手が届かない。

読み取り側にも差が出る。ローカル型のサーバーはどのパートも UTF-8 として復号するため、ISO-2022-JP や Shift_JIS のメールは文字化けし、Gmail が添付として保管する長文の本文は空で返ってくる。

---

## 導入

所要時間はおよそ10分。大半は二つのブラウザ画面での作業になる。必要なものは、独自ドメインを載せた Cloudflare アカウントと [bun](https://bun.sh)、それに Google アカウント。

**1 · Google の OAuth クライアントを作る。** [gcloud CLI](https://cloud.google.com/sdk/docs/install) を入れて、次を実行する。

```sh
PROJECT="gmail-mcp-$(openssl rand -hex 3)"
gcloud auth login
gcloud projects create "$PROJECT" --name="gmail-mcp"
gcloud config set project "$PROJECT"
gcloud services enable gmail.googleapis.com
```

続く二つの手順に API は用意されていないので、コンソールで操作する。

- **OAuth 同意画面** → *External*。審査前の状態では、接続したいメールアドレスを **テストユーザー** に登録しておく。
- **認証情報 → 認証情報を作成 → OAuth クライアント ID** → *ウェブアプリケーション*。承認済みリダイレクト URI に `https://<自分のドメイン>/callback` を追加し、クライアント ID とシークレットを控える。

**2 · Worker をデプロイする。**

```sh
git clone https://github.com/mkpoli/gmail-mcp && cd gmail-mcp
bun install
# wrangler.jsonc の `name` と routes の `pattern` を自分のドメインに変える
bun run setup
```

`bun run setup` が KV 名前空間を作り、クライアント ID とシークレットを尋ね、Cookie 用の鍵を生成してデプロイまで行う。シークレットを1つ入れ替えたいだけのときに再実行しても問題ない。

**3 · クライアントをつなぐ。** クライアント ID とシークレットの欄は空のままでいい。MCP クライアントは自分で登録する。

```sh
claude mcp add --transport http gmail-personal https://<自分のドメイン>/mcp
claude mcp add --transport http gmail-work     https://<自分のドメイン>/mcp/work
```

Claude Code なら `/mcp` を実行して、それぞれを対応する Google アカウントでサインインさせる。claude.ai の場合は **設定 → コネクタ → カスタムコネクタを追加** に同じ URL を入れる。`/mcp/` の後ろは自由な1階層のラベルで、URL が重複するサーバーを受け付けないクライアントでも、1つのデプロイで複数のメールボックスを扱える。

デプロイ先のトップページ `https://<自分のドメイン>/` には、この手順がそのまま表示される。

---

## できること

**読む** — `whoami` · `search_messages` · `get_message` · `get_thread` · `get_attachment`

**書く** — `send_message` · `reply_all` · `forward_message` · `create_draft` · `update_draft` · `send_draft` · `delete_draft` · `list_drafts`

**整理する** — `list_labels` · `create_label` · `update_label` · `delete_label` · `modify_labels` · `modify_thread_labels` · `batch_modify_messages` · `trash_message` · `untrash_message` · `trash_thread` · `untrash_thread`

送信するメールの構造は、通常のメールクライアントが組み立てるものと同じだ。プレーンテキストに HTML 版を添え、ファイルを添付し、`cid:` で参照するインライン画像を埋め込む。入れ子は `multipart/mixed › multipart/related › multipart/alternative` になる。件名と表示名は RFC 2047、ファイル名は RFC 2231 で符号化するので、日本語も中国語も絵文字もそのまま届く。

`reply_all` は元メールの `Reply-To`・`From`・`To`・`Cc` を読み、自分のアドレスを除いて宛先を組み立て、`References` の連鎖を引き継ぎ、本文をテキストと HTML の両方で引用する。`forward_message` は転送元のヘッダを再現し、元の添付ファイルをそのまま付け直せる。

読み取り側には上限を設けてある。本文とスレッドには文字数、添付にはサイズの上限があり、長大なメーリングリストのスレッドがアシスタントの文脈を埋め尽くすことはない。

---

## サインインできる人

決めるのは `ALLOWED_EMAILS` の値だ。Google が「確認済み」として返すアドレスと照合され、同意画面の後、権限が発行される前に判定される。

| 値 | 通る人 |
| :-- | :-- |
| *(空)* | 誰も通らない |
| `you@gmail.com, work@company.com` | そのアカウントだけ |
| `*@company.com` | そのドメインの全員 |
| `*` | 確認済みの Google アカウントすべて |

発行された権限は、その認証を通したメールボックスにしか届かない。したがってこの一覧を広げても、すでにつながっているメールボックスへの到達範囲が広がることはない。`*` にした場合に他人へ渡るのは、自分のデプロイと Google クライアントの割り当て量を、その人自身のメールのために使わせることだ。

---

## セキュリティ

自分で運用するという選択は、信頼の置き場所を移すだけで、なくすわけではない。だから何がどこにあるかを書いておく。

- **トークンは自分の手元に残る。** リフレッシュトークンは OAuth の権限情報の中で暗号化され、自分の KV 名前空間に入る。有効期間1時間のアクセストークンはセッションの Durable Object に置かれる。メール本文はどこにも保存されない。通過するだけだ。
- **1セッションにつき1メールボックス。** MCP セッションは、それを開いたアカウントに結びつく。他人のセッション ID を借りても、別のメールボックスは操作できない。
- **スコープを絞る。** `gmail.modify` が覆うのは読み取り・送信・ラベル・ゴミ箱まで。完全削除と `gmail.settings.*` は含まれない。自動転送やフィルタによる持ち出しという、乗っ取り後の定番の裏口が、そもそも権限の外にある。
- **悪意あるメールからヘッダを注入されない。** 送信ヘッダの値は CR と LF を拒否する。本文に仕込まれた指示がモデルを動かしても、こっそり `Bcc` を足すことはできない。引用部分は HTML エスケープを通る。
- **取り消しが効く。** 新規のサインインを止めるなら `ALLOWED_EMAILS` を狭める。[myaccount.google.com/connections](https://myaccount.google.com/connections) でアプリのアクセスを取り消す。すべての権限を一度に無効化したいなら Google のクライアントシークレットを再生成する。

なお、リクエストを処理する間、Worker はメールをメモリ上で復号する。中継する以上これは避けられない。特定のメールボックスについてそれが許容できないなら、そのアカウントだけはローカルの MCP サーバーを使うほうがいい。

---

## 開発

```sh
bun run dev     # wrangler dev、:8788
bun run check   # biome + tsc
bun test        # 単体テスト 61 件
bun run assets  # ライト・ダークの図を再生成
bun run deploy
```

テストが見ているのは、メール構築（MIME の入れ子、RFC 2047 の折り返し、RFC 2231 のファイル名、CR/LF の拒否、base64 の折り返し）、文字コードをまたぐ本文の取り出し、返信と転送の組み立て、Google のトークン処理、サインイン許可リストの判定。

実際の Gmail アカウント間でも全ツールを通してある。日本語の件名は複数の encoded word に折り返されて復元され、絵文字・ZWJ・アラビア語・結合文字・稀少漢字はそのまま往復した。`請求書.csv` は送信・受信・再ダウンロードでバイト単位に一致し、`cid:` のインライン画像は受信側で表示された。2つのアカウントを同時に接続した状態で、一方のメッセージ ID をもう一方から読むと `404` が返る。

## ライセンス

[MIT](./LICENSE)。`src/workers-oauth-utils.ts` は Cloudflare の [remote-mcp-github-oauth デモ](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)（MIT）に由来する。
