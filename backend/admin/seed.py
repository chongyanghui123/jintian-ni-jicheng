"""初始化运营库：从小程序题库 src/data/questions.ts 同步 30 道内置题（状态 draft），
并写入 2 条演示举报数据。重复执行安全（表非空则跳过）。"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from database import get_conn, init_db  # noqa: E402

TS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       '..', '..', 'miniprogram', 'src', 'data', 'questions.ts')
LINE_RE = re.compile(
    r"id:\s*'([^']+)'.*?title:\s*'([^']+)'.*?optionA:\s*'([^']+)'.*?optionB:\s*'([^']+)'"
)


def main() -> None:
    init_db()
    conn = get_conn()
    count = conn.execute('SELECT COUNT(*) c FROM questions').fetchone()['c']
    if count > 0:
        print(f'questions 已有 {count} 条，跳过种子')
    else:
        with open(TS_PATH, encoding='utf-8') as f:
            content = f.read()
        items = LINE_RE.findall(content)
        for qid, title, oa, ob in items:
            conn.execute(
                'INSERT OR IGNORE INTO questions (id, title, optionA, optionB, status) '
                'VALUES (?,?,?,?,?)', (qid, title, oa, ob, 'draft'))
        conn.commit()
        print(f'已导入 {len(items)} 道内置题（draft，待排期）')

    rcount = conn.execute('SELECT COUNT(*) c FROM reports').fetchone()['c']
    if rcount == 0:
        conn.executemany(
            'INSERT INTO reports (target_id, reason, detail) VALUES (?,?,?)',
            [('q006', 'low_quality', '疑似引战题'),
             ('q011', 'inappropriate', '')])
        conn.commit()
        print('已写入 2 条演示举报')

    scount = conn.execute('SELECT COUNT(*) c FROM submissions').fetchone()['c']
    if scount == 0:
        conn.executemany(
            'INSERT INTO submissions (id, title, optionA, optionB, signature, status, source) '
            'VALUES (?,?,?,?,?,?,?)',
            [('sdemo1', '月底发了奖金，你会先还一张信用卡吗', '会，无债一身轻', '先存起来再说', '夜航员',
              'pending', 'miniprogram'),
             ('sdemo2', '朋友借了 50 块三个月没还，你会开口要吗', '会，亲兄弟明算账', '算了，50 块而已', '',
              'pending', 'miniprogram'),
             ('sdemo3', '加班到十点，你会先给家里打个电话吗', '会', '到家再说', '破晓',
              'approved', 'miniprogram')])
        conn.execute(
            "UPDATE submissions SET show_date=date('now','+3 day'), "
            "notify_text='你的投稿《加班到十点，你会先给家里打个电话…》已通过审核，将于 3 天后上墙，署名「破晓」' "
            "WHERE id='sdemo3'")
        conn.commit()
        print('已写入 3 条演示投稿（2 待审核 1 已通过）')

    ccount = conn.execute('SELECT COUNT(*) c FROM comments').fetchone()['c']
    if ccount == 0:
        conn.executemany(
            'INSERT INTO comments (id, question_id, option, content, hidden, report_count) '
            'VALUES (?,?,?,?,?,?)',
            [('cdemo1', 'q001', 'A', '先吃饭，饿着肚子谈什么都不诚实', 0, 0),
             ('cdemo2', 'q001', 'B', '事情压在心里会发酵，拖到最后更难开口', 0, 2),
             ('cdemo3', 'q004', 'A', '该说的还是要说，只是换个方式', 0, 0),
             ('cdemo4', 'q009', 'B', '有些沉默是善意，但也可能只是逃避', 1, 3)])
        conn.commit()
        print('已写入 4 条演示短评（1 条已被 3 次举报自动隐藏）')
    conn.close()


if __name__ == '__main__':
    main()
