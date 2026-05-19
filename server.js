// LINE採用管理システム
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://line-recruitment.onrender.com';
const LIFF_ID = process.env.LIFF_ID || '';

// ===== Express設定 =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// /webhook はline.middlewareが自前でbody読み込みするため除外
app.use('/admin', express.urlencoded({ extended: true }));
app.use('/survey', express.urlencoded({ extended: true }));

// ===== LINE設定 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'placeholder',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'placeholder',
};
const client = new line.Client(lineConfig);
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  console.warn('[WARN] LINE認証情報が未設定です');
}

// ===== Google Sheets設定 =====
const googleAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: googleAuth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = '採用管理';

// ===== 列定義（A〜T = 0〜19）=====
const COL = {
  登録日時: 0, LINEユーザーID: 1, 氏名: 2, 性別: 3, 年齢: 4,
  携帯番号: 5, 最寄駅: 6, 希望店舗: 7, 希望雇用形態: 8, 勤務開始希望日: 9,
  美容師経験: 10, サイドシャンプーありなし: 11, 希望内容: 12, 現在ステータス: 13,
  見学予約日: 14, 面接予定日: 15, 回答日時: 16, 回答結果: 17, 最終LINE送信日時: 18, 備考: 19,
};
const COL_COUNT = 20;
const HEADERS = [
  '登録日時', 'LINEユーザーID', '氏名', '性別', '年齢', '携帯番号',
  '最寄駅', '希望店舗', '希望雇用形態', '勤務開始希望日', '美容師経験',
  'サイドシャンプーありなし', '希望内容', '現在ステータス', '見学予約日',
  '面接予定日', '回答日時', '回答結果', '最終LINE送信日時', '備考',
];
const STATUSES = ['未対応', '見学対応済み', '面接対応済み', '対応完了'];

function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ===== Google Sheets操作 =====
async function getSheetData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:T`,
  });
  return res.data.values || [];
}

async function findRowByUserId(userId) {
  const data = await getSheetData();
  for (let i = 1; i < data.length; i++) {
    if (data[i]?.[COL.LINEユーザーID] === userId) {
      return { rowIndex: i, rowData: data[i] };
    }
  }
  return null;
}

function padRow(row) {
  const r = Array.isArray(row) ? [...row] : [];
  while (r.length < COL_COUNT) r.push('');
  return r;
}

async function appendRow(values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:T`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padRow(values)] },
  });
}

async function updateRow(rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex + 1}:T${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padRow(values)] },
  });
}

// LINEユーザーIDをキーに追加 or 更新
async function upsertCandidate(userId, updates) {
  const existing = await findRowByUserId(userId);
  if (existing) {
    const row = padRow(existing.rowData);
    Object.entries(updates).forEach(([i, v]) => { row[Number(i)] = v ?? ''; });
    await updateRow(existing.rowIndex, row);
  } else {
    const row = new Array(COL_COUNT).fill('');
    row[COL.登録日時] = nowJST();
    row[COL.LINEユーザーID] = userId;
    row[COL.現在ステータス] = '未対応';
    Object.entries(updates).forEach(([i, v]) => { row[Number(i)] = v ?? ''; });
    await appendRow(row);
  }
}

// ===== LINEメッセージ構築 =====
function buildGreeting() {
  return {
    type: 'text',
    text: 'こんにちは！\nCOLOR KITCHEN採用担当です☺️\n\nまずは気軽に、\n・見学希望\n・面接希望\n\nから選んでください✨',
  };
}

function buildSurveyLink(userId) {
  const url = LIFF_ID
    ? `https://liff.line.me/${LIFF_ID}/survey/${userId}`
    : `${APP_URL}/survey/${userId}`;
  return {
    type: 'text',
    text: `採用エントリーありがとうございます。\nまずは下記アンケートにご回答ください。\n\n【必須】\n・氏名\n・携帯番号\n・希望店舗\n・希望雇用形態\n・美容師経験\n\n【任意】\n・性別・年齢・最寄駅\n・勤務開始希望日\n・サイドシャンプー\n\n▼ アンケートはこちら\n${url}`,
  };
}

