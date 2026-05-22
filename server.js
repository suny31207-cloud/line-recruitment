// server.js - LINE採用管理システム v2 (SQLite + Google Sheetsバックアップ)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const LIFF_ID = process.env.LIFF_ID || '';

// ===== ステータス定義 =====
const STATUSES = [
  '応募直後', 'アンケート未回答', 'アンケート回答済み', '確認待ち',
  '見学誘導中', '見学予約済み', '見学対応済み',
  '見学後アンケート送信済み', '見学後アンケート回答済み',
  '面接調整中', '面接予約済み', '面接対応済み',
  '入社確認中', '入社承諾', '辞退', '不採用', '対応完了', 'ブロック済み'
];
const STORES = ['三軒茶屋店','経堂店','桜新町店','溝口店','阿佐ヶ谷店','都立大学店','学芸大学店','高円寺店','たまプラーザ店','町田店','表参道店'];

// ===== Express設定 =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.urlencoded({ extended: true }));
app.use('/survey', express.urlencoded({ extended: true }));

// ===== セッション設定 =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'line-recruit-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
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

// ===== Google Sheets設定（バックアップ用） =====
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

// ===== メール設定 =====
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

// ===== ヘルパー関数 =====
function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function formatDatetimeLocal(val) {
  if (!val) return '';
  const m = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{2}:\d{2})/);
  if (m) return `${m[1]}/${parseInt(m[2])}/${parseInt(m[3])} ${m[4]}`;
  return val;
}

function getAutoReply(key) {
  const r = db.prepare('SELECT * FROM auto_replies WHERE key=?').get(key);
  if (!r || !r.is_active) return null;
  return r.content;
}

function saveMessage(lineUserId, direction, content, sentBy = 'bot') {
  db.prepare('INSERT INTO messages (line_user_id, direction, content, sent_at, sent_by) VALUES (?,?,?,?,?)')
    .run(lineUserId, direction, content, nowJST(), sentBy);
}

function upsertCandidate(lineUserId, updates) {
  const existing = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(lineUserId);
  if (existing) {
    const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE candidates SET ${sets} WHERE line_user_id=?`)
      .run(...Object.values(updates), lineUserId);
  } else {
    const cols = ['line_user_id', 'registered_at', ...Object.keys(updates)];
    const vals = [lineUserId, nowJST(), ...Object.values(updates)];
    db.prepare(`INSERT INTO candidates (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...vals);
  }
}

// ===== メール通知 =====
function getAllAdminEmails() {
  const emails = new Set();
  if (process.env.NOTIFY_EMAIL_TO) {
    process.env.NOTIFY_EMAIL_TO.split(',').forEach(e => emails.add(e.trim()));
  }
  try {
    const admins = db.prepare('SELECT email FROM admins WHERE email IS NOT NULL AND email != ""').all();
    admins.forEach(a => emails.add(a.email.trim()));
  } catch (e) {}
  return [...emails];
}

async function sendNotification(subject, body) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  try {
    const to = getAllAdminEmails();
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

// ===== Google Sheets バックアップ（オプション） =====
async function sheetsBackupCandidate(candidate) {
  if (!SHEET_ID) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:C`,
    });
    const rows = res.data.values || [];
    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[1] === candidate.line_user_id) { targetRow = i + 1; break; }
    }
    const values = [[
      candidate.registered_at || '', candidate.line_user_id || '',
      candidate.name || '', candidate.gender || '', candidate.age || '',
      candidate.phone || '', candidate.station || '', candidate.store || '',
      candidate.employment || '', candidate.start_date || '', candidate.experience || '',
      candidate.side_shampoo || '', candidate.preference || '', candidate.status || '',
      candidate.visit_date || '', candidate.interview_date || '',
      candidate.answer_date || '', candidate.answer || '',
      candidate.last_sent || '', candidate.note || '',
      candidate.needs_reply || '', candidate.latest_inquiry || '',
      candidate.latest_inquiry_date || '', candidate.last_received || '',
    ]];
    if (targetRow > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${targetRow}:X${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:X`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
    }
  } catch (e) { console.warn('[WARN] Sheetsバックアップ失敗:', e.message); }
}

