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
        CREATE INDEX IF NOT EXISTS idx_questions_show_date ON questions(show_date);
        CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
        CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
        """
    )
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