function buildChoiceButtons() {
  return {
    type: 'template',
    altText: '見学希望・面接希望をお選びください',
    template: {
      type: 'buttons',
      text: '見学希望または面接希望をお選びください',
      actions: [
        { type: 'message', label: '見学希望', text: '見学希望' },
        { type: 'message', label: '面接希望', text: '面接希望' },
      ],
    },
  };
}

function buildInterviewMessages(displayName) {
  return [
    {
      type: 'text',
      text: `${displayName}様\n\n本日は面接にお越しいただきまして、\n誠にありがとうございました。\n\n⚠️重要⚠️\n面接を踏まえてご検討いただき\n1週間以内に下記のどちらかをお選びください。\n\nご希望の選択肢をタップされると操作完了です。`,
    },
    {
      type: 'template',
      altText: '入社についての確認（アプリ画面でご確認ください）',
      template: {
        type: 'buttons',
        title: '入社について',
        text: '入社をご希望の場合は「入社を希望する」を、ご辞退される場合は「辞退する」をタップしてください。',
        actions: [
          { type: 'postback', label: '入社を希望する', data: 'action=join', displayText: '入社を希望する' },
          { type: 'postback', label: '辞退する', data: 'action=decline', displayText: '辞退する' },
        ],
      },
    },
  ];
}

// ===== Webhookイベントハンドラ =====
async function handleFollow(event) {
  const userId = event.source.userId;
  let displayName = '応募者';
  try {
    const p = await client.getProfile(userId);
    displayName = p.displayName;
  } catch (e) { console.error('[WARN] profile取得失敗:', e.message); }

  await upsertCandidate(userId, { [COL.氏名]: displayName });
  await client.replyMessage(event.replyToken, [
    buildGreeting(),
    buildSurveyLink(userId),
  ]);
  console.log(`[FOLLOW] ${displayName} (${userId})`);
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text?.trim();

  if (text === '見学希望' || text === '面接希望') {
    await upsertCandidate(userId, { [COL.希望内容]: text });
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `「${text}」を承りました。\n担当者より日程のご連絡をお待ちください。`,
    });
    return;
  }

  // 未登録ユーザーは登録してグリーティング
  const existing = await findRowByUserId(userId);
  if (!existing) {
    let displayName = '応募者';
    try { const p = await client.getProfile(userId); displayName = p.displayName; } catch (e) {}
    await upsertCandidate(userId, { [COL.氏名]: displayName });
    await client.replyMessage(event.replyToken, [buildGreeting(), buildSurveyLink(userId)]);
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const action = new URLSearchParams(event.postback.data).get('action');
  if (action !== 'join' && action !== 'decline') return;

  // 対応完了済みなら重複受付しない
  const existing = await findRowByUserId(userId);
  if (existing && padRow(existing.rowData)[COL.現在ステータス] === '対応完了') {
    await client.replyMessage(event.replyToken, {
      type: 'text', text: '既にご回答を受け付けております。ありがとうございました。',
    });
    return;
  }

  const result = action === 'join' ? '入社希望' : '辞退';
  const replyText = action === 'join'
    ? 'ご回答ありがとうございます。\n「入社を希望する」として受付いたしました。\n担当者より改めてご連絡いたします。'
    : 'ご回答ありがとうございます。\n「辞退する」として受付いたしました。\nこの度はご検討いただき、誠にありがとうございました。';

  try {
    await upsertCandidate(userId, {
      [COL.回答日時]: nowJST(),
      [COL.回答結果]: result,
      [COL.現在ステータス]: '対応完了',
    });
    console.log(`[ANSWER] ${userId} → ${result}`);
  } catch (e) { console.error('[ERROR] sheets書き込み失敗:', e.message); }

  await client.replyMessage(event.replyToken, [{ type: 'text', text: replyText }]);
}