// ===== LINEメッセージ構築 =====
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

  upsertCandidate(userId, {
    display_name: displayName,
    status: '応募直後',
  });

  const greetingContent = getAutoReply('greeting');
  const surveyUrl = `${APP_URL}/survey/${userId}`;

  const msgs = [];
  if (greetingContent) {
    msgs.push({ type: 'text', text: greetingContent });
  }
  msgs.push({
    type: 'text',
    text: `▼ アンケートはこちら\n${surveyUrl}`,
  });

  try {
    await client.replyMessage(event.replyToken, msgs);
    const sentContent = msgs.map(m => m.text).join('\n---\n');
    saveMessage(userId, 'out', sentContent, 'bot');
    upsertCandidate(userId, { last_sent: nowJST() });
  } catch (e) { console.error('[ERROR] follow返信失敗:', e.message); }

  try {
    const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
    await sendNotification(
      `【新規応募】${displayName}様が友達追加しました`,
      `${displayName}様（${userId}）が友達追加しました。\n\n▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
    );
    if (c) await sheetsBackupCandidate(c);
  } catch (e) { console.error('[ERROR] follow後処理失敗:', e.message); }

  console.log(`[FOLLOW] ${displayName} (${userId})`);
}

async function handleUnfollow(event) {
  const userId = event.source.userId;
  upsertCandidate(userId, {
    is_blocked: 1,
    blocked_at: nowJST(),
    status: 'ブロック済み',
  });
  console.log(`[UNFOLLOW/BLOCK] ${userId}`);
  try {
    await sendNotification(
      `【ブロック】応募者がブロックしました`,
      `LINE ID: ${userId} がブロック/友達削除しました。\n\n▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
    );
  } catch (e) { console.error('[ERROR] ブロック通知メール失敗:', e.message); }
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text?.trim();
  if (!text) return;

  saveMessage(userId, 'in', text);

  const now = nowJST();
  let nameForNew = null;
  const existing = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
  if (!existing) {
    try { const p = await client.getProfile(userId); nameForNew = p.displayName; } catch (e) {}
  }

  const updateData = {
    needs_reply: '要返信',
    latest_inquiry: text,
    latest_inquiry_date: now,
    last_received: now,
  };
  if (nameForNew) {
    updateData.display_name = nameForNew;
  }
  upsertCandidate(userId, updateData);

  const unexpectedContent = getAutoReply('unexpected');
  if (unexpectedContent) {
    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: unexpectedContent });
      saveMessage(userId, 'out', unexpectedContent, 'bot');
      upsertCandidate(userId, { last_sent: now, last_auto_reply: now });
      console.log(`[MSG] 想定外自動返信送信: ${userId}`);
    } catch (e) { console.error('[ERROR] 想定外返信失敗:', e.message); }
  }
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  if (action === 'join' || action === 'decline') {
    const isJoin = action === 'join';
    const answerText = isJoin ? '入社希望' : '辞退';
    const statusText = isJoin ? '入社承諾' : '辞退';
    const replyKey = isJoin ? 'join_confirm' : 'decline_confirm';
    const replyContent = getAutoReply(replyKey) || (isJoin
      ? 'ご回答ありがとうございます。\n入社希望として承りました。\n担当者より改めてご連絡いたします。'
      : 'ご回答ありがとうございます。\n辞退として承りました。この度はご検討いただきありがとうございました。');

    upsertCandidate(userId, {
      answer: answerText,
      answer_date: nowJST(),
      status: statusText,
    });

    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: replyContent });
      saveMessage(userId, 'out', replyContent, 'bot');
      upsertCandidate(userId, { last_sent: nowJST() });
    } catch (e) { console.error('[ERROR] postback返信失敗:', e.message); }

    try {
      const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
      const name = c?.name || c?.display_name || userId;
      await sendNotification(
        `【採用回答】${name}様より「${answerText}」の回答がありました`,
        `${name}様より回答がありました。\n\n回答結果：${answerText}\n回答日時：${nowJST()}\n\n▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
      );
      if (c) await sheetsBackupCandidate(c);
    } catch (e) { console.error('[ERROR] postback後処理失敗:', e.message); }
    return;
  }
}

// ===== Webhookエンドポイント =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try {
      if (event.type === 'follow') await handleFollow(event);
      else if (event.type === 'unfollow') await handleUnfollow(event);
      else if (event.type === 'message' && event.message?.type === 'text') await handleMessage(event);
      else if (event.type === 'postback') await handlePostback(event);
    } catch (e) {
      console.error('[ERROR] イベント処理失敗:', e.message, e.stack);
    }
  }
});

// ===== 認証チェックミドルウェア =====
function requireAuth(req, res, next) {
  if (req.session.adminLoggedIn) return next();
  res.redirect('/admin/login');
}

// ===== 管理者ログイン =====
app.get('/admin/login', (req, res) => {
  if (req.session.adminLoggedIn) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { id, password } = req.body;
  const masterId = process.env.ADMIN_ID || 'admin';
  const masterPass = process.env.ADMIN_PASSWORD || 'colorkitchen2026';

  const found = db.prepare('SELECT * FROM admins WHERE admin_id=?').get(id);
  if (found) {
    if (found.password === password) {
      req.session.adminLoggedIn = true;
      req.session.adminId = id;
      req.session.isMaster = (id === masterId);
      return res.redirect('/admin');
    }
    return res.render('admin/login', { error: 'IDまたはパスワードが違います' });
  }
  // DBに未登録のマスター管理者フォールバック
  if (id === masterId && password === masterPass) {
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

// ===== 管理画面：一覧 =====
app.get('/admin', requireAuth, (req, res) => {
  try {
    const candidates = db.prepare('SELECT * FROM candidates ORDER BY registered_at DESC').all();
    const candidatesWithMessages = candidates.map(c => {
      const recentMessages = db.prepare(
        'SELECT * FROM messages WHERE line_user_id=? ORDER BY sent_at DESC LIMIT 5'
      ).all(c.line_user_id);
      return { ...c, recentMessages };
    });
    res.render('admin/index', {
      candidates: candidatesWithMessages,
      statuses: STATUSES,
    });
  } catch (e) {
    console.error('[ERROR] 一覧取得失敗:', e.message);
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== 管理画面：詳細 =====
app.get('/admin/candidates/:uid', requireAuth, (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(req.params.uid);
    if (!c) return res.status(404).send('応募者が見つかりません');
    const messages = db.prepare(
      'SELECT * FROM messages WHERE line_user_id=? ORDER BY sent_at ASC'
    ).all(req.params.uid);
    const visitSurvey = db.prepare(
      'SELECT * FROM visit_surveys WHERE line_user_id=? ORDER BY submitted_at DESC LIMIT 1'
    ).get(req.params.uid);
    const templates = db.prepare('SELECT * FROM templates WHERE is_active=1 ORDER BY id').all();
    const lineOfficialChatUrl = process.env.LINE_OFFICIAL_CHAT_URL || '';

    let candidateDates = [];
    if (c && c.note && c.note.includes('【候補日時】')) {
      const block = c.note.match(/【候補日時】([\s\S]*?)(\n\n|$)/);
      if (block) {
        block[1].trim().split('\n').forEach(line => {
          const dm = line.match(/第(\d)希望[：:]\s*(.+)/);
          if (dm) candidateDates.push({ label: `第${dm[1]}希望`, value: dm[2].trim() });
        });
      }
    }

    res.render('admin/detail', {
      c,
      messages,
      visitSurvey: visitSurvey || null,
      templates,
      statuses: STATUSES,
      stores: STORES,
      msg: req.query.msg || '',
      lineOfficialChatUrl,
      candidateDates,
    });
  } catch (e) {
    console.error('[ERROR] 詳細取得失敗:', e.message);
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== 管理画面：更新 =====
app.post('/admin/candidates/:uid', requireAuth, (req, res) => {
  const userId = req.params.uid;
  const b = req.body;
  try {
    const prev = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
    if (!prev) return res.status(404).send('応募者が見つかりません');

    upsertCandidate(userId, {
      name: b.name || '',
      kana: b.kana || '',
      gender: b.gender || '',
      age: b.age || '',
      phone: b.phone || '',
      station: b.station || '',
      store: b.store || '',
      employment: b.employment || '',
      start_date: b.start_date || '',
      experience: b.experience || '',
      side_shampoo: b.side_shampoo || '',
      preference: b.preference || '',
      status: b.status || prev.status,
      visit_date: b.visit_date || '',
      interview_date: b.interview_date || '',
      note: b.note || '',
    });

    if (b.status && b.status !== prev.status) {
      console.log(`[STATUS] ${userId}: ${prev.status} → ${b.status}`);
    }

    // 面接対応済みに変更 → 入社/辞退ボタンを自動送信
    if (b.status === '面接対応済み' && prev.status !== '面接対応済み') {
      const name = b.name || prev.name || '応募者';
      client.pushMessage(userId, buildInterviewMessages(name))
        .then(() => {
          const sentContent = `[面接後入社確認ボタン送信] ${name}様`;
          saveMessage(userId, 'out', sentContent, req.session.adminId || 'bot');
          upsertCandidate(userId, { last_sent: nowJST() });
          console.log(`[AUTO-SEND] 面接後ボタン送信: ${userId}`);
        })
        .catch(e => console.error('[ERROR] LINE push失敗:', e.message));
    }

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('更新しました')}`);
  } catch (e) {
    console.error('[ERROR] 更新失敗:', e.message);
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== 管理画面：LINE個別送信 =====
app.post('/admin/candidates/:uid/send', requireAuth, async (req, res) => {
  const userId = req.params.uid;
  const { messageType, customText, template_id } = req.body;
  try {
    const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
    if (!c) return res.status(404).send('応募者が見つかりません');
    const name = c.name || c.display_name || '応募者';

    let msgs;
    let logContent;

    if (messageType === 'interview_followup') {
      msgs = buildInterviewMessages(name);
      logContent = '[面接後入社確認]';
    } else if (messageType === 'visit_invite') {
      const content = getAutoReply('visit_invite') || '担当者より見学についてご案内します。\nご都合のよい日時をお知らせください。';
      msgs = [{ type: 'text', text: content }];
      logContent = content;
    } else if (messageType === 'rejection') {
      const content = getAutoReply('rejection') || 'この度はCOLOR KITCHENにご応募いただきありがとうございました。\n慎重に検討いたしました結果、今回は採用を見送らせていただきます。';
      msgs = [{ type: 'text', text: content }];
      logContent = content;
      upsertCandidate(userId, { status: '不採用' });
    } else if (messageType === 'visit_survey') {
      const surveyUrl = `${APP_URL}/survey-visit/${userId}`;
      let content = getAutoReply('visit_survey_request') || '本日は見学にお越しいただきありがとうございました！\n引き続き見学後のアンケートにご回答いただけますか？\n\n▼アンケートはこちら\n{survey_url}';
      content = content.replace('{survey_url}', surveyUrl);
      msgs = [{ type: 'text', text: content }];
      logContent = content;
      upsertCandidate(userId, { status: '見学後アンケート送信済み' });
    } else if (messageType === 'template' && template_id) {
      const tmpl = db.prepare('SELECT * FROM templates WHERE id=?').get(template_id);
      if (!tmpl) return res.status(400).send('テンプレートが見つかりません');
      msgs = [{ type: 'text', text: tmpl.content }];
      logContent = tmpl.content;
    } else if (messageType === 'custom' && customText) {
      msgs = [{ type: 'text', text: customText }];
      logContent = customText;
    } else {
      return res.status(400).send('送信タイプが不正です');
    }

    await client.pushMessage(userId, msgs);
    saveMessage(userId, 'out', logContent, req.session.adminId || 'admin');
    upsertCandidate(userId, { last_sent: nowJST() });
    if (c.needs_reply === '要返信') {
      upsertCandidate(userId, { needs_reply: '対応済み' });
    }

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('LINEを送信しました')}`);
  } catch (e) {
    console.error('[ERROR] LINE送信失敗:', e.message);
    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('送信失敗: ' + e.message)}`);
  }
});

