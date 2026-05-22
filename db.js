// db.js - SQLite初期化 (better-sqlite3 同期API)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'recruitment.db');

// dataディレクトリを自動作成
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// WALモードで書き込みパフォーマンス向上
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== テーブル作成 =====
db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    name TEXT,
    kana TEXT,
    phone TEXT,
    age TEXT,
    gender TEXT,
    station TEXT,
    store TEXT,
    employment TEXT,
    start_date TEXT,
    experience TEXT,
    side_shampoo TEXT,
    preference TEXT,
    status TEXT DEFAULT '応募直後',
    visit_date TEXT,
    interview_date TEXT,
    answer TEXT,
    answer_date TEXT,
    note TEXT,
    needs_reply TEXT,
    latest_inquiry TEXT,
    latest_inquiry_date TEXT,
    last_sent TEXT,
    last_received TEXT,
    last_auto_reply TEXT,
    registered_at TEXT,
    blocked_at TEXT,
    is_blocked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    content TEXT,
    sent_at TEXT,
    sent_by TEXT DEFAULT 'bot'
  );

  CREATE TABLE IF NOT EXISTS visit_surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    visit_date TEXT,
    visit_store TEXT,
    impression TEXT,
    motivation TEXT,
    concerns TEXT,
    anxiety TEXT,
    other_companies TEXT,
    desired_start TEXT,
    questions TEXT,
    wants_interview TEXT,
    submitted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS entry_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    name TEXT,
    kana TEXT,
    birth_date TEXT,
    address TEXT,
    phone TEXT,
    emergency_contact TEXT,
    start_date TEXT,
    store TEXT,
    employment TEXT,
    bank_info TEXT,
    documents TEXT,
    note TEXT,
    submitted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    purpose TEXT,
    content TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auto_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT,
    content TEXT,
    is_active INTEGER DEFAULT 1,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT NOT NULL UNIQUE,
    password TEXT,
    name TEXT,
    email TEXT,
    role TEXT DEFAULT 'admin',
    store TEXT,
    registered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS rich_menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    url TEXT,
    display_text TEXT,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS line_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    updated_at TEXT
  );
`);

// ===== auto_repliesのデフォルト値 =====
const nowJST = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const defaultAutoReplies = [
  {
    key: 'greeting',
    label: '自動あいさつ',
    content: 'こんにちは！\nCOLOR KITCHEN採用担当です☺️\n\n応募いただきありがとうございます！\n下記よりアンケートへのご回答をお願いします。\n回答後、担当者より改めてご連絡します。',
    is_active: 1,
  },
  {
    key: 'unexpected',
    label: '想定外メッセージ返信',
    content: '担当者より折り返しご連絡いたします。\n恐れ入りますが、少々お待ちください。',
    is_active: 1,
  },
  {
    key: 'survey_complete',
    label: 'アンケート回答完了',
    content: 'アンケートのご記入ありがとうございます！\n内容を確認のうえ、担当者よりご連絡いたします。\nしばらくお待ちください😊',
    is_active: 1,
  },
  {
    key: 'visit_invite',
    label: '見学誘導メッセージ',
    content: '担当者より見学についてご案内します。\nご都合のよい日時をお知らせください。',
    is_active: 1,
  },
  {
    key: 'rejection',
    label: '不採用通知',
    content: 'この度はCOLOR KITCHENにご応募いただきありがとうございました。\n慎重に検討いたしました結果、今回は採用を見送らせていただきます。',
    is_active: 1,
  },
  {
    key: 'join_confirm',
    label: '入社確認',
    content: '入社希望として承りました。\n担当者より改めてご連絡いたします。',
    is_active: 1,
  },
  {
    key: 'decline_confirm',
    label: '辞退受付',
    content: 'ご連絡ありがとうございました。\n辞退として承りました。この度はご検討いただきありがとうございました。',
    is_active: 1,
  },
  {
    key: 'visit_survey_request',
    label: '見学後アンケート依頼',
    content: '本日は見学にお越しいただきありがとうございました！\n引き続き見学後のアンケートにご回答いただけますか？\n\n▼アンケートはこちら\n{survey_url}',
    is_active: 1,
  },
  {
    key: 'interview_followup',
    label: '面接後入社確認',
    content: '本日は面接にお越しいただきありがとうございました。\n⚠️重要⚠️\n1週間以内に下記よりご回答ください。',
    is_active: 1,
  },
];

const existingAutoReplies = db.prepare('SELECT COUNT(*) as cnt FROM auto_replies').get();
if (existingAutoReplies.cnt === 0) {
  const insertAutoReply = db.prepare(
    'INSERT OR IGNORE INTO auto_replies (key, label, content, is_active, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      insertAutoReply.run(r.key, r.label, r.content, r.is_active, nowJST());
    }
  });
  insertMany(defaultAutoReplies);
  console.log('[DB] auto_repliesデフォルト値を挿入しました');
}

// ===== templatesのデフォルト値 =====
const defaultTemplates = [
  { name: '見学案内', purpose: '見学', content: '【見学のご案内】\n\n日時：\n場所：\n\nご確認ください。' },
  { name: '面接案内', purpose: '面接', content: '【面接のご案内】\n\n日時：\n場所：COLOR KITCHEN\n\nよろしくお願いします。' },
  { name: '合否連絡', purpose: '結果', content: 'この度はありがとうございました。\n担当者よりご連絡いたします。' },
];

const existingTemplates = db.prepare('SELECT COUNT(*) as cnt FROM templates').get();
if (existingTemplates.cnt === 0) {
  const insertTemplate = db.prepare(
    'INSERT INTO templates (name, purpose, content, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
  );
  const insertManyTemplates = db.transaction((rows) => {
    for (const r of rows) {
      insertTemplate.run(r.name, r.purpose, r.content, nowJST(), nowJST());
    }
  });
  insertManyTemplates(defaultTemplates);
  console.log('[DB] templatesデフォルト値を挿入しました');
}

module.exports = db;