// ===== Webhookエンドポイント =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try {
      if (event.type === 'follow') await handleFollow(event);
      else if (event.type === 'message' && event.message?.type === 'text') await handleMessage(event);
      else if (event.type === 'postback') await handlePostback(event);
    } catch (e) {
      console.error('[ERROR] イベント処理失敗:', e.message, e.stack);
    }
  }
});

// ===== 管理画面：一覧 =====
app.get('/admin', async (req, res) => {
  try {
    const data = await getSheetData();
    const candidates = data.slice(1)
      .map(row => {
        const r = padRow(row);
        return {
          lineUserId:    r[COL.LINEユーザーID],
          name:          r[COL.氏名],
          preference:    r[COL.希望内容],
          status:        r[COL.現在ステータス] || '未対応',
          visitDate:     r[COL.見学予約日],
          interviewDate: r[COL.面接予定日],
          answer:        r[COL.回答結果],
          lastSent:      r[COL.最終LINE送信日時],
          registeredAt:  r[COL.登録日時],
          surveyDone:    !!(r[COL.携帯番号] || r[COL.希望店舗]),
        };
      })
      .filter(c => c.lineUserId);
    res.render('admin/index', { candidates, statuses: STATUSES });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：詳細 =====
app.get('/admin/candidates/:uid', async (req, res) => {
  try {
    const found = await findRowByUserId(req.params.uid);
    if (!found) return res.status(404).send('応募者が見つかりません');
    const r = padRow(found.rowData);
    const c = {
      lineUserId: r[COL.LINEユーザーID],
      name: r[COL.氏名], gender: r[COL.性別], age: r[COL.年齢],
      phone: r[COL.携帯番号], station: r[COL.最寄駅],
      store: r[COL.希望店舗], employment: r[COL.希望雇用形態],
      startDate: r[COL.勤務開始希望日], experience: r[COL.美容師経験],
      sideshampoo: r[COL.サイドシャンプーありなし], preference: r[COL.希望内容],
      status: r[COL.現在ステータス] || '未対応',
      visitDate: r[COL.見学予約日], interviewDate: r[COL.面接予定日],
      answerDate: r[COL.回答日時], answer: r[COL.回答結果],
      lastSent: r[COL.最終LINE送信日時], note: r[COL.備考],
      registeredAt: r[COL.登録日時],
    };
    res.render('admin/detail', { c, statuses: STATUSES, msg: req.query.msg || '' });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：更新 =====
app.post('/admin/candidates/:uid', async (req, res) => {
  const userId = req.params.uid;
  const b = req.body;
  try {
    const found = await findRowByUserId(userId);
    if (!found) return res.status(404).send('応募者が見つかりません');
    const prevStatus = padRow(found.rowData)[COL.現在ステータス];

    await upsertCandidate(userId, {
      [COL.氏名]: b.name || '', [COL.性別]: b.gender || '',
      [COL.年齢]: b.age || '', [COL.携帯番号]: b.phone || '',
      [COL.最寄駅]: b.station || '', [COL.希望店舗]: b.store || '',
      [COL.希望雇用形態]: b.employment || '', [COL.勤務開始希望日]: b.startDate || '',
      [COL.美容師経験]: b.experience || '', [COL.サイドシャンプーありなし]: b.sideshampoo || '',
      [COL.希望内容]: b.preference || '', [COL.現在ステータス]: b.status || prevStatus,
      [COL.見学予約日]: b.visitDate || '', [COL.面接予定日]: b.interviewDate || '',
      [COL.備考]: b.note || '',
    });

    // 面接対応済みに変更 → 入社/辞退ボタンを自動送信
    if (b.status === '面接対応済み' && prevStatus !== '面接対応済み') {
      try {
        await client.pushMessage(userId, buildInterviewMessages(b.name || '応募者'));
        await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
        console.log(`[AUTO-SEND] 面接後ボタン送信: ${userId}`);
      } catch (e) { console.error('[ERROR] LINE push失敗:', e.message); }
    }

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('更新しました')}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：LINE個別送信 =====
app.post('/admin/candidates/:uid/send', async (req, res) => {
  const userId = req.params.uid;
  const { messageType, customText } = req.body;
  try {
    const found = await findRowByUserId(userId);
    if (!found) return res.status(404).send('応募者が見つかりません');
    const name = padRow(found.rowData)[COL.氏名] || '応募者';

    let msgs;
    if (messageType === 'interview_followup') msgs = buildInterviewMessages(name);
    else if (messageType === 'choice') msgs = [buildChoiceButtons()];
    else if (messageType === 'custom' && customText) msgs = [{ type: 'text', text: customText }];
    else return res.status(400).send('送信タイプが不正です');

    await client.pushMessage(userId, msgs);
    await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('LINEを送信しました')}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== アンケートフォーム（GET）=====
app.get('/survey/:uid', (req, res) => {
  res.render('survey', {
    uid: req.params.uid, liffId: LIFF_ID,
    error: null, success: false, prefill: {},
  });
});

// ===== アンケートフォーム（POST）=====
app.post('/survey/:uid', async (req, res) => {
  const userId = req.params.uid;
  const { name, gender, age, phone, station, store, employment, startDate, experience, sideshampoo } = req.body;

  const renderError = (msg) => res.render('survey', {
    uid: userId, liffId: LIFF_ID, error: msg, success: false, prefill: req.body,
  });

  // バリデーション
  if (!name || !phone || !store || !employment || !experience) {
    return renderError('必須項目（氏名・携帯番号・希望店舗・希望雇用形態・美容師経験）を入力してください');
  }
  if (!/^[0-9]{10,11}$/.test(phone.replace(/[-\s]/g, ''))) {
    return renderError('携帯番号は10〜11桁の数字で入力してください（ハイフン不要）');
  }

  try {
    await upsertCandidate(userId, {
      [COL.氏名]: name, [COL.性別]: gender || '',
      [COL.年齢]: age || '', [COL.携帯番号]: phone,
      [COL.最寄駅]: station || '', [COL.希望店舗]: store,
      [COL.希望雇用形態]: employment, [COL.勤務開始希望日]: startDate || '',
      [COL.美容師経験]: experience, [COL.サイドシャンプーありなし]: sideshampoo || '',
    });

    // アンケート完了 → 選択肢をLINE送信
    try {
      await client.pushMessage(userId, [
        { type: 'text', text: 'アンケートのご回答ありがとうございます。\n\n続けて、\n・見学希望\n・面接希望\n\nからご希望をお選びください。' },
        buildChoiceButtons(),
      ]);
      await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
    } catch (e) { console.warn('[WARN] アンケート後LINE送信失敗:', e.message); }

    res.render('survey', { uid: userId, liffId: LIFF_ID, error: null, success: true, prefill: {} });
  } catch (e) {
    console.error('[ERROR] アンケート保存失敗:', e.message);
    renderError('エラーが発生しました。もう一度お試しください。');
  }
});

// ===== ヘルスチェック =====
app.get('/', (req, res) => res.send('LINE採用管理システム 稼働中'));

// ===== シート初期化 =====
async function initSheetHeader() {
  try {
    const data = await getSheetData();
    if (data.length === 0) {
      await appendRow(HEADERS);
      console.log('[INIT] ヘッダー行を追加しました');
    }
  } catch (e) {
    // シートが存在しない場合は作成
    if (e.message?.includes('Unable to parse range') || e.message?.includes('not found')) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
        });
        await appendRow(HEADERS);
        console.log('[INIT] シートを新規作成しヘッダーを追加しました');
      } catch (e2) { console.warn('[WARN] シート作成失敗:', e2.message); }
    } else {
      console.warn('[WARN] シート初期化失敗:', e.message);
    }
  }
}

app.listen(PORT, async () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
  try { await initSheetHeader(); } catch (e) { console.warn('[WARN]', e.message); }
});