// ===== 管理画面：要返信→対応済み =====
app.post('/admin/candidates/:uid/mark-replied', requireAuth, (req, res) => {
  const userId = req.params.uid;
  try {
    upsertCandidate(userId, { needs_reply: '対応済み' });
    console.log(`[MARK-REPLIED] 要返信→対応済み: ${userId}`);
    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('要返信を対応済みにしました')}`);
  } catch (e) {
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== 管理画面：候補日時承認 =====
app.post('/admin/candidates/:uid/confirm-date', requireAuth, async (req, res) => {
  const userId = req.params.uid;
  const { confirmed_date, date_type } = req.body;
  try {
    const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
    if (!c) return res.status(404).send('応募者が見つかりません');

    const updates = {};
    if (date_type === 'visit') {
      updates.visit_date = confirmed_date;
      updates.status = '見学予約済み';
    } else {
      updates.interview_date = confirmed_date;
      updates.status = '面接予約済み';
    }

    const newNote = (c.note || '').replace(
      /【候補日時】[\s\S]*?(\n\n|$)/,
      `【確認済み候補日時】\n${confirmed_date}\n\n`
    );
    updates.note = newNote.trimEnd();
    upsertCandidate(userId, updates);

    const label = date_type === 'visit' ? '見学' : '面接';
    const name = c.name || c.display_name || '';
    const confirmMsg = `${name}様\n\n${label}日程が確定しました。\n\n日時：${confirmed_date}\n\nご来店をお待ちしております😊`;

    try {
      await client.pushMessage(userId, { type: 'text', text: confirmMsg });
      saveMessage(userId, 'out', confirmMsg, req.session.adminId || 'admin');
      upsertCandidate(userId, { last_sent: nowJST() });
    } catch (e) { console.error('[ERROR] 日程確認LINE送信失敗:', e.message); }

    res.redirect(`/admin/candidates/${userId}?msg=${encodeURIComponent('日程を確定しLINEを送信しました')}`);
  } catch (e) {
    console.error('[ERROR] 日程確定失敗:', e.message);
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== テンプレート管理 =====
app.get('/admin/templates', requireAuth, (req, res) => {
  try {
    const templates = db.prepare('SELECT * FROM templates ORDER BY id').all();
    res.render('admin/templates', { templates, msg: req.query.msg || '' });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/templates', requireAuth, (req, res) => {
  const { name, purpose, content } = req.body;
  if (!name || !content) return res.redirect('/admin/templates?msg=' + encodeURIComponent('名前と内容は必須です'));
  try {
    db.prepare('INSERT INTO templates (name, purpose, content, is_active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
      .run(name, purpose || '', content, nowJST(), nowJST());
    res.redirect('/admin/templates?msg=' + encodeURIComponent('テンプレートを追加しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.get('/admin/templates/:id/edit', requireAuth, (req, res) => {
  try {
    const tmpl = db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
    if (!tmpl) return res.redirect('/admin/templates?msg=' + encodeURIComponent('テンプレートが見つかりません'));
    const templates = db.prepare('SELECT * FROM templates ORDER BY id').all();
    res.render('admin/templates', { templates, editTemplate: tmpl, msg: req.query.msg || '' });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/templates/:id/edit', requireAuth, (req, res) => {
  const { name, purpose, content, is_active } = req.body;
  if (!name || !content) return res.redirect(`/admin/templates/${req.params.id}/edit?msg=` + encodeURIComponent('名前と内容は必須です'));
  try {
    db.prepare('UPDATE templates SET name=?, purpose=?, content=?, is_active=?, updated_at=? WHERE id=?')
      .run(name, purpose || '', content, is_active ? 1 : 0, nowJST(), req.params.id);
    res.redirect('/admin/templates?msg=' + encodeURIComponent('テンプレートを更新しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/templates/:id/delete', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id);
    res.redirect('/admin/templates?msg=' + encodeURIComponent('テンプレートを削除しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 自動返信設定 =====
app.get('/admin/auto-replies', requireAuth, (req, res) => {
  try {
    const autoReplies = db.prepare('SELECT * FROM auto_replies ORDER BY id').all();
    res.render('admin/auto-replies', { autoReplies, msg: req.query.msg || '' });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/auto-replies', requireAuth, (req, res) => {
  try {
    const updates = req.body;
    // key_xxx = content, active_xxx = 1/0 の形式で受け取る
    const keys = db.prepare('SELECT key FROM auto_replies').all().map(r => r.key);
    for (const key of keys) {
      const content = updates[`content_${key}`];
      const isActive = updates[`active_${key}`] ? 1 : 0;
      if (content !== undefined) {
        db.prepare('UPDATE auto_replies SET content=?, is_active=?, updated_at=? WHERE key=?')
          .run(content, isActive, nowJST(), key);
      }
    }
    res.redirect('/admin/auto-replies?msg=' + encodeURIComponent('自動返信設定を保存しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== 管理者設定 =====
app.get('/admin/settings', requireAuth, (req, res) => {
  try {
    const masterId = process.env.ADMIN_ID || 'admin';
    const allAdmins = db.prepare('SELECT * FROM admins ORDER BY registered_at').all();
    const masterInfo = allAdmins.find(a => a.admin_id === masterId) || null;
    const admins = allAdmins.filter(a => a.admin_id !== masterId);
    res.render('admin/settings', {
      admins, masterInfo, masterAdminId: masterId,
      msg: req.query.msg || '', error: null,
      isMaster: req.session.isMaster,
      editAdmin: null,
    });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/add', requireAuth, (req, res) => {
  const { id, password, name, email, role, store } = req.body;
  if (!id || !password || !name) return res.redirect('/admin/settings?msg=' + encodeURIComponent('ID・パスワード・名前は必須です'));
  const masterId = process.env.ADMIN_ID || 'admin';
  if (id === masterId) return res.redirect('/admin/settings?msg=' + encodeURIComponent('そのIDは使用できません'));
  try {
    const existing = db.prepare('SELECT id FROM admins WHERE admin_id=?').get(id);
    if (existing) return res.redirect('/admin/settings?msg=' + encodeURIComponent('そのIDは既に使用されています'));
    db.prepare('INSERT INTO admins (admin_id, password, name, email, role, store, registered_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, password, name, email || '', role || 'admin', store || '', nowJST());
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${name}（${id}）を追加しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.get('/admin/settings/edit/:adminId', requireAuth, (req, res) => {
  const targetId = req.params.adminId;
  const masterId = process.env.ADMIN_ID || 'admin';
  try {
    const found = db.prepare('SELECT * FROM admins WHERE admin_id=?').get(targetId);
    let editAdmin;
    if (found) {
      editAdmin = found;
    } else if (targetId === masterId) {
      editAdmin = { admin_id: masterId, name: '管理者', email: process.env.NOTIFY_EMAIL_TO || '', role: 'master', store: '' };
    } else {
      return res.redirect('/admin/settings?msg=' + encodeURIComponent('アカウントが見つかりません'));
    }
    const allAdmins = db.prepare('SELECT * FROM admins ORDER BY registered_at').all();
    const masterInfo = allAdmins.find(a => a.admin_id === masterId) || null;
    const admins = allAdmins.filter(a => a.admin_id !== masterId);
    res.render('admin/settings', {
      admins, masterInfo, masterAdminId: masterId,
      msg: req.query.msg || '', error: null,
      isMaster: req.session.isMaster,
      editAdmin,
    });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/edit/:adminId', requireAuth, (req, res) => {
  const targetId = req.params.adminId;
  const masterId = process.env.ADMIN_ID || 'admin';
  const { password, name, email, role, store } = req.body;
  if (!name) return res.redirect(`/admin/settings/edit/${targetId}?msg=` + encodeURIComponent('名前は必須です'));
  try {
    const found = db.prepare('SELECT * FROM admins WHERE admin_id=?').get(targetId);
    if (found) {
      const newPass = password || found.password;
      db.prepare('UPDATE admins SET password=?, name=?, email=?, role=?, store=? WHERE admin_id=?')
        .run(newPass, name, email || '', role || found.role, store || '', targetId);
    } else if (targetId === masterId) {
      if (!password) return res.redirect(`/admin/settings/edit/${targetId}?msg=` + encodeURIComponent('初回登録時はパスワードの入力が必要です'));
      db.prepare('INSERT INTO admins (admin_id, password, name, email, role, store, registered_at) VALUES (?,?,?,?,?,?,?)')
        .run(targetId, password, name, email || '', 'master', store || '', nowJST());
    } else {
      return res.redirect('/admin/settings?msg=' + encodeURIComponent('アカウントが見つかりません'));
    }
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${name}（${targetId}）を更新しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/delete/:adminId', requireAuth, (req, res) => {
  const targetId = req.params.adminId;
  const masterId = process.env.ADMIN_ID || 'admin';
  if (targetId === masterId) return res.redirect('/admin/settings?msg=' + encodeURIComponent('マスター管理者は削除できません'));
  try {
    db.prepare('DELETE FROM admins WHERE admin_id=?').run(targetId);
    res.redirect('/admin/settings?msg=' + encodeURIComponent(`${targetId} を削除しました`));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== LINE設定 =====
app.get('/admin/settings/line', requireAuth, (req, res) => {
  try {
    const lineSettings = db.prepare('SELECT * FROM line_settings').all();
    const settingsMap = {};
    lineSettings.forEach(s => { settingsMap[s.key] = s.value; });
    res.render('admin/settings-line', {
      settings: settingsMap,
      env: {
        LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN ? '設定済み' : '未設定',
        LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET ? '設定済み' : '未設定',
        APP_URL: process.env.APP_URL || '',
        LIFF_ID: process.env.LIFF_ID || '',
        LINE_OFFICIAL_CHAT_URL: process.env.LINE_OFFICIAL_CHAT_URL || '',
      },
      msg: req.query.msg || '',
    });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/settings/line', requireAuth, (req, res) => {
  try {
    const { account_name, account_id, add_friend_url, qr_code_url, webhook_url, liff_url } = req.body;
    const updates = {
      account_name, account_id, add_friend_url, qr_code_url, webhook_url, liff_url
    };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        db.prepare('INSERT OR REPLACE INTO line_settings (key, value, updated_at) VALUES (?,?,?)')
          .run(key, value || '', nowJST());
      }
    }
    res.redirect('/admin/settings/line?msg=' + encodeURIComponent('LINE設定を保存しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== リッチメニュー設定 =====
app.get('/admin/richmenu', requireAuth, (req, res) => {
  try {
    const richMenuItems = db.prepare('SELECT * FROM rich_menu ORDER BY sort_order, id').all();
    res.render('admin/richmenu', { richMenuItems, msg: req.query.msg || '' });
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/richmenu', requireAuth, (req, res) => {
  const { label, url, display_text, is_active, sort_order } = req.body;
  try {
    db.prepare('INSERT INTO rich_menu (label, url, display_text, is_active, sort_order, updated_at) VALUES (?,?,?,?,?,?)')
      .run(label || '', url || '', display_text || '', is_active ? 1 : 0, sort_order || 0, nowJST());
    res.redirect('/admin/richmenu?msg=' + encodeURIComponent('リッチメニュー項目を追加しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/richmenu/:id/edit', requireAuth, (req, res) => {
  const { label, url, display_text, is_active, sort_order } = req.body;
  try {
    db.prepare('UPDATE rich_menu SET label=?, url=?, display_text=?, is_active=?, sort_order=?, updated_at=? WHERE id=?')
      .run(label || '', url || '', display_text || '', is_active ? 1 : 0, sort_order || 0, nowJST(), req.params.id);
    res.redirect('/admin/richmenu?msg=' + encodeURIComponent('リッチメニューを更新しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

app.post('/admin/richmenu/:id/delete', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM rich_menu WHERE id=?').run(req.params.id);
    res.redirect('/admin/richmenu?msg=' + encodeURIComponent('リッチメニュー項目を削除しました'));
  } catch (e) { res.status(500).send('エラー: ' + e.message); }
});

// ===== アンケートフォーム（応募時）=====
app.get('/survey/:uid', (req, res) => {
  res.render('survey', {
    uid: req.params.uid, liffId: LIFF_ID, stores: STORES,
    error: null, success: false, prefill: {},
  });
});

app.post('/survey/:uid', async (req, res) => {
  const userId = req.params.uid;
  const { name, gender, age, phone, station, store, employment, start_date, experience, side_shampoo, preference, date1, date2, date3 } = req.body;

  const renderError = (msg) => res.render('survey', {
    uid: userId, liffId: LIFF_ID, stores: STORES, error: msg, success: false, prefill: req.body,
  });

  if (!name || !gender || !age || !phone || !station || !store || !employment || !start_date || !experience || !side_shampoo || !preference || !date1) {
    return renderError('全ての項目を入力してください');
  }
  if (!/^[0-9]{10,11}$/.test(phone.replace(/[-\s]/g, ''))) {
    return renderError('携帯番号は10〜11桁の数字で入力してください（ハイフン不要）');
  }

  const dateParts = [`第1希望：${formatDatetimeLocal(date1)}`];
  if (date2) dateParts.push(`第2希望：${formatDatetimeLocal(date2)}`);
  if (date3) dateParts.push(`第3希望：${formatDatetimeLocal(date3)}`);
  const candidateNote = `【候補日時】\n${dateParts.join('\n')}`;

  try {
    upsertCandidate(userId, {
      name, gender, age, phone, station, store, employment,
      start_date, experience, side_shampoo, preference,
      note: candidateNote,
      status: 'アンケート回答済み',
    });

    res.render('survey', { uid: userId, liffId: LIFF_ID, stores: STORES, error: null, success: true, prefill: {} });

    // バックグラウンド処理
    (async () => {
      try {
        const surveyContent = getAutoReply('survey_complete') || 'アンケートのご記入ありがとうございます！\n内容を確認のうえ、担当者よりご連絡いたします。\nしばらくお待ちください😊';
        await client.pushMessage(userId, { type: 'text', text: surveyContent });
        saveMessage(userId, 'out', surveyContent, 'bot');
        upsertCandidate(userId, { last_sent: nowJST() });
      } catch (e) { console.warn('[WARN] アンケート後LINE送信失敗:', e.message); }

      try {
        await sendNotification(
          `【採用アンケート】新規回答：${name}`,
          `${name}様よりアンケートの回答がありました。\n\n` +
          `氏名：${name}\n希望店舗：${store}\n携帯番号：${phone}\n美容師経験：${experience}\n\n` +
          `▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
        );
      } catch (e) { console.error('[ERROR] アンケート後メール通知失敗:', e.message); }

      try {
        const c = db.prepare('SELECT * FROM candidates WHERE line_user_id=?').get(userId);
        if (c) await sheetsBackupCandidate(c);
      } catch (e) { console.warn('[WARN] アンケートSheetsバックアップ失敗:', e.message); }
    })();

  } catch (e) {
    console.error('[ERROR] アンケート保存失敗:', e.message);
    renderError('エラーが発生しました。もう一度お試しください。');
  }
});

