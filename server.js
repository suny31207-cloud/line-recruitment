// LINE採用返信システム
// 採用面接後の応募者に入社意思を確認し、結果をGoogleスプレッドシートへ記録する

require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// LINE 設定
// ============================================================

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'placeholder',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'placeholder',
};

const client = new line.Client(lineConfig);

// LINE認証情報が未設定の場合は起動時に警告だけ出す（サーバーは起動する）
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.warn('[WARN] LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が未設定です。Webhookは動作しません。');
}

// ============================================================
// Google Sheets 設定
// ============================================================

const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Renderなどの環境変数では \n がエスケープされるため変換
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth: googleAuth });

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = '採用回答';

// ============================================================
// ユーティリティ
// ============================================================

// 現在時刻を日本時間で返す
function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ============================================================
// Google Sheets 操作
// ============================================================

// シートの全データを取得
async function getSheetData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:G`,
  });
  return res.data.values || [];
}

// LINEユーザーIDで行を検索
// 戻り値: { rowIndex: 0始まりのインデックス, rowData: 行データ配列 } または null
async function findRowByUserId(userId) {
  const data = await getSheetData();
  // 1行目はヘッダーなのでi=1から検索
  for (let i = 1; i < data.length; i++) {
    if (data[i] && data[i][1] === userId) {
      return { rowIndex: i, rowData: data[i] };
    }
  }
  return null;
}

// 末尾に新規行を追加
async function appendRow(values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// 既存行を更新（rowIndexは0始まり）
async function updateRow(rowIndex, values) {
  // スプレッドシートの行番号は1始まりなのでそのまま使える（ヘッダーが1行目）
  const sheetRow = rowIndex + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${sheetRow}:G${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// シートのヘッダー行を初期化（未設定の場合のみ）
async function initSheetHeader() {
  const data = await getSheetData();
  if (data.length === 0) {
    await appendRow(['回答日時', 'LINEユーザーID', '応募者名', '回答結果', 'ステータス', '初回送信日時', '備考']);
    console.log('[INIT] スプレッドシートにヘッダー行を追加しました');
  }
}

// ============================================================
// LINE メッセージ構築
// ============================================================

// 面接お礼テキストメッセージ
function buildThankYouMessage(displayName) {
  return {
    type: 'text',
    text:
      `${displayName}様\n\n` +
      `本日は面接にお越しいただきまして、\n` +
      `誠にありがとうございました。\n\n` +
      `⚠️重要⚠️\n` +
      `面接を踏まえてご検討いただき\n` +
      `1週間以内に下記のどちらかをお選びください。\n\n` +
      `ご希望の選択肢をタップされると操作完了です。`,
  };
}

// 入社確認ボタンメッセージ（テンプレートメッセージ）
function buildButtonMessage() {
  return {
    type: 'template',
    altText: '入社についての確認（アプリ画面でご確認ください）',
    template: {
      type: 'buttons',
      title: '入社について',
      text: '入社をご希望の場合は「入社を希望する」を、ご辞退される場合は「辞退する」をタップしてください。',
      actions: [
        {
          type: 'postback',
          label: '入社を希望する',
          data: 'action=join',
          displayText: '入社を希望する',
        },
        {
          type: 'postback',
          label: '辞退する',
          data: 'action=decline',
          displayText: '辞退する',
        },
      ],
    },
  };
}

// ============================================================
// イベントハンドラ
// ============================================================

// follow / message イベント: 初回の面接お礼メッセージを送信
async function handleFollowOrMessage(userId, replyToken) {
  // 既に回答済みのユーザーには送信しない
  const existing = await findRowByUserId(userId);
  if (existing && existing.rowData[4] === '回答済み') {
    console.log(`[SKIP] 回答済みのため初回メッセージをスキップ: ${userId}`);
    return;
  }

  // LINEプロフィールから表示名を取得
  let displayName = '応募者';
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName;
  } catch (err) {
    console.error('[WARN] プロフィール取得失敗:', err.message);
  }

  const now = nowJST();

  // スプレッドシートに新規登録（まだ登録されていない場合）
  if (!existing) {
    await appendRow(['', userId, displayName, '', '未回答', now, '']);
    console.log(`[REGISTERED] 新規応募者を記録: ${displayName} (${userId})`);
  }

  // LINE へお礼メッセージとボタンを送信
  await client.replyMessage(replyToken, [
    buildThankYouMessage(displayName),
    buildButtonMessage(),
  ]);

  console.log(`[SENT] 初回メッセージ送信完了: ${displayName} (${userId})`);
}

// postback イベント: 入社希望 / 辞退 の処理
async function handlePostback(userId, replyToken, postbackData) {
  const params = new URLSearchParams(postbackData);
  const action = params.get('action');

  if (action !== 'join' && action !== 'decline') {
    console.log(`[SKIP] 未知のアクション: ${action}`);
    return;
  }

  const now = nowJST();
  const result = action === 'join' ? '入社希望' : '辞退';

  const replyText =
    action === 'join'
      ? 'ご回答ありがとうございます。\n「入社を希望する」として受付いたしました。\n担当者より改めてご連絡いたします。'
      : 'ご回答ありがとうございます。\n「辞退する」として受付いたしました。\nこの度はご検討いただき、誠にありがとうございました。';

  // スプレッドシートへ記録
  try {
    const existing = await findRowByUserId(userId);

    if (existing) {
      // 既存行を更新（回答日時・回答結果・ステータスのみ変更）
      const row = [...existing.rowData];
      while (row.length < 7) row.push(''); // 配列長を7に補完
      row[0] = now;         // A列: 回答日時
      row[3] = result;      // D列: 回答結果
      row[4] = '回答済み';  // E列: ステータス
      await updateRow(existing.rowIndex, row);
    } else {
      // 初回メッセージを経ずに回答が来たイレギュラーケース
      let displayName = '応募者';
      try {
        const profile = await client.getProfile(userId);
        displayName = profile.displayName;
      } catch (err) {
        console.error('[WARN] プロフィール取得失敗:', err.message);
      }
      await appendRow([now, userId, displayName, result, '回答済み', now, '']);
    }

    console.log(`[RECORDED] 回答記録完了: ${userId} → ${result}`);
  } catch (err) {
    console.error('[ERROR] スプレッドシート書き込み失敗:', err.message);
    // 書き込み失敗でもLINE返信は行う
  }

  // LINE へ受付完了メッセージを返信
  await client.replyMessage(replyToken, [{ type: 'text', text: replyText }]);
}

// ============================================================
// Webhook エンドポイント
// ============================================================

// line.middleware が署名検証とボディパースを担当
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  // LINE サーバーへ即座に200を返す（タイムアウト防止）
  res.sendStatus(200);

  for (const event of req.body.events) {
    try {
      if (event.type === 'follow' || event.type === 'message') {
        // 友だち追加 または メッセージ送信時: 初回面接お礼メッセージを送信
        await handleFollowOrMessage(event.source.userId, event.replyToken);
      } else if (event.type === 'postback') {
        // ボタンタップ時: 回答を記録して返信
        await handlePostback(event.source.userId, event.replyToken, event.postback.data);
      }
    } catch (err) {
      console.error('[ERROR] イベント処理中にエラーが発生:', err.message);
      console.error(err.stack);
    }
  }
});

// ヘルスチェック用エンドポイント（Render/Railwayのホームページ確認用）
app.get('/', (req, res) => {
  res.send('LINE採用返信システム 稼働中');
});

// ============================================================
// サーバー起動
// ============================================================

app.listen(PORT, async () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);

  // 起動時にスプレッドシートのヘッダーを初期化
  try {
    await initSheetHeader();
  } catch (err) {
    console.error('[WARN] ヘッダー初期化失敗（スプレッドシートの設定を確認してください）:', err.message);
  }
});
