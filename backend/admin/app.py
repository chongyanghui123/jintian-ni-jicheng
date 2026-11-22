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
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (Flask, Response, flash, redirect, render_template, request,
                   session, url_for)

from database import get_conn, init_db, next_question_id

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')


def _load_or_create_secret() -> str:
    """会话密钥固化：环境变量优先，否则落盘 .secret_key（重启后登录态不失效）。"""
    if os.environ.get('SECRET_KEY'):
        return os.environ['SECRET_KEY']
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.secret_key')
    try:
        with open(key_path, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
        if existing:
            return existing
    except OSError:
        pass
    secret = os.urandom(24).hex()
    with open(key_path, 'w', encoding='utf-8') as f:
        f.write(secret)
    return secret


# 登录防爆破：同一来源 IP 连续失败 5 次锁 5 分钟（进程内计数，重启清零）
_LOGIN_FAILS = {}  # ip -> [fails, locked_until_ts]
_LOCK_AFTER = 5
_LOCK_SECONDS = 300


def _login_locked(ip: str):
    fails, locked_until = _LOGIN_FAILS.get(ip, [0, 0.0])
    now_ts = datetime.now().timestamp()
    if locked_until and now_ts < locked_until:
        return True, int(locked_until - now_ts)
    return False, fails


def _login_record(ip: str, success: bool):
    if success:
        _LOGIN_FAILS.pop(ip, None)
        return
    fails, locked_until = _LOGIN_FAILS.get(ip, [0, 0.0])
    now_ts = datetime.now().timestamp()
    if locked_until and now_ts >= locked_until:
        fails = 0  # 锁定期结束重新计数
    fails += 1
    locked_until = now_ts + _LOCK_SECONDS if fails >= _LOCK_AFTER else 0.0
    _LOGIN_FAILS[ip] = [fails, locked_until]

REASON_LABELS = {
    'low_quality': '题目低质 / 引战',
    'inappropriate': '内容不适',
    'violation': '涉嫌违规',
    'other': '其他',
}


def today_str() -> str:
    return date.today().isoformat()


def _jsonable(v):
    """递归转 JSON 安全结构（sqlite3.Row / MultiDict / set / tuple 均可）。"""
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if hasattr(v, 'keys'):
        return {k: _jsonable(v[k]) for k in v.keys()}
    return v


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = _load_or_create_secret()
    init_db()
    app.jinja_env.filters['jsonable'] = _jsonable

    # 侧栏徽标：待审投稿数 / 未处理举报数（模板全局可用）
    @app.context_processor
    def inject_nav_badges():
        try:
            conn = get_conn()
            subs = conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='pending'").fetchone()['c']
            reports = conn.execute(
                "SELECT COUNT(*) c FROM reports WHERE status='open'").fetchone()['c']
            conn.close()
        except Exception:
            subs, reports = 0, 0
        return {'badge_subs': subs, 'badge_reports': reports}

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

    def rebuild_future_schedule(conn):
        """重排未来排期（一天一期）：
        - 投稿题（source=miniprogram）按审核通过时间 approved_at 顺序，占最前面的日期
        - 内置题按原相对顺序殿后
        - 已上墙（show_date <= 今天）的题不动（当天不变硬规则）
        返回 [(日期, 题目id), ...]"""
        today = today_str()
        # 投稿池：已通过审核的投稿题（未来已排期的 + 待排期草稿），按审核时间排序
        sub_ids = [r['id'] for r in conn.execute(
            "SELECT q.id FROM submissions s JOIN questions q ON q.id = s.question_id "
            "WHERE s.status='approved' AND (q.show_date > ? OR q.show_date IS NULL OR q.show_date='') "
            "ORDER BY COALESCE(s.approved_at, s.created_at), q.id", (today,)).fetchall()]
        # 内置池：未来已排期的内置题，按当前日期顺序保持不变
        builtin_ids = [r['id'] for r in conn.execute(
            "SELECT id FROM questions WHERE (source IS NULL OR source != 'miniprogram') "
            "AND status='published' AND show_date > ? ORDER BY show_date, id", (today,)).fetchall()]
        # 清空未来排期（退回草稿），再按优先级一天一天重排
        conn.execute("UPDATE questions SET show_date=NULL, status='draft' "
                     "WHERE status='published' AND show_date > ?", (today,))
        assignments = []
        d = date.today()
        for qid in sub_ids + builtin_ids:
            d += timedelta(days=1)
            conn.execute("UPDATE questions SET show_date=?, status='published' WHERE id=?",
                         (d.isoformat(), qid))
            assignments.append(f'{d.isoformat()}←{qid}')
        return assignments

    # ---------- 登录 ----------
    @app.route('/login', methods=['GET', 'POST'])
    def login():
        ip = request.remote_addr or 'unknown'
        if request.method == 'POST':
            locked, seconds = _login_locked(ip)
            if locked:
                flash(f'失败次数过多，请 {seconds} 秒后再试', 'error')
                return render_template('login.html')
            if request.form.get('password') == ADMIN_PASSWORD:
                _login_record(ip, True)
                session['user'] = 'admin'
                return redirect(url_for('dashboard'))
            _login_record(ip, False)
            left = _LOCK_AFTER - _login_locked(ip)[1]
            flash('密码错误' + (f'，再错 {left} 次将锁定 5 分钟' if left > 0 else ''), 'error')
        return render_template('login.html')

    @app.route('/logout')
    def logout():
        session.clear()
        return redirect(url_for('login'))

    # ---------- 看板 ----------
    # ---------- 奖品管理 ----------
    @app.route('/prizes')
    @login_required
    def prizes():
        conn = get_conn()
        rows = conn.execute(
            "SELECT p.*, (SELECT COUNT(*) FROM redeem_orders o WHERE o.prize_id=p.id "
            "AND o.status='done') AS order_count "
            'FROM prizes p ORDER BY p.cost, p.id').fetchall()
        conn.close()
        return render_template('prizes.html', rows=rows)

    def _parse_int(val, default, minimum):
        try:
            return max(minimum, int(str(val).strip() or default))
        except (ValueError, TypeError):
            return max(minimum, default)

    @app.route('/prizes/new', methods=['GET', 'POST'])
    @login_required
    def prize_new():
        if request.method == 'POST':
            name = request.form.get('name', '').strip()
            desc = request.form.get('desc', '').strip()
            cost = _parse_int(request.form.get('cost'), 0, 0)
            stock = _parse_int(request.form.get('stock'), 0, 0)
            limit_n = _parse_int(request.form.get('monthly_limit'), 1, 1)
            if not name:
                flash('奖品名称必填', 'error')
                return redirect(url_for('prize_new'))
            pid = 'p' + datetime.now().strftime('%Y%m%d%H%M%S')
            conn = get_conn()
            conn.execute(
                'INSERT INTO prizes (id, name, desc, cost, stock, monthly_limit) VALUES (?,?,?,?,?,?)',
                (pid, name, desc, cost, stock, limit_n))
            conn.commit()
            conn.close()
            flash(f'奖品已上架：{name}（{cost} 积分，库存 {stock}）', 'ok')
            return redirect(url_for('prizes'))
        return render_template('prize_form.html', row=None)

    @app.route('/prizes/<pid>/edit', methods=['GET', 'POST'])
    @login_required
    def prize_edit(pid):
        conn = get_conn()
        row = conn.execute('SELECT * FROM prizes WHERE id=?', (pid,)).fetchone()
        if not row:
            conn.close()
            flash('奖品不存在', 'error')
            return redirect(url_for('prizes'))
        if request.method == 'POST':
            name = request.form.get('name', '').strip()
            if not name:
                conn.close()
                flash('奖品名称必填', 'error')
                return redirect(url_for('prize_edit', pid=pid))
            conn.execute(
                'UPDATE prizes SET name=?, desc=?, cost=?, stock=?, monthly_limit=? WHERE id=?',
                (name, request.form.get('desc', '').strip(),
                 _parse_int(request.form.get('cost'), row['cost'], 0),
                 _parse_int(request.form.get('stock'), row['stock'], 0),
                 _parse_int(request.form.get('monthly_limit'), row['monthly_limit'], 1), pid))
            conn.commit()
            conn.close()
            flash(f'奖品已更新：{name}', 'ok')
            return redirect(url_for('prizes'))
        conn.close()
        return render_template('prize_form.html', row=row)

    @app.route('/prizes/<pid>/delete', methods=['POST'])
    @login_required
    def prize_delete(pid):
        conn = get_conn()
        n = conn.execute('SELECT COUNT(*) c FROM redeem_orders WHERE prize_id=?', (pid,)).fetchone()['c']
        if n:
            conn.close()
            flash(f'该奖品已有 {n} 笔兑换订单，不可删除（如需下架请把库存改为 0）', 'error')
            return redirect(url_for('prizes'))
        conn.execute('DELETE FROM prizes WHERE id=?', (pid,))
        conn.commit()
        conn.close()
        flash('奖品已删除', 'ok')
        return redirect(url_for('prizes'))

    # ---------- 兑换订单 ----------
    @app.route('/orders')
    @login_required
    def orders():
        uid = request.args.get('user', '').strip()
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 50
        conn = get_conn()
        where, params = (' WHERE user_id=?', [uid]) if uid else ('', [])
        total = conn.execute(
            'SELECT COUNT(*) c FROM redeem_orders' + where, params).fetchone()['c']
        rows = conn.execute(
            'SELECT * FROM redeem_orders' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?',
            params + [per, (page - 1) * per]).fetchall()
        pages = max(1, (total + per - 1) // per)
        balance = None
        ledger = []
        if uid:
            balance = conn.execute('SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=?',
                                   (uid,)).fetchone()['s']
            ledger = conn.execute(
                'SELECT * FROM points_ledger WHERE user_id=? ORDER BY id DESC LIMIT 20',
                (uid,)).fetchall()
        conn.close()
        return render_template('orders.html', rows=rows, uid=uid, page=page, pages=pages,
                               total=total, balance=balance, ledger=ledger)

    @app.route('/orders/<int:oid>/refund', methods=['POST'])
    @login_required
    def order_refund(oid):
        """撤销/退款订单（与 server.js 状态机一致）：
        - pending（占库存、积分未扣）：仅取消订单，释放库存名额，不动积分
        - done（积分已扣）：回补积分并写入 refund 流水
        库存为「status='done' 计数」口径，退款后名额自动释放，无需改 stock 字段。"""
        conn = get_conn()
        row = conn.execute('SELECT * FROM redeem_orders WHERE id=?', (oid,)).fetchone()
        if not row:
            conn.close()
            flash('订单不存在', 'error')
            return redirect(url_for('orders', user=row['user_id'] if row else ''))
        if row['status'] not in ('pending', 'done'):
            conn.close()
            flash('该订单已退款，不可重复操作', 'error')
            return redirect(url_for('orders'))
        uid = row['user_id']
        if row['status'] == 'done':
            conn.execute(
                'INSERT INTO points_ledger (user_id, type, amount, reason, order_no, created_at) '
                'VALUES (?,?,?,?,?,?)',
                (uid, 'refund', row['cost'], f'兑换退款：{row["prize_name"]}',
                 row['order_no'], datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
        conn.execute("UPDATE redeem_orders SET status='refunded' WHERE id=?", (oid,))
        conn.commit()
        conn.close()
        msg = f'订单 {row["order_no"]} 已退款'
        if row['status'] == 'done':
            msg += f'，已回补 {row["cost"]} 积分'
        else:
            msg += '（原为待处理订单，未扣积分，仅释放名额）'
        flash(msg, 'ok')
        return redirect(url_for('orders', user=uid) if uid else url_for('orders'))

    # ---------- 兑换订单 END ----------

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
        # 运营指标：业务时间戳均为 UTC ISO，按「北京零点对应的 UTC 时刻」划界（与 API 服务口径一致）
        bj_now = datetime.utcnow() + timedelta(hours=8)
        bj_start_utc = (bj_now.replace(hour=0, minute=0, second=0, microsecond=0)
                        - timedelta(hours=8)).strftime('%Y-%m-%dT%H:%M:%S')
        ops = {
            'votes_today': conn.execute(
                'SELECT COUNT(*) c FROM votes WHERE created_at>=?', (bj_start_utc,)).fetchone()['c'],
            'users_today': conn.execute(
                'SELECT COUNT(DISTINCT user_id) c FROM votes WHERE created_at>=?',
                (bj_start_utc,)).fetchone()['c'],
            'comments_today': conn.execute(
                'SELECT COUNT(*) c FROM comments WHERE created_at>=?',
                (bj_start_utc,)).fetchone()['c'],
            'subs_today': conn.execute(
                'SELECT COUNT(*) c FROM submissions WHERE created_at>=?',
                (bj_start_utc,)).fetchone()['c'],
            'users_total': conn.execute(
                'SELECT COUNT(DISTINCT user_id) c FROM votes').fetchone()['c'],
            'points_redeemed': conn.execute(
                "SELECT COALESCE(SUM(cost),0) s FROM redeem_orders WHERE status='done'").fetchone()['s'],
        }
        # 近 7 日参与趋势（北京日期倒序，今日在前；UTC 窗口 = 北京零点 - 8h）
        trend = []
        for i in range(7):
            day = (date.today() - timedelta(days=i)).isoformat()
            win_start = f'{day}T00:00:00'
            win_start_utc = (datetime.fromisoformat(win_start)
                             - timedelta(hours=8)).strftime('%Y-%m-%dT%H:%M:%S')
            win_end_utc = (datetime.fromisoformat(win_start)
                           + timedelta(days=1) - timedelta(hours=8)).strftime('%Y-%m-%dT%H:%M:%S')
            votes = conn.execute(
                'SELECT COUNT(*) c FROM votes WHERE created_at>=? AND created_at<?',
                (win_start_utc, win_end_utc)).fetchone()['c']
            users = conn.execute(
                'SELECT COUNT(DISTINCT user_id) c FROM votes WHERE created_at>=? AND created_at<?',
                (win_start_utc, win_end_utc)).fetchone()['c']
            trend.append({'date': day, 'votes': votes, 'users': users})
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
                               stats=stats, ops=ops, trend=trend, gaps=gaps)

    # ---------- 题库 ----------
    @app.route('/questions')
    @login_required
    def questions():
        tab = request.args.get('tab', 'all')
        kw = request.args.get('q', '').strip()
        try:
            page = max(1, int(request.args.get('page', '1')))
        except ValueError:
            page = 1
        today = today_str()
        where, params = [], []
        if tab == 'draft':
            where.append("status='draft'")
        elif tab == 'scheduled':
            where.append("status='published' AND show_date>?")
            params.append(today)
        elif tab == 'live':
            where.append("status='published' AND show_date<=?")
            params.append(today)
        if kw:
            where.append('(title LIKE ? OR id LIKE ? OR optionA LIKE ? OR optionB LIKE ?)')
            like = f'%{kw}%'
            params += [like, like, like, like]
        wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
        per = 20
        conn = get_conn()
        total = conn.execute('SELECT COUNT(*) c FROM questions' + wsql, params).fetchone()['c']
        rows = conn.execute('SELECT * FROM questions' + wsql + ' ORDER BY id LIMIT ? OFFSET ?',
                            params + [per, (page - 1) * per]).fetchall()
        conn.close()
        pages = max(1, (total + per - 1) // per)
        return render_template('questions.html', rows=rows, tab=tab, q=kw, page=page,
                               pages=pages, total=total,
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
        """重排未来排期：投稿按审核通过顺序优先，内置题殿后，一天一期。"""
        conn = get_conn()
        assignments = rebuild_future_schedule(conn)
        conn.commit()
        conn.close()
        head = '、'.join(assignments[:8]) + ('…' if len(assignments) > 8 else '')
        flash(f'已重排未来 {len(assignments)} 天（一天一期，投稿按审核顺序优先）：{head}',
              'ok' if assignments else 'error')
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
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 50
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
        total = conn.execute(
            'SELECT COUNT(*) c FROM submissions' + (' WHERE status=?' if params else ''),
            params).fetchone()['c']
        rows = conn.execute(sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
                            params + [per, (page - 1) * per]).fetchall()
        pages = max(1, (total + per - 1) // per)
        conn.close()
        return render_template('submissions.html', rows=rows, tab=tab, stats=stats,
                               page=page, pages=pages, total=total,
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
        """通过投稿：生成题目进入队列，自动按审核顺序排期（一天一期，投稿优先）。"""
        signature_ok = request.form.get('signature_ok') == '1'
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
        # 生成题目（先入队为草稿，来源标记用户投稿）
        qid = next_question_id(conn)
        conn.execute(
            "INSERT INTO questions (id, title, optionA, optionB, status, source) "
            "VALUES (?,?,?,?, 'draft', 'miniprogram')", (qid, title, oa, ob))
        conn.execute(
            "UPDATE submissions SET status='approved', question_id=?, "
            "approved_at=datetime('now','localtime'), signature=? WHERE id=?",
            (qid, signature, sid))
        # 立即重排：投稿按审核顺序占据最早的未来日期
        assignments = rebuild_future_schedule(conn)
        date_part = next((a.split('←')[0] for a in assignments if a.endswith('←' + qid)), '待排期')
        notify = (f'你的投稿《{title[:12]}…》已通过审核，将于 {date_part} 上墙'
                  + (f'，署名「{signature}」' if signature else '，将以「网友投稿」展示'))
        conn.execute("UPDATE submissions SET notify_text=? WHERE id=?", (notify, sid))
        conn.commit()
        conn.close()
        flash(f'已通过：生成题目 {qid}，自动排期 {date_part} 上墙（按审核顺序，一天一期）。'
              f'通知文案：{notify}', 'ok')
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

    @app.route('/submissions/<sid>/delete', methods=['POST'])
    @login_required
    def submission_delete(sid):
        """删除投稿：已通过的投稿连带删除其生成的草稿题；已上墙的先去题库下架。"""
        conn = get_conn()
        row = conn.execute('SELECT * FROM submissions WHERE id=?', (sid,)).fetchone()
        if not row:
            conn.close()
            flash('投稿不存在', 'error')
            return redirect(url_for('submissions'))
        if row['status'] == 'approved' and row['question_id']:
            q = conn.execute('SELECT * FROM questions WHERE id=?',
                             (row['question_id'],)).fetchone()
            if q and is_locked(q):
                conn.close()
                flash('该投稿生成的题目已上墙锁定，请先在题库下架后再删除投稿', 'error')
                return redirect(url_for('submissions'))
            if q and q['status'] == 'published':
                conn.close()
                flash('该投稿生成的题目已排期，请先在题库下架后再删除投稿', 'error')
                return redirect(url_for('submissions'))
            if q:
                conn.execute('DELETE FROM questions WHERE id=?', (row['question_id'],))
        conn.execute('DELETE FROM submissions WHERE id=?', (sid,))
        conn.commit()
        conn.close()
        flash('投稿已删除' + ('，连带删除其生成的草稿题' if row['status'] == 'approved' else ''), 'ok')
        return redirect(url_for('submissions'))

    # ---------- 短评管理（对应文档 8.1：机审即发 + 举报自动隐藏 + 日巡检） ----------
    @app.route('/comments')
    @login_required
    def comments():
        tab = request.args.get('tab', 'all')
        qid = request.args.get('qid', '').strip()
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 50
        conn = get_conn()
        sql, params = 'SELECT * FROM comments', []
        where = []
        if tab == 'hidden':
            where.append('hidden=1')
        elif tab == 'flagged':
            where.append('report_count>0 AND hidden=0')
        if qid:
            where.append('question_id=?')
            params.append(qid)
        wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
        total = conn.execute('SELECT COUNT(*) c FROM comments' + wsql, params).fetchone()['c']
        rows = conn.execute(sql + wsql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
                            params + [per, (page - 1) * per]).fetchall()
        pages = max(1, (total + per - 1) // per)
        conn.close()
        return render_template('comments.html', rows=rows, tab=tab, qid=qid,
                               page=page, pages=pages, total=total)

    @app.route('/comments/<cid>/delete', methods=['POST'])
    @login_required
    def comment_delete(cid):
        """彻底删除短评（隐藏不可见的违规内容用；可恢复的请用「隐藏」）。"""
        conn = get_conn()
        conn.execute('DELETE FROM comments WHERE id=?', (cid,))
        conn.commit()
        conn.close()
        flash('短评已删除', 'ok')
        return redirect(url_for('comments'))

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

    @app.route('/export-all')
    @login_required
    def export_all():
        """全库备份：所有表导出为单个 JSON 文件（运营数据兜底）。"""
        conn = get_conn()
        tables = {}
        for t in ('questions', 'submissions', 'comments', 'reports', 'votes',
                  'points_ledger', 'prizes', 'redeem_orders', 'ai_profiles'):
            tables[t] = [dict(r) for r in conn.execute(f'SELECT * FROM {t}').fetchall()]
        conn.close()
        payload = {
            'exported_at': datetime.now().isoformat(timespec='seconds'),
            'db': 'admin.db',
            'tables': tables,
        }
        fname = 'admin-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.json'
        return Response(
            json.dumps(payload, ensure_ascii=False, indent=2),
            mimetype='application/json',
            headers={'Content-Disposition': f'attachment; filename={fname}'})

    @app.route('/import-all', methods=['POST'])
    @login_required
    def import_all():
        """全库恢复：上传备份 JSON，整表覆盖写入（单事务，失败自动回滚）。"""
        if request.form.get('confirm') != '1':
            flash('请勾选「我确认要覆盖现有数据」后再执行恢复', 'error')
            return redirect(url_for('import_export'))
        f = request.files.get('file')
        if not f:
            flash('请选择全库备份 JSON 文件', 'error')
            return redirect(url_for('import_export'))
        try:
            data = json.loads(f.read().decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as e:
            flash(f'JSON 解析失败：{e}', 'error')
            return redirect(url_for('import_export'))
        tables = data.get('tables') if isinstance(data, dict) else None
        if not isinstance(tables, dict):
            flash('格式应为全库备份 JSON（含 tables 字段）', 'error')
            return redirect(url_for('import_export'))
        allowed = {'questions', 'submissions', 'comments', 'reports', 'votes',
                   'points_ledger', 'prizes', 'redeem_orders', 'ai_profiles'}
        conn = get_conn()
        restored = {}
        try:
            for t, rows in tables.items():
                if t not in allowed or not isinstance(rows, list):
                    continue
                conn.execute(f'DELETE FROM {t}')
                n = 0
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    cols = list(r.keys())
                    conn.execute(
                        f"INSERT OR REPLACE INTO {t} ({','.join(cols)}) "
                        f"VALUES ({','.join('?' for _ in cols)})",
                        [r[c] for c in cols])
                    n += 1
                restored[t] = n
            conn.commit()
        except Exception as e:  # 任意一表失败整体回滚，不留半恢复状态
            conn.rollback()
            conn.close()
            flash(f'恢复失败，已回滚（数据未变）：{e}', 'error')
            return redirect(url_for('import_export'))
        conn.close()
        detail = '、'.join(f'{t} {n} 条' for t, n in restored.items())
        flash(f'全库恢复完成：{detail}。请重启 API 服务使其重新读取数据。', 'ok')
        return redirect(url_for('import_export'))

    @app.route('/ai-cache/clear', methods=['POST'])
    @login_required
    def ai_cache_clear():
        """清空 AI 侧写缓存：下次用户访问将按当天重新生成文案。"""
        conn = get_conn()
        n = conn.execute('SELECT COUNT(*) c FROM ai_profiles').fetchone()['c']
        conn.execute('DELETE FROM ai_profiles')
        conn.commit()
        conn.close()
        flash(f'已清空 AI 侧写缓存 {n} 条，用户下次访问将重新生成当天文案', 'ok')
        return redirect(url_for('import_export'))

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