// ===== 見学後アンケート =====
app.get('/survey-visit/:uid', (req, res) => {
  res.render('survey-visit', {
    uid: req.params.uid, stores: STORES,
    error: null, success: false, prefill: {},
  });
});

app.post('/survey-visit/:uid', async (req, res) => {
  const userId = req.params.uid;
  const {
    visit_date, visit_store, impression, motivation, concerns,
    anxiety, other_companies, desired_start, questions, wants_interview,
  } = req.body;

  try {
    db.prepare(
      `INSERT INTO visit_surveys
        (line_user_id, visit_date, visit_store, impression, motivation, concerns, anxiety, other_companies, desired_start, questions, wants_interview, submitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      userId, visit_date || '', visit_store || '', impression || '',
      motivation || '', concerns || '', anxiety || '', other_companies || '',
      desired_start || '', questions || '', wants_interview || '', nowJST()
    );

    upsertCandidate(userId, { status: '見学後アンケート回答済み' });

    res.render('survey-visit', {
      uid: userId, stores: STORES, error: null, success: true, prefill: {},
    });

    (async () => {
      try {
        await sendNotification(
          `【見学後アンケート】${userId}様が回答しました`,
          `見学後アンケートの回答がありました。\n\nLINE ID: ${userId}\n見学日: ${visit_date || '-'}\n見学店舗: ${visit_store || '-'}\n面接希望: ${wants_interview || '-'}\n\n▼ 管理画面\n${APP_URL}/admin/candidates/${userId}`
        );
      } catch (e) { console.error('[ERROR] 見学後アンケート通知失敗:', e.message); }
    })();

  } catch (e) {
    console.error('[ERROR] 見学後アンケート保存失敗:', e.message);
    res.render('survey-visit', {
      uid: userId, stores: STORES, error: 'エラーが発生しました。もう一度お試しください。', success: false, prefill: req.body,
    });
  }
});

// ===== ヘルスチェック =====
app.get('/', (req, res) => res.send('LINE採用管理システム v2 稼働中'));

// ===== サーバー起動 =====
app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);

  // adminsが空ならシードを実行
  const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM admins').get();
  const masterId = process.env.ADMIN_ID || 'admin';
  const masterPass = process.env.ADMIN_PASSWORD;
  if (adminCount.cnt === 0 && masterPass) {
    db.prepare('INSERT OR IGNORE INTO admins (admin_id, password, name, email, role, registered_at) VALUES (?,?,?,?,?,?)')
      .run(masterId, masterPass, '管理者', process.env.NOTIFY_EMAIL_TO || '', 'master', nowJST());
    console.log(`[INIT] マスター管理者（${masterId}）をDBに登録しました`);
  }

  // Google Sheets初期化（オプション）
  if (SHEET_ID) {
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:A1`,
    }).catch(e => {
      if (e.message?.includes('Unable to parse range') || e.message?.includes('not found')) {
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
        }).catch(e2 => console.warn('[WARN] シート作成失敗:', e2.message));
      }
    });
  }
});
