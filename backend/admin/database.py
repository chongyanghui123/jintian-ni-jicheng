"""SQLite 封装：本地运营库，字段与云上集合同口径（questions / reports）。"""
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'admin.db')


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            optionA TEXT NOT NULL,
            optionB TEXT NOT NULL,
            show_date TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_id TEXT NOT NULL,
            target_type TEXT NOT NULL DEFAULT 'question',
            reason TEXT NOT NULL,
            detail TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS submissions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            optionA TEXT NOT NULL,
            optionB TEXT NOT NULL,
            signature TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            show_date TEXT,
            reject_reason TEXT,
            notify_text TEXT,
            source TEXT NOT NULL DEFAULT 'import',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            question_id TEXT NOT NULL,
            option TEXT NOT NULL,
            content TEXT NOT NULL,
            hidden INTEGER NOT NULL DEFAULT 0,
            report_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            contact TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            reply TEXT DEFAULT '',
            reward INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            handled_at TEXT
        );
        CREATE TABLE IF NOT EXISTS wheel_prizes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'points',
            value INTEGER NOT NULL DEFAULT 0,
            weight INTEGER NOT NULL DEFAULT 1,
            stock INTEGER NOT NULL DEFAULT -1,
            enabled INTEGER NOT NULL DEFAULT 1,
            sort INTEGER NOT NULL DEFAULT 0,
            image TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS draw_chances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            ref_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wheel_draws (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            prize_id TEXT,
            prize_name TEXT NOT NULL,
            prize_type TEXT NOT NULL DEFAULT 'none',
            prize_value INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'won',
            contact_name TEXT DEFAULT '',
            contact_phone TEXT DEFAULT '',
            contact_address TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_wheel_draws_user ON wheel_draws(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_questions_show_date ON questions(show_date);
        CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
        CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
        CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
        """
    )
    # 兼容升级：questions 补 source 字段（builtin 内置 / miniprogram 用户投稿）
    cols = [r[1] for r in conn.execute('PRAGMA table_info(questions)')]
    if 'source' not in cols:
        conn.execute("ALTER TABLE questions ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'")
    # 兼容升级：submissions 补 approved_at（审核通过时间，用于按序排期）与 question_id（关联生成的题）
    scols = [r[1] for r in conn.execute('PRAGMA table_info(submissions)')]
    if 'approved_at' not in scols:
        conn.execute('ALTER TABLE submissions ADD COLUMN approved_at TEXT')
    if 'question_id' not in scols:
        conn.execute('ALTER TABLE submissions ADD COLUMN question_id TEXT')
    # 默认设置：意见采纳奖励积分（后台「意见反馈」页可改，不在代码里硬编码）
    conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('feedback_reward_points', '20')")
    # 首次启动写入默认转盘奖品（后台「转盘奖品」可增删改）
    if conn.execute('SELECT COUNT(*) c FROM wheel_prizes').fetchone()['c'] == 0:
        conn.executemany(
            'INSERT INTO wheel_prizes (id, name, type, value, weight, stock, enabled, sort) '
            'VALUES (?,?,?,?,?,?,?,?)',
            [
                ('w_none', '谢谢参与', 'none', 0, 30, -1, 1, 1),
                ('w_p5', '5 积分', 'points', 5, 25, -1, 1, 2),
                ('w_p10', '10 积分', 'points', 10, 20, -1, 1, 3),
                ('w_p20', '20 积分', 'points', 20, 12, -1, 1, 4),
                ('w_p50', '50 积分', 'points', 50, 6, -1, 1, 5),
                ('w_p100', '100 积分', 'points', 100, 2, -1, 1, 6),
                ('w_gift', '实物周边（示例）', 'physical', 0, 3, 5, 1, 7),
            ])
    conn.commit()
    conn.close()


def next_question_id(conn: sqlite3.Connection) -> str:
    """生成 q101 式自增 ID（q001~q030 已被内置题库占用）。"""
    rows = conn.execute("SELECT id FROM questions WHERE id GLOB 'q[0-9]*'").fetchall()
    max_no = 100
    for r in rows:
        try:
            max_no = max(max_no, int(r['id'][1:]))
        except ValueError:
            continue
    return f'q{max_no + 1}'
