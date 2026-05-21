// LINE採用管理システム
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
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

// ===== セッション設定 =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'line-recruit-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8時間
}));

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

// ===== 列定義（A〜Y = 0〜24）=====
const COL = {
  登録日時: 0, LINEユーザーID: 1, 氏名: 2, 性別: 3, 年齢: 4,
  携帯番号: 5, 最寄駅: 6, 希望店舗: 7, 希望雇用形態: 8, 勤務開始希望日: 9,
  美容師経験: 10, サイドシャンプーありなし: 11, 希望内容: 12, 現在ステータス: 13,
  見学予約日: 14, 面接予定日: 15, 回答日時: 16, 回答結果: 17, 最終LINE送信日時: 18, 備考: 19,
  要返信: 20, 最新問い合わせ内容: 21, 最新問い合わせ日時: 22, 最終LINE受信日時: 23, 最終想定外自動返信日時: 24,
};
const COL_COUNT = 25;
const HEADERS = [
  '登録日時', 'LINEユーザーID', '氏名', '性別', '年齢', '携帯番号',
  '最寄駅', '希望店舗', '希望雇用形態', '勤務開始希望日', '美容師経験',
  'サイドシャンプーありなし', '希望内容', '現在ステータス', '見学予約日',
  '面接予定日', '回答日時', '回答結果', '最終LINE送信日時', '備考',
  '要返信', '最新問い合わせ内容', '最新問い合わせ日時', '最終LINE受信日時', '最終想定外メッセージ自動返信日時',
];
const STATUSES = ['未対応', '見学対応済み', '面接対応済み', '対応完了'];
const STORES = ['三軒茶屋店','経堂店','桜新町店','溝口店','阿佐ヶ谷店','都立大学店','学芸大学店','高円寺店','たまプラーザ店','町田店','表参道店'];

// ===== 管理者シート定義 =====
const ADMIN_SHEET = '管理者';
const ACOL = { 登録日時: 0, ID: 1, パスワード: 2, 名前: 3, メールアドレス: 4 };

// ===== メール設定 =====
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ===== Google Sheets操作 =====
async function getSheetData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:Y`,
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
    range: `${SHEET_NAME}!A:Y`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padRow(values)] },
  });
}

async function updateRow(rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex + 1}:Y${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [padRow(values)] },
  });
}

// ===== 管理者シート操作 =====
async function getAdminSheetData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${ADMIN_SHEET}!A:E`,
  });
  return res.data.values || [];
}

async function getAllAdminEmails() {
  const emails = new Set();
  if (process.env.NOTIFY_EMAIL_TO) process.env.NOTIFY_EMAIL_TO.split(',').forEach(e => emails.add(e.trim()));
  try {
    const data = await getAdminSheetData();
    for (let i = 1; i < data.length; i++) {
      const email = (data[i] || [])[ACOL.メールアドレス];
      if (email) emails.add(email.trim());
    }
  } catch (e) {}
  return [...emails];
}

async function findAdminAccount(id) {
  try {
    const data = await getAdminSheetData();
    for (let i = 1; i < data.length; i++) {
      if ((data[i] || [])[ACOL.ID] === id) return { rowIndex: i, row: data[i] };
    }
  } catch (e) {}
  return null;
}

