"""今天你几成 · 运营后台（MVP）

后台只做四件事（对应产品文档 8.1/8.2 与 MVP 裁剪）：
题目排期、上下架、看当日数据、举报查看，外加批量导入导出（对接云上 questions 集合）。

硬规则：
- 「当天不变」：已上墙（published 且 show_date <= 今天）的题锁定，不可改期/改内容
- 不做超卖换出：published 题不可删除（云上 votes 已引用其 ID）
- 校验规则与小程序一致：题干 4-40 字，选项 1-16 字，两选项不能实质相同

运行：python3 seed.py && python3 app.py  （默认密码 admin123，生产环境务必设置 ADMIN_PASSWORD）
"""
import json
import os
from datetime import date, timedelta
from functools import wraps

from flask import (Flask, Response, flash, redirect, render_template, request,
                   session, url_for)

from database import get_conn, init_db, next_question_id

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')

REASON_LABELS = {
    'low_quality': '题目低质 / 引战',
    'inappropriate': '内容不适',
    'violation': '涉嫌违规',
    'other': '其他',
}


def today_str() -> str:
    return date.today().isoformat()


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = os.environ.get('SECRET_KEY') or os.urandom(24).hex()
    init_db()

    def login_required(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not session.get('user'):
                return redirect(url_for('login'))
            return view(*args, **kwargs)
        return wrapped

    # ---------- 校验（与小程序云函数同口径） ----------
    def validate_question(title: str, option_a: str, option_b: str):
        errors = []
        title, option_a, option_b = title.strip(), option_a.strip(), option_b.strip()
        if not (4 <= len(title) <= 40):
            errors.append('题干需 4~40 字')
        if not (1 <= len(option_a) <= 16):
            errors.append('选项 A 需 1~16 字')
        if not (1 <= len(option_b) <= 16):
            errors.append('选项 B 需 1~16 字')
        if option_a == option_b:
            errors.append('两个选项不能实质相同')
        return errors, title, option_a, option_b

    def is_locked(row) -> bool:
        """已上墙的题锁定：published 且 show_date <= 今天（当天不变硬规则）。"""
        return row['status'] == 'published' and bool(row['show_date']) \
            and row['show_date'] <= today_str()

    # ---------- 登录 ----------
    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if request.method == 'POST':
            if request.form.get('password') == ADMIN_PASSWORD:
                session['user'] = 'admin'
                return redirect(url_for('dashboard'))
            flash('密码错误', 'error')
        return render_template('login.html')

    @app.route('/logout')
    def logout():
        session.clear()
        return redirect(url_for('login'))

    # ---------- 看板 ----------
    @app.route('/')
    @login_required
    def dashboard():
        conn = get_conn()
        today = today_str()
        today_q = conn.execute(
            "SELECT * FROM questions WHERE show_date=? AND status='published'", (today,)
        ).fetchone()
        stats = {
            'total': conn.execute('SELECT COUNT(*) c FROM questions').fetchone()['c'],
            'draft': conn.execute(
                "SELECT COUNT(*) c FROM questions WHERE status='draft'").fetchone()['c'],
            'live': conn.execute(
                "SELECT COUNT(*) c FROM questions WHERE status='published' AND show_date<=?",
                (today,)).fetchone()['c'],
            'open_reports': conn.execute(
                "SELECT COUNT(*) c FROM reports WHERE status='open'").fetchone()['c'],
            'pending_subs': conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='pending'").fetchone()['c'],
            'hidden_comments': conn.execute(
                'SELECT COUNT(*) c FROM comments WHERE hidden=1').fetchone()['c'],
        }
        # 未来 7 天排期缺口
        gaps = []
        for i in range(1, 8):
            d = (date.today() + timedelta(days=i)).isoformat()
            hit = conn.execute(
                "SELECT 1 FROM questions WHERE show_date=? AND status='published'", (d,)
            ).fetchone()
            if not hit:
                gaps.append(d)
        conn.close()
        return render_template('dashboard.html', today=today, today_q=today_q,
                               stats=stats, gaps=gaps)

    # ---------- 题库 ----------
    @app.route('/questions')
    @login_required
    def questions():
        tab = request.args.get('tab', 'all')
        today = today_str()
        sql, params = 'SELECT * FROM questions', []
        if tab == 'draft':
            sql += " WHERE status='draft'"
        elif tab == 'scheduled':
            sql += " WHERE status='published' AND show_date>?"
            params = [today]
        elif tab == 'live':
            sql += " WHERE status='published' AND show_date<=?"
            params = [today]
        sql += ' ORDER BY id'
        conn = get_conn()
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        return render_template('questions.html', rows=rows, tab=tab,
                               today=today, locked_ids={
                                   r['id'] for r in rows if is_locked(r)})

    @app.route('/questions/new', methods=['GET', 'POST'])
    @login_required
    def question_new():
        if request.method == 'POST':
            errors, title, oa, ob = validate_question(
                request.form.get('title', ''), request.form.get('optionA', ''),
                request.form.get('optionB', ''))
            show_date = request.form.get('show_date', '').strip()
            if show_date and show_date < today_str():
                errors.append('排期日期不能是过去')
            if errors:
                for e in errors:
                    flash(e, 'error')
                return render_template('question_form.html', q=None,
                                       form=request.form)
            conn = get_conn()
            qid = next_question_id(conn)
            conn.execute(
                'INSERT INTO questions (id, title, optionA, optionB, show_date, status) '
                'VALUES (?,?,?,?,?,?)',
                (qid, title, oa, ob, show_date or None,
                 'published' if show_date else 'draft'))
            conn.commit()
            conn.close()
            flash(f'已创建 {qid}', 'ok')
            return redirect(url_for('questions'))
        return render_template('question_form.html', q=None, form={})

    @app.route('/questions/<qid>/edit', methods=['GET', 'POST'])
    @login_required
    def question_edit(qid):
        conn = get_conn()
        row = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
        if not row:
            conn.close()
            flash('题目不存在', 'error')
            return redirect(url_for('questions'))
        if request.method == 'POST':
            if is_locked(row):
                conn.close()
                flash('这道题已上墙（当天不变硬规则），不能修改', 'error')
                return redirect(url_for('questions'))
            errors, title, oa, ob = validate_question(
                request.form.get('title', ''), request.form.get('optionA', ''),
                request.form.get('optionB', ''))
            if errors:
                conn.close()
                for e in errors:
                    flash(e, 'error')
                return render_template('question_form.html', q=row,
                                       form=dict(request.form), locked=False)
            conn.execute(
                "UPDATE questions SET title=?, optionA=?, optionB=?, "
                "updated_at=datetime('now','localtime') WHERE id=?",
                (title, oa, ob, qid))
            conn.commit()
            conn.close()
            flash(f'{qid} 已保存', 'ok')
            return redirect(url_for('questions'))
        conn.close()
        return render_template('question_form.html', q=row, form=dict(row),
                               locked=is_locked(row))

    @app.route('/questions/<qid>/delete', methods=['POST'])
    @login_required
    def question_delete(qid):
        conn = get_conn()
        row = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
        if not row:
            flash('题目不存在', 'error')
        elif row['status'] == 'published':
            flash('已上架的题不能删除（云上投票已引用），请改为下架', 'error')
        else:
            conn.execute('DELETE FROM questions WHERE id=?', (qid,))
            conn.commit()
            flash(f'{qid} 已删除', 'ok')
        conn.close()
        return redirect(url_for('questions'))

    @app.route('/questions/<qid>/status', methods=['POST'])
    @login_required
    def question_status(qid):
        conn = get_conn()
        row = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
        if not row:
            flash('题目不存在', 'error')
        elif is_locked(row):
            flash('这道题已上墙，不能操作', 'error')
        elif row['status'] == 'published':
            conn.execute("UPDATE questions SET status='draft' WHERE id=?", (qid,))
            flash(f'{qid} 已下架（草稿）', 'ok')
        else:
            if not row['show_date']:
                flash('上架前请先在编辑页设置排期日期', 'error')
            elif row['show_date'] < today_str():
                flash('排期日期已过期，不能上架', 'error')
            else:
                conn.execute("UPDATE questions SET status='published' WHERE id=?", (qid,))
                flash(f'{qid} 已上架，{row["show_date"]} 上墙', 'ok')
        conn.commit()
        conn.close()
        return redirect(url_for('questions'))

    # ---------- 排期 ----------
    @app.route('/schedule')
    @login_required
    def schedule():
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM questions WHERE show_date IS NOT NULL AND show_date>=? "
            "AND status='published' ORDER BY show_date LIMIT 30", (today_str(),)
        ).fetchall()
        conn.close()
        by_date = {r['show_date']: r for r in rows}
        days = []
        for i in range(30):
            d = (date.today() + timedelta(days=i)).isoformat()
            days.append({'date': d, 'q': by_date.get(d)})
        return render_template('schedule.html', days=days, today=today_str())

    @app.route('/schedule/fill', methods=['POST'])
    @login_required
    def schedule_fill():
        try:
            days = min(90, max(1, int(request.form.get('days', '7'))))
        except ValueError:
            days = 7
        start = request.form.get('start', '').strip()
        try:
            start_d = date.fromisoformat(start) if start else date.today() + timedelta(days=1)
        except ValueError:
            start_d = date.today() + timedelta(days=1)
        if start_d < date.today():
            flash('起始日期不能是过去（当天不变硬规则）', 'error')
            return redirect(url_for('schedule'))

        conn = get_conn()
        drafts = conn.execute(
            "SELECT id FROM questions WHERE (show_date IS NULL OR show_date='') "
            "AND status='draft' ORDER BY id").fetchall()
        pool = [r['id'] for r in drafts]
        filled = []
        for i in range(days):
            if not pool:
                break
            d = (start_d + timedelta(days=i)).isoformat()
            hit = conn.execute(
                "SELECT 1 FROM questions WHERE show_date=? AND status='published'",
                (d,)).fetchone()
            if hit:
                continue  # 空档才填，不动已有排期
            qid = pool.pop(0)
            conn.execute("UPDATE questions SET show_date=?, status='published' WHERE id=?",
                         (d, qid))
            filled.append(f'{d} ← {qid}')
        conn.commit()
        conn.close()
        flash(f'已排期 {len(filled)} 天：' + ('、'.join(filled) if filled else '没有可排的草稿题'),
              'ok' if filled else 'error')
        return redirect(url_for('schedule'))

    # ---------- 举报 ----------
    @app.route('/reports')
    @login_required
    def reports():
        conn = get_conn()
        rows = conn.execute('SELECT * FROM reports ORDER BY id DESC LIMIT 100').fetchall()
        conn.close()
        return render_template('reports.html', rows=rows, reason_labels=REASON_LABELS)

    @app.route('/reports/<int:rid>/close', methods=['POST'])
    @login_required
    def report_close(rid):
        conn = get_conn()
        conn.execute("UPDATE reports SET status='closed' WHERE id=?", (rid,))
        conn.commit()
        conn.close()
        flash(f'举报 #{rid} 已标记处理', 'ok')
        return redirect(url_for('reports'))

    # ---------- 投稿审核（对应文档 4.2/8.1） ----------
    @app.route('/submissions')
    @login_required
    def submissions():
        tab = request.args.get('tab', 'pending')
        conn = get_conn()
        stats = {
            'pending': conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='pending'").fetchone()['c'],
            'approved': conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='approved'").fetchone()['c'],
            'rejected': conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='rejected'").fetchone()['c'],
        }
        sql, params = 'SELECT * FROM submissions', []
        if tab in ('pending', 'approved', 'rejected'):
            sql += ' WHERE status=?'
            params = [tab]
        sql += ' ORDER BY created_at DESC'
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        return render_template('submissions.html', rows=rows, tab=tab, stats=stats,
                               tomorrow=(date.today() + timedelta(days=1)).isoformat(),
                               today=today_str())

    @app.route('/submissions/import', methods=['POST'])
    @login_required
    def submissions_import():
        """从小程序"复制 JSON 给运营"粘贴导入（或上传 JSON 文件）。"""
        raw = ''
        if request.files.get('file'):
            raw = request.files['file'].read().decode('utf-8', 'ignore')
        else:
            raw = request.form.get('payload', '')
        raw = raw.strip()
        if not raw:
            flash('请粘贴投稿 JSON 或选择文件', 'error')
            return redirect(url_for('submissions'))
        try:
            data = json.loads(raw)
        except ValueError as e:
            flash(f'JSON 解析失败：{e}', 'error')
            return redirect(url_for('submissions'))
        if not isinstance(data, list):
            data = [data]
        conn = get_conn()
        ok, skipped = 0, 0
        for item in data:
            if not isinstance(item, dict) or not item.get('title'):
                skipped += 1
                continue
            sid = str(item.get('id') or f's{ok}{len(str(item))}')
            existing = conn.execute('SELECT 1 FROM submissions WHERE id=?', (sid,)).fetchone()
            if existing:
                skipped += 1
                continue
            conn.execute(
                'INSERT INTO submissions (id, title, optionA, optionB, signature, status, source) '
                'VALUES (?,?,?,?,?,?,?)',
                (sid, str(item.get('title', '')), str(item.get('optionA', '')),
                 str(item.get('optionB', '')), str(item.get('signature', '')),
                 'pending', 'miniprogram'))
            ok += 1
        conn.commit()
        conn.close()
        flash(f'导入投稿 {ok} 条，跳过重复/无效 {skipped} 条，全部进入待审核', 'ok')
        return redirect(url_for('submissions'))

    @app.route('/submissions/<sid>/approve', methods=['POST'])
    @login_required
    def submission_approve(sid):
        show_date = request.form.get('show_date', '').strip()
        signature_ok = request.form.get('signature_ok') == '1'
        if not show_date:
            flash('通过必须填写上墙时间', 'error')
            return redirect(url_for('submissions'))
        if show_date <= today_str():
            # 硬规则：00:00 冻结当日题，投稿一律进次日起的题池
            flash('上墙时间必须晚于今天（当日投稿一律次日起，00:00 冻结硬规则）', 'error')
            return redirect(url_for('submissions'))
        conn = get_conn()
        row = conn.execute('SELECT * FROM submissions WHERE id=?', (sid,)).fetchone()
        if not row or row['status'] != 'pending':
            conn.close()
            flash('投稿不存在或已处理', 'error')
            return redirect(url_for('submissions'))
        errors, title, oa, ob = validate_question(row['title'], row['optionA'], row['optionB'])
        if errors:
            conn.close()
            flash('校验未通过：' + '；'.join(errors), 'error')
            return redirect(url_for('submissions'))
        signature = row['signature'] if signature_ok else ''
        # 生成题目（进入题池，状态 published 排期上墙）
        qid = next_question_id(conn)
        conn.execute(
            'INSERT INTO questions (id, title, optionA, optionB, show_date, status) '
            'VALUES (?,?,?,?,?,?)', (qid, title, oa, ob, show_date, 'published'))
        # 通知文案（订阅消息用，不承诺"每条都通知"）
        notify = (f'你的投稿《{title[:12]}…》已通过审核，将于 {show_date} 上墙'
                  + (f'，署名「{signature}」' if signature else '，将以「网友投稿」展示'))
        conn.execute(
            "UPDATE submissions SET status='approved', show_date=?, signature=?, "
            "notify_text=? WHERE id=?", (show_date, signature, notify, sid))
        conn.commit()
        conn.close()
        flash(f'已通过：生成题目 {qid}，{show_date} 上墙。通知文案：{notify}', 'ok')
        return redirect(url_for('submissions'))

    @app.route('/submissions/<sid>/reject', methods=['POST'])
    @login_required
    def submission_reject(sid):
        reason = request.form.get('reason', '').strip()
        if not reason:
            flash('驳回必须写明具体原因（对应文档 8.1：不能只写"不符合规范"）', 'error')
            return redirect(url_for('submissions'))
        if reason == '不符合规范':
            flash('驳回原因不能只写"不符合规范"，请写具体可修改的建议', 'error')
            return redirect(url_for('submissions'))
        conn = get_conn()
        conn.execute(
            "UPDATE submissions SET status='rejected', reject_reason=? WHERE id=? "
            "AND status='pending'", (reason, sid))
        conn.commit()
        conn.close()
        flash('已驳回，用户将看到你写的具体原因', 'ok')
        return redirect(url_for('submissions'))

    # ---------- 短评管理（对应文档 8.1：机审即发 + 举报自动隐藏 + 日巡检） ----------
    @app.route('/comments')
    @login_required
    def comments():
        tab = request.args.get('tab', 'all')
        conn = get_conn()
        sql, params = 'SELECT * FROM comments', []
        if tab == 'hidden':
            sql += ' WHERE hidden=1'
        elif tab == 'flagged':
            sql += ' WHERE report_count>0 AND hidden=0'
        sql += ' ORDER BY created_at DESC LIMIT 200'
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        return render_template('comments.html', rows=rows, tab=tab)

    @app.route('/comments/<cid>/hide', methods=['POST'])
    @login_required
    def comment_hide(cid):
        conn = get_conn()
        conn.execute('UPDATE comments SET hidden=1 WHERE id=?', (cid,))
        conn.commit()
        conn.close()
        flash('短评已隐藏', 'ok')
        return redirect(url_for('comments'))

    @app.route('/comments/<cid>/restore', methods=['POST'])
    @login_required
    def comment_restore(cid):
        conn = get_conn()
        conn.execute('UPDATE comments SET hidden=0 WHERE id=?', (cid,))
        conn.commit()
        conn.close()
        flash('短评已恢复展示', 'ok')
        return redirect(url_for('comments'))

    # ---------- 导入导出 ----------
    @app.route('/import-export')
    @login_required
    def import_export():
        return render_template('import_export.html')

    @app.route('/export')
    @login_required
    def export():
        conn = get_conn()
        rows = conn.execute('SELECT * FROM questions ORDER BY show_date, id').fetchall()
        conn.close()
        data = [{
            'id': r['id'], 'title': r['title'], 'optionA': r['optionA'],
            'optionB': r['optionB'], 'showDate': r['show_date'],
            'status': r['status']
        } for r in rows]
        return Response(
            json.dumps(data, ensure_ascii=False, indent=2),
            mimetype='application/json',
            headers={'Content-Disposition': 'attachment; filename=questions-export.json'})

    @app.route('/import', methods=['POST'])
    @login_required
    def import_questions():
        f = request.files.get('file')
        if not f:
            flash('请选择 JSON 文件', 'error')
            return redirect(url_for('import_export'))
        try:
            data = json.loads(f.read().decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as e:
            flash(f'JSON 解析失败：{e}', 'error')
            return redirect(url_for('import_export'))
        if isinstance(data, dict):
            data = data.get('questions') or data.get('data') or []
        if not isinstance(data, list):
            flash('格式应为题目数组（或含 questions 字段的对象）', 'error')
            return redirect(url_for('import_export'))

        conn = get_conn()
        ok, skipped, locked = 0, 0, 0
        for item in data:
            if not isinstance(item, dict):
                skipped += 1
                continue
            errors, title, oa, ob = validate_question(
                str(item.get('title', '')), str(item.get('optionA', '')),
                str(item.get('optionB', '')))
            if errors:
                skipped += 1
                continue
            qid = str(item.get('id') or next_question_id(conn))
            show_date = item.get('showDate') or None
            status = item.get('status') if item.get('status') in ('draft', 'published') else 'draft'
            existing = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
            if existing:
                if is_locked(existing):
                    locked += 1
                    continue
                conn.execute(
                    "UPDATE questions SET title=?, optionA=?, optionB=?, show_date=?, "
                    "status=?, updated_at=datetime('now','localtime') WHERE id=?",
                    (title, oa, ob, show_date, status, qid))
            else:
                conn.execute(
                    'INSERT INTO questions (id, title, optionA, optionB, show_date, status) '
                    'VALUES (?,?,?,?,?,?)', (qid, title, oa, ob, show_date, status))
            ok += 1
        conn.commit()
        conn.close()
        msg = f'导入完成：更新/新增 {ok} 条，跳过 {skipped} 条'
        if locked:
            msg += f'，保护已上墙 {locked} 条（未改动）'
        flash(msg, 'ok')
        return redirect(url_for('questions'))

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=5050, debug=False)
