# LINE採用返信システム

採用面接後の応募者に対して、LINE公式アカウント上で「入社を希望する」または「辞退する」を選択してもらい、結果をGoogleスプレッドシートへ自動記録するシステムです。

## 機能概要

- 応募者が友だち追加・メッセージ送信時に面接お礼メッセージを自動送信
- 「入社を希望する」「辞退する」の選択ボタンを表示
- 回答結果をGoogleスプレッドシートへ自動記録
- 同一ユーザーへの重複送信を防止
- LINE署名検証によるセキュアなWebhook処理

---

## セットアップ手順

### 1. LINE Developers 側の設定

1. [LINE Developers Console](https://developers.line.biz/) にアクセス
2. プロバイダーを作成（または既存を選択）
3. **Messaging API チャンネル**を新規作成
4. チャンネル基本設定から以下を取得・確認：
   - `チャンネルシークレット` → `.env` の `LINE_CHANNEL_SECRET` に設定
5. **Messaging API設定**タブから以下を操作：
   - `チャンネルアクセストークン（長期）` を発行 → `LINE_CHANNEL_ACCESS_TOKEN` に設定
   - **応答メッセージ** → オフ
   - **あいさつメッセージ** → オフ（コードで制御するため）
   - **Webhookの利用** → オン
   - **Webhook URL** → デプロイ後に `https://あなたのドメイン/webhook` を入力して「検証」をクリック

---

### 2. Google Cloud 側の設定

#### 2-1. プロジェクトとAPIの有効化

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（または既存を選択）
2. 左メニュー「APIとサービス」→「ライブラリ」
3. **Google Sheets API** を検索して有効化

#### 2-2. サービスアカウントの作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」
2. 任意の名前（例: `line-recruitment`）で作成
3. 作成したサービスアカウントをクリック→「キー」タブ→「鍵を追加」→「新しい鍵を作成」→**JSON** を選択
4. ダウンロードされた JSON ファイルから以下を取得：
   - `client_email` の値 → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` の値（`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----\n` まで）→ `GOOGLE_PRIVATE_KEY`

> **注意**: `GOOGLE_PRIVATE_KEY` をRender/Railwayの環境変数に設定する際、改行（`\n`）はそのままペーストしてください。ダブルクォートで囲む必要はありません。

---

### 3. Googleスプレッドシートの設定

1. Googleスプレッドシートを新規作成
2. シート名を **`採用回答`** に変更（タブ名を変更）
3. URLの `/d/XXXXXXXXXX/` の部分をコピー → `GOOGLE_SHEET_ID` に設定
4. 「共有」ボタンをクリックし、**サービスアカウントのメールアドレス**（`GOOGLE_SERVICE_ACCOUNT_EMAIL` の値）を **編集者** として追加

> ヘッダー行（1行目）はサーバー起動時に自動で挿入されます。手動設定は不要です。

スプレッドシートの列構成：

| A列 | B列 | C列 | D列 | E列 | F列 | G列 |
|------|------|------|------|------|------|------|
| 回答日時 | LINEユーザーID | 応募者名 | 回答結果 | ステータス | 初回送信日時 | 備考 |

---

### 4. ローカル環境でのセットアップ

```bash
# リポジトリをクローン（またはファイルをコピー）
git clone <リポジトリURL>
cd line-recruitment

# 依存パッケージをインストール
npm install

# 環境変数ファイルを作成
cp .env.example .env

# .env を編集して各値を設定
```

`.env` の記述例：

```env
LINE_CHANNEL_ACCESS_TOKEN=eyJhbGci...（長期アクセストークン）
LINE_CHANNEL_SECRET=abc123...（チャンネルシークレット）
GOOGLE_SERVICE_ACCOUNT_EMAIL=line-recruitment@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvg...（改行は\nのまま）\n-----END PRIVATE KEY-----\n
GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
PORT=3000
```

---

### 5. ローカルでの動作確認（ngrokを使う場合）

```bash
# サーバーを起動
npm run dev

# 別ターミナルでngrokを起動
ngrok http 3000
```

ngrokで発行された `https://xxxx.ngrok-free.app` をLINE DevelopersのWebhook URLに設定：

```
https://xxxx.ngrok-free.app/webhook
```

---

### 6. Renderへのデプロイ

1. [Render](https://render.com/) でアカウント作成
2. 「New +」→「Web Service」→ GitHubリポジトリを接続
3. 以下を設定：
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
4. 「Environment Variables」に `.env` の内容をすべて追加
5. デプロイ完了後、発行されたURLをLINE DevelopersのWebhook URLに設定：
   ```
   https://あなたのサービス名.onrender.com/webhook
   ```

> **無料プランの注意**: Renderの無料プランはアクセスがない場合スリープします。LINE Webhookの最初のリクエストが遅延することがあります。定期的なping設定（UptimeRobotなど）を推奨します。

---

### 7. Railwayへのデプロイ

1. [Railway](https://railway.app/) でアカウント作成
2. 「New Project」→「Deploy from GitHub repo」
3. 環境変数を Railway の Variables タブで設定
4. デプロイ後、「Settings」→「Networking」→「Generate Domain」でURLを発行
5. 発行URLをLINE DevelopersのWebhook URLに設定

---

## 動作フロー

```
応募者がLINEを開く
    ↓
follow または message イベント
    ↓
スプレッドシートで重複チェック
    ↓（未回答の場合）
面接お礼メッセージ + ボタン送信
    ↓
応募者がボタンをタップ（入社を希望する / 辞退する）
    ↓
postback イベント受信
    ↓
スプレッドシートへ結果を記録
    ↓
応募者へ受付完了メッセージを返信
```

---

## トラブルシューティング

### Webhookの検証が失敗する

- サーバーが正常に起動しているか確認（`GET /` で「稼働中」と表示されるか）
- `LINE_CHANNEL_SECRET` が正しく設定されているか確認

### スプレッドシートに書き込めない

- サービスアカウントのメールアドレスがスプレッドシートの「共有」に**編集者**として追加されているか確認
- `GOOGLE_SHEET_ID` がスプレッドシートのURLのIDと一致しているか確認
- シート名が **`採用回答`** になっているか確認

### `GOOGLE_PRIVATE_KEY` のエラー

- 環境変数の改行コードが正しく処理されているか確認
- Renderの場合: 環境変数の値をそのままペーストし、前後にダブルクォートを入れない

### ボタンが表示されない（テキストのみ表示）

- LINE のボタンテンプレートはスマートフォンのLINEアプリが必要です（PC版では`altText`がテキストで表示されます）

---

## 想定外メッセージ対応・要返信管理

### 概要

応募者が「見学希望」「面接希望」以外の自由入力メッセージ（質問、問い合わせなど）を送った場合、LINE Botが自動返信を行い、管理アプリ側で「要返信」として確認・対応できる機能です。

### 想定外メッセージとは

以下に該当しないテキストメッセージが「想定外メッセージ」として扱われます：

- `見学希望` / `面接希望`
- アンケート回答フロー中の候補日時回答
- `入社を希望する` / `辞退する`
- postbackイベント（ボタンタップ）
- 未登録ユーザーの初回メッセージ
- 登録済みで希望内容未選択のユーザーのメッセージ

### 想定外メッセージ受信時の自動処理

1. 応募者に以下の自動返信を送信：
   ```
   担当者より折り返しご連絡いたします。
   恐れ入りますが、少々お待ちください。
   ```
2. Googleスプレッドシートに以下を記録：
   - U列（要返信）→「要返信」
   - V列（最新問い合わせ内容）→ メッセージ本文
   - W列（最新問い合わせ日時）→ 受信日時
   - X列（最終LINE受信日時）→ 受信日時
3. 現在ステータスは変更されません

### 重複自動返信の制御

同じ応募者が短時間に複数回想定外メッセージを送った場合、10分以内に自動返信済みであれば自動返信は再送されません。ただし、問い合わせ内容・日時・要返信ステータスは毎回更新されます。

内部的にY列（最終想定外メッセージ自動返信日時）で制御しています。

---

### 要返信フラグの確認方法

管理画面（`/admin`）の応募者一覧で確認できます：

- **要返信バッジ**: 要返信の応募者には赤いバッジが表示されます
- **背景色**: 要返信の行は薄い赤色の背景で強調されます
- **件数表示**: フィルターバーに要返信の件数が表示されます

### 要返信のみ表示フィルターの使い方

1. 応募者一覧画面の上部にあるフィルターバーを確認
2. 「要返信のみ表示」チェックボックスにチェックを入れる
3. 要返信ステータスが「要返信」の応募者のみが表示されます
4. チェックを外すと全応募者が再表示されます

---

### 公式LINEを開くボタンの設定方法

応募者詳細画面に「公式LINEを開く」ボタンを表示するには、`.env` に以下を設定してください：

```env
LINE_OFFICIAL_CHAT_URL=https://chat.line.biz/xxxxxxxxxx
```

#### LINE_OFFICIAL_CHAT_URL の設定方法

1. [LINE Official Account Manager](https://manager.line.biz/) にログイン
2. 対象のLINE公式アカウントを選択
3. 「チャット」画面のURLをコピー（例: `https://chat.line.biz/Uxxxxxxxxxx`）
4. コピーしたURLを `.env` の `LINE_OFFICIAL_CHAT_URL` に設定
5. サーバーを再起動

> **注意**: 個別ユーザーのトーク画面を直接開くURLはLINEの仕様上取得できないため、チャット管理画面のトップページが開きます。管理画面上で該当応募者を検索して返信してください。

`LINE_OFFICIAL_CHAT_URL` が未設定の場合、「公式LINEを開く」ボタンは表示されません。

---

### 管理アプリから手動返信した場合の自動対応済み

応募者詳細画面のLINE送信機能（カスタムメッセージなど）でメッセージを送信すると、以下が自動で処理されます：

1. **最終LINE送信日時**が更新される
2. **要返信ステータス**が「要返信」→「対応済み」に自動変更される
3. Googleスプレッドシートにも反映される

手動で「要返信を対応済みにする」ボタンを押すことでも、要返信ステータスを対応済みに変更できます。

---

### Googleスプレッドシート列構成（追加分）

| 列 | ヘッダー | 内容 |
|----|---------|------|
| U | 要返信 | `要返信` / `対応済み` / 空欄 |
| V | 最新問い合わせ内容 | 応募者が送信した想定外メッセージの本文 |
| W | 最新問い合わせ日時 | 想定外メッセージの受信日時 |
| X | 最終LINE受信日時 | 最後にLINEメッセージを受信した日時 |
| Y | 最終想定外メッセージ自動返信日時 | 重複自動返信制御用（内部管理） |