// ===== メール通知 =====
async function sendNotification(subject, body) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  try {
    const to = await getAllAdminEmails();
    if (!to.length) return;
    await mailer.sendMail({
      from: `COLOR KITCHEN 採用システム <${process.env.GMAIL_USER}>`,
      to: to.join(','),
      subject,
      text: body,
    });
    console.log(`[EMAIL] 送信完了: ${subject}`);
  } catch (e) { console.error('[ERROR] メール送信失敗:', e.message); }
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
  // LIFF URLはパス追加形式が不安定なため直リンクを使用
  const url = `${APP_URL}/survey/${userId}`;
  return {
    type: 'text',
    text: `ありがとうございます！\n続けて下記のアンケートにご記入ください。\n\n▼ アンケートはこちら\n${url}`,
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

function buildScheduleMessage(name, type, date) {
  const typeLabel = type === 'visit' ? '見学' : '面接';
  return [
    {
      type: 'text',
      text: `${name}様\n\n${typeLabel}日程が決まりましたのでお知らせします。\n\n【${typeLabel}予定日】\n${date}\n\nご確認のうえ、下記よりお返事ください。`,
    },
    {
      type: 'template',
      altText: `${typeLabel}日程の確認（アプリ画面でご確認ください）`,
      template: {
        type: 'buttons',
        title: `${typeLabel}日程の確認`,
        text: `${date} のご都合はいかがでしょうか？`,
        actions: [
          { type: 'postback', label: '確認しました', data: `action=confirm_schedule&type=${type}`, displayText: '確認しました' },
          { type: 'postback', label: '日程変更を希望する', data: `action=request_change&type=${type}`, displayText: '日程変更を希望する' },
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

  // ★ 先にLINE返信を送る
  await client.replyMessage(event.replyToken, [
    buildGreeting(),
    buildChoiceButtons(),
  ]);
  // ★ その後にシート更新
  await upsertCandidate(userId, { [COL.氏名]: displayName });
  console.log(`[FOLLOW] ${displayName} (${userId})`);
}

// 候補日時らしい文章かチェック（数字＋日付キーワードが含まれる）
function looksLikeDates(text) {
  const hasNumber = /\d/.test(text);
  const hasDateMarker = /[月日\/：:]|第\d|午前|午後|\d+時/.test(text);
  return hasNumber && hasDateMarker;
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text?.trim();

  // 見学/面接ボタン選択
  if (text === '見学希望' || text === '面接希望') {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `「${text}」を承りました！\n\nご都合の良い候補日時を3つ、このチャットに返信してください。\n\n＜例＞\n第1希望：6/5（木）14:00〜\n第2希望：6/7（土）11:00〜\n第3希望：6/8（日）15:00〜`,
    });
    await upsertCandidate(userId, {
      [COL.希望内容]: text,
      [COL.備考]: '__AWAITING_DATES',
      [COL.最終LINE受信日時]: nowJST(),
    });
    return;
  }

  const existing = await findRowByUserId(userId);

  // 候補日時待ち → 日付形式の内容のみ受け付ける
  if (existing) {
    const row = padRow(existing.rowData);
    if ((row[COL.備考] || '').startsWith('__AWAITING_DATES')) {
      if (looksLikeDates(text)) {
        await client.replyMessage(event.replyToken, [
          { type: 'text', text: '候補日時を承りました！\n続けてアンケートへのご記入をお願いします。' },
          buildSurveyLink(userId),
        ]);
        await upsertCandidate(userId, {
          [COL.備考]: `【候補日時】\n${text}`,
          [COL.最終LINE受信日時]: nowJST(),
        });
        return;
      }
      // 日付形式でない → 想定外として処理
      console.log(`[UNEXPECTED] 候補日時待ち中に日付以外のメッセージ: ${userId} → "${text}"`);
    }
  }

  // ===== 想定外メッセージ処理 =====
  // (未登録・希望未選択・候補日時待ちで日付以外・その他すべてここに集約)
  console.log(`[UNEXPECTED] 想定外メッセージ受信: ${userId} → "${text}"`);

  const now = nowJST();

  // 未登録の場合はプロフィール名で登録（upsertで新規作成される）
  let nameForNew = null;
  if (!existing) {
    try { const p = await client.getProfile(userId); nameForNew = p.displayName; } catch (e) {}
  }

  // ★ 先にLINE返信（replyTokenは時間制限あり）
  try {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '担当者より折り返しご連絡いたします。\n恐れ入りますが、少々お待ちください。',
    });
    console.log(`[UNEXPECTED] 自動返信送信完了: ${userId}`);
  } catch (e) {
    console.error('[ERROR] 想定外メッセージ自動返信失敗:', e.message);
  }

  // ★ シート更新
  try {
    const updateData = {
      [COL.要返信]: '要返信',
      [COL.最新問い合わせ内容]: text,
      [COL.最新問い合わせ日時]: now,
      [COL.最終LINE受信日時]: now,
      [COL.最終想定外自動返信日時]: now,
    };
    if (nameForNew) updateData[COL.氏名] = nameForNew;
    await upsertCandidate(userId, updateData);
  } catch (e) {
    console.error('[ERROR] 想定外メッセージ シート更新失敗:', e.message);
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const type = params.get('type'); // 'visit' or 'interview'

  // 入社/辞退
  if (action === 'join' || action === 'decline') {
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
    const answerTime = nowJST();
    try {
      await upsertCandidate(userId, {
        [COL.回答日時]: answerTime,
        [COL.回答結果]: result,
        [COL.現在ステータス]: '対応完了',
      });
      console.log(`[ANSWER] ${userId} → ${result}`);
      // 入社/辞退メール通知
      const answerRow = await findRowByUserId(userId);
      const answerName = answerRow ? padRow(answerRow.rowData)[COL.氏名] : userId;
      await sendNotification(
        `【採用回答】${answerName}様より「${result}」の回答がありました`,
        `${answerName}様より回答がありました。\n\n` +
        `回答結果：${result}\n回答日時：${answerTime}\n\n` +
        `▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
      );
    } catch (e) { console.error('[ERROR] sheets書き込み失敗:', e.message); }
    await client.replyMessage(event.replyToken, [{ type: 'text', text: replyText }]);
    return;
  }

  // 日程確認
  if (action === 'confirm_schedule') {
    const typeLabel = type === 'visit' ? '見学' : '面接';
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ご確認ありがとうございます。\n${typeLabel}日程を承りました。\n当日お待ちしております！`,
    });
    return;
  }

  // 日程変更希望
  if (action === 'request_change') {
    const typeLabel = type === 'visit' ? '見学' : '面接';
    try {
      const existing = await findRowByUserId(userId);
      if (existing) {
        const row = padRow(existing.rowData);
        const prevNote = row[COL.備考] || '';
        const changeNote = `【${typeLabel}日程変更希望】${nowJST()}`;
        const newNote = prevNote ? `${prevNote}\n${changeNote}` : changeNote;
        await upsertCandidate(userId, { [COL.備考]: newNote });
      }
    } catch (e) { console.error('[ERROR] 変更希望メモ失敗:', e.message); }
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${typeLabel}日程の変更ご希望を承りました。\n担当者より改めてご連絡いたします。\nご不便をおかけして申し訳ございません。`,
    });
    return;
  }
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

// ===== 管理者ログイン =====
app.get('/admin/login', (req, res) => {
  if (req.session.adminLoggedIn) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { id, password } = req.body;
  const masterId = process.env.ADMIN_ID || 'admin';
  try {
    const found = await findAdminAccount(id);
    if (found) {
      // シートに登録済み → シートのパスワードのみ有効（env varは無効）
      if ((found.row || [])[ACOL.パスワード] === password) {
        req.session.adminLoggedIn = true;
        req.session.adminId = id;
        req.session.isMaster = (id === masterId);
        return res.redirect('/admin');
      }
      return res.render('admin/login', { error: 'IDまたはパスワードが違います' });
    }
  } catch (e) { console.error('[ERROR] 管理者シート参照失敗:', e.message); }
  // シート未登録のマスター管理者 → env var フォールバック
  if (id === masterId && password === (process.env.ADMIN_PASSWORD || 'colorkitchen2026')) {
    req.session.adminLoggedIn = true;
    req.session.adminId = id;
    req.session.isMaster = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'IDまたはパスワードが違います' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ===== 認証チェックミドルウェア =====
function requireAuth(req, res, next) {
  if (req.session.adminLoggedIn) return next();
  res.redirect('/admin/login');
}

// ===== 管理者設定 =====
app.get('/admin/settings', requireAuth, async (req, res) => {
  const masterId = process.env.ADMIN_ID || 'admin';
  try {
    let admins = [];
    let masterInfo = null;
    const data = await getAdminSheetData();
    admins = data.slice(1).map(row => ({
      id: row[ACOL.ID] || '', name: row[ACOL.名前] || '', email: row[ACOL.メールアドレス] || '', registeredAt: row[ACOL.登録日時] || '',
    })).filter(a => a.id);
    const masterInSheet = admins.find(a => a.id === masterId);
    if (masterInSheet) {
      masterInfo = masterInSheet;
      admins = admins.filter(a => a.id !== masterId);
    }
    res.render('admin/settings', { admins, masterInfo, masterAdminId: masterId, msg: req.query.msg || '', error: null, isMaster: req.session.isMaster, editAdmin: null });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/add', requireAuth, async (req, res) => {
  const { id, password, name, email } = req.body;
  if (!id || !password || !name) return res.redirect('/admin/settings?msg=' + encodeURIComponent('ID・パスワード・名前は必須です'));
  try {
    const existing = await findAdminAccount(id);
    if (existing) return res.redirect('/admin/settings?msg=' + encodeURIComponent('そのIDは既に使用されています'));
    if (id === (process.env.ADMIN_ID || 'admin')) return res.redirect('/admin/settings?msg=' + encodeURIComponent('そのIDは使用できません'));
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${ADMIN_SHEET}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[nowJST(), id, password, name, email || '']] },
    });
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${name}（${id}）を追加しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.get('/admin/settings/edit/:adminId', requireAuth, async (req, res) => {
  const targetId = req.params.adminId;
  const masterId = process.env.ADMIN_ID || 'admin';
  try {
    const found = await findAdminAccount(targetId);
    let editAdmin;
    if (found) {
      const row = found.row || [];
      editAdmin = { id: row[ACOL.ID] || '', name: row[ACOL.名前] || '', email: row[ACOL.メールアドレス] || '' };
    } else if (targetId === masterId) {
      editAdmin = { id: masterId, name: '管理者', email: process.env.NOTIFY_EMAIL_TO || '' };
    } else {
      return res.redirect('/admin/settings?msg=' + encodeURIComponent('アカウントが見つかりません'));
    }
    res.render('admin/settings', {
      admins: [], masterInfo: null, masterAdminId: masterId,
      msg: req.query.msg || '', error: null,
      isMaster: req.session.isMaster,
      editAdmin,
    });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/edit/:adminId', requireAuth, async (req, res) => {
  const targetId = req.params.adminId;
  const masterId = process.env.ADMIN_ID || 'admin';
  const { password, name, email } = req.body;
  if (!name) return res.redirect(`/admin/settings/edit/${targetId}?msg=` + encodeURIComponent('名前は必須です'));
  try {
    const found = await findAdminAccount(targetId);
    if (found) {
      const row = [...(found.row || [])];
      while (row.length < 5) row.push('');
      row[ACOL.パスワード] = password || row[ACOL.パスワード];
      row[ACOL.名前] = name;
      row[ACOL.メールアドレス] = email || '';
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${ADMIN_SHEET}!A${found.rowIndex + 1}:E${found.rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
    } else if (targetId === masterId) {
      // マスター管理者がシート未登録の場合は新規追加
      if (!password) return res.redirect(`/admin/settings/edit/${targetId}?msg=` + encodeURIComponent('初回登録時はパスワードの入力が必要です'));
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${ADMIN_SHEET}!A:E`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[nowJST(), targetId, password, name, email || '']] },
      });
    } else {
      return res.redirect('/admin/settings?msg=' + encodeURIComponent('アカウントが見つかりません'));
    }
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${name}（${targetId}）を更新しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/delete/:adminId', requireAuth, async (req, res) => {
  const targetId = req.params.adminId;
  try {
    const found = await findAdminAccount(targetId);
    if (!found) return res.redirect('/admin/settings?msg=' + encodeURIComponent('アカウントが見つかりません'));
    // 該当行をクリア（空行にする）
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ADMIN_SHEET}!A${found.rowIndex + 1}:E${found.rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['', '', '', '', '']] },
    });
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${targetId} を削除しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：一覧 =====
app.get('/admin', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData();
    const candidates = data.slice(1)
      .map(row => {
        const r = padRow(row);
        const note = r[COL.備考] || '';
        return {
          lineUserId:      r[COL.LINEユーザーID],
          name:            r[COL.氏名],
          preference:      r[COL.希望内容],
          status:          r[COL.現在ステータス] || '未対応',
          visitDate:       r[COL.見学予約日],
          interviewDate:   r[COL.面接予定日],
          answer:          r[COL.回答結果],
          lastSent:        r[COL.最終LINE送信日時],
          registeredAt:    r[COL.登録日時],
          store:           r[COL.希望店舗],
          surveyDone:      !!(r[COL.携帯番号] || r[COL.希望店舗]),
          changeRequested: note.includes('日程変更希望'),
          needsReply:      r[COL.要返信] || '',
          latestInquiry:   r[COL.最新問い合わせ内容] || '',
          latestInquiryDate: r[COL.最新問い合わせ日時] || '',
          lastReceived:    r[COL.最終LINE受信日時] || '',
        };
      })
      .filter(c => c.lineUserId);
    res.render('admin/index', { candidates, statuses: STATUSES });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：詳細 =====
app.get('/admin/candidates/:uid', requireAuth, async (req, res) => {
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
      needsReply: r[COL.要返信] || '',
      latestInquiry: r[COL.最新問い合わせ内容] || '',
      latestInquiryDate: r[COL.最新問い合わせ日時] || '',
      lastReceived: r[COL.最終LINE受信日時] || '',
    };
    const lineOfficialChatUrl = process.env.LINE_OFFICIAL_CHAT_URL || '';
    res.render('admin/detail', { c, statuses: STATUSES, stores: STORES, msg: req.query.msg || '', lineOfficialChatUrl });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：更新 =====
app.post('/admin/candidates/:uid', requireAuth, async (req, res) => {
  const userId = req.params.uid;
  const b = req.body;
  try {
    const found = await findRowByUserId(userId);
    if (!found) return res.status(404).send('応募者が見つかりません');
    const prevRow = padRow(found.rowData);
    const prevStatus = prevRow[COL.現在ステータス];
    const prevVisitDate = prevRow[COL.見学予約日];
    const prevInterviewDate = prevRow[COL.面接予定日];

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

    // 見学予約日が新規設定または変更 → 日程確認メッセージ送信
    if (b.visitDate && b.visitDate !== prevVisitDate) {
      try {
        await client.pushMessage(userId, buildScheduleMessage(b.name || '応募者', 'visit', b.visitDate));
        await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
        console.log(`[AUTO-SEND] 見学日程通知: ${userId}`);
      } catch (e) { console.error('[ERROR] 見学日程LINE push失敗:', e.message); }
    }

    // 面接予定日が新規設定または変更 → 日程確認メッセージ送信
    if (b.interviewDate && b.interviewDate !== prevInterviewDate) {
      try {
        await client.pushMessage(userId, buildScheduleMessage(b.name || '応募者', 'interview', b.interviewDate));
        await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
        console.log(`[AUTO-SEND] 面接日程通知: ${userId}`);
      } catch (e) { console.error('[ERROR] 面接日程LINE push失敗:', e.message); }
    }

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('更新しました')}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：候補日時を承認して通知 =====
app.post('/admin/candidates/:uid/confirm-date', requireAuth, async (req, res) => {
  const userId = req.params.uid;
  const { date, type } = req.body;
  try {
    const found = await findRowByUserId(userId);
    if (!found) return res.status(404).send('応募者が見つかりません');
    const row = padRow(found.rowData);
    const name = row[COL.氏名] || '応募者';
    const typeLabel = type === 'visit' ? '見学' : '面接';
    const dateCol = type === 'visit' ? COL.見学予約日 : COL.面接予定日;

    // 備考の【候補日時】を【確認済み候補日時】に更新（ボタンを非表示にする）
    const newNote = (row[COL.備考] || '').replace('【候補日時】', '【確認済み候補日時】');
    await upsertCandidate(userId, {
      [dateCol]: date,
      [COL.備考]: newNote,
    });

    // 日程確定の通知をLINEで送信
    await client.pushMessage(userId, {
      type: 'text',
      text: `${name}様\n\n${typeLabel}の日程が確定いたしました。\n\n【${typeLabel}予定日】\n${date}\n\nお時間になりましたらお待ちしております！\nご不明な点はお気軽にご連絡ください。`,
    });
    await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
    console.log(`[CONFIRM-DATE] ${typeLabel}日程確定: ${userId} → ${date}`);

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent(`${typeLabel}日程を確定し、LINEで通知しました`)}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：LINE個別送信 =====
app.post('/admin/candidates/:uid/send', requireAuth, async (req, res) => {
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
    // 最終LINE送信日時を更新し、要返信ステータスを「対応済み」に自動更新
    const updateData = { [COL.最終LINE送信日時]: nowJST() };
    const currentRow = padRow(found.rowData);
    if (currentRow[COL.要返信] === '要返信') {
      updateData[COL.要返信] = '対応済み';
    }
    await upsertCandidate(userId, updateData);
    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('LINEを送信しました')}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理画面：要返信を対応済みにする =====
app.post('/admin/candidates/:uid/mark-replied', requireAuth, async (req, res) => {
  const userId = req.params.uid;
  try {
    const found = await findRowByUserId(userId);
    if (!found) return res.status(404).send('応募者が見つかりません');
    await upsertCandidate(userId, {
      [COL.要返信]: '対応済み',
    });
    console.log(`[MARK-REPLIED] 要返信→対応済み: ${userId}`);
    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('要返信を対応済みにしました')}`);
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== アンケートフォーム（GET）=====
app.get('/survey/:uid', (req, res) => {
  res.render('survey', {
    uid: req.params.uid, liffId: LIFF_ID, stores: STORES,
    error: null, success: false, prefill: {},
  });
});

// ===== アンケートフォーム（POST）=====
app.post('/survey/:uid', async (req, res) => {
  const userId = req.params.uid;
  const { name, gender, age, phone, station, store, employment, startDate, experience, sideshampoo } = req.body;

  const renderError = (msg) => res.render('survey', {
    uid: userId, liffId: LIFF_ID, stores: STORES, error: msg, success: false, prefill: req.body,
  });

  // バリデーション（全項目必須）
  if (!name || !gender || !age || !phone || !station || !store || !employment || !startDate || !experience || !sideshampoo) {
    return renderError('全ての項目を入力してください');
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

    // ===== ここで即座に完了画面を返す =====
    res.render('survey', { uid: userId, liffId: LIFF_ID, stores: STORES, error: null, success: true, prefill: {} });

    // ===== 以降はバックグラウンドで実行（レスポンスをブロックしない）=====
    (async () => {
      try {
        // メール通知
        const notifyRow = (await findRowByUserId(userId))?.rowData || [];
        const nr = padRow(notifyRow);
        const candidateDatesNote = (nr[COL.備考] || '').includes('【候補日時】')
          ? '\n\n' + nr[COL.備考].replace('__AWAITING_DATES', '')
          : '';
        await sendNotification(
          `【採用アンケート】新規回答：${name}`,
          `${name}様よりアンケートの回答がありました。\n\n` +
          `氏名：${name}\n希望内容：${nr[COL.希望内容] || '-'}\n希望店舗：${store}\n` +
          `携帯番号：${phone}\n美容師経験：${experience}` +
          `${candidateDatesNote}\n\n` +
          `▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
        );
      } catch (e) { console.error('[ERROR] アンケート後メール通知失敗:', e.message); }

      try {
        // LINE確認メッセージ送信
        await client.pushMessage(userId, {
          type: 'text',
          text: 'アンケートのご記入ありがとうございます！\n内容を確認のうえ、担当者よりご連絡いたします。\nしばらくお待ちください😊',
        });
        await upsertCandidate(userId, { [COL.最終LINE送信日時]: nowJST() });
      } catch (e) { console.warn('[WARN] アンケート後LINE送信失敗:', e.message); }
    })();
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

async function initAdminSheet() {
  try {
    const data = await getAdminSheetData();
    if (!data || data.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${ADMIN_SHEET}!A:E`, valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['登録日時', '管理者ID', 'パスワード', '名前', 'メールアドレス']] },
      });
    }
  } catch (e) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: ADMIN_SHEET } } }] },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${ADMIN_SHEET}!A:E`, valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['登録日時', '管理者ID', 'パスワード', '名前', 'メールアドレス']] },
      });
    } catch (e2) { console.warn('[WARN] 管理者シート作成失敗:', e2.message); }
  }
}

app.listen(PORT, async () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
  try { await initSheetHeader(); } catch (e) { console.warn('[WARN]', e.message); }
  try { await initAdminSheet(); } catch (e) { console.warn('[WARN] 管理者シート:', e.message); }
});
