"""今天你几成 · 运营后台（MVP）

后台只做四件事（对应产品文档 8.1/8.2 与 MVP 裁剪）：
题目排期、上下架、看当日数据、举报查看，外加批量导入导出（对接云上 questions 集合）。

硬规则：
- 「当天不变」：已上墙（published 且 show_date <= 今天）的题锁定，不可改期/改内容
- 不做超卖换出：published 题不可删除（云上 votes 已引用其 ID）
- 校验规则与小程序一致：题干 4-40 字，选项 1-16 字，两选项不能实质相同

运行：python3 seed.py && python3 app.py  （首次启动自动生成初始密码，写入 initial_password.txt，登录后可在后台修改）
"""
import json
import os
import secrets
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (Flask, Response, flash, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from database import get_conn, init_db, next_question_id

# ---------- 管理密码 ----------
# 密码不写死在代码/服务配置里：哈希存数据库 settings 表，后台「修改密码」页自助修改。
# 首次启动若库内没有哈希，则用环境变量 ADMIN_PASSWORD 引导一次；未设置则生成随机密码并写入
# initial_password.txt（权限 600），登录后在后台改掉即可。
PASSWORD_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'initial_password.txt')


def _get_password_hash() -> str:
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key='admin_password_hash'").fetchone()
    conn.close()
    return row['value'] if row else ''


def _set_password_hash(password: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('admin_password_hash', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (generate_password_hash(password),))
    conn.commit()
    conn.close()


def _verify_password(password: str) -> bool:
    stored = _get_password_hash()
    if stored:
        return check_password_hash(stored, password)
    env_pwd = os.environ.get('ADMIN_PASSWORD')
    return bool(env_pwd) and password == env_pwd


def _bootstrap_password() -> None:
    """首次启动初始化密码：环境变量优先，否则生成随机密码落到 initial_password.txt。"""
    if _get_password_hash():
        return
    env_pwd = os.environ.get('ADMIN_PASSWORD')
    initial = env_pwd or secrets.token_urlsafe(9)
    _set_password_hash(initial)
    if not env_pwd:
        with open(PASSWORD_FILE, 'w', encoding='utf-8') as f:
            f.write(initial + '\n')
        os.chmod(PASSWORD_FILE, 0o600)
        print(f'[admin] 已生成初始管理密码，见 {PASSWORD_FILE}', flush=True)

# 用户头像目录（Node API 服务写入，与后台共享磁盘）
UPLOADS_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api', 'uploads'))


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
    _bootstrap_password()
    app.jinja_env.filters['jsonable'] = _jsonable

    # 侧栏徽标：待审投稿数 / 未处理举报数 / 待处理意见反馈数（模板全局可用）
    @app.context_processor
    def inject_nav_badges():
        try:
            conn = get_conn()
            subs = conn.execute(
                "SELECT COUNT(*) c FROM submissions WHERE status='pending'").fetchone()['c']
            reports = conn.execute(
                "SELECT COUNT(*) c FROM reports WHERE status='open'").fetchone()['c']
            feeds = conn.execute(
                "SELECT COUNT(*) c FROM feedback WHERE status='pending'").fetchone()['c']
            conn.close()
        except Exception:
            subs, reports, feeds = 0, 0, 0
        return {'badge_subs': subs, 'badge_reports': reports, 'badge_feedback': feeds}

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
        # 回写投稿记录：同步题目当前上墙日期，并刷新通知文案（重排后日期可能变化）
        rows = conn.execute(
            "SELECT s.id, s.title, s.signature, q.show_date FROM submissions s "
            "JOIN questions q ON q.id = s.question_id WHERE s.status='approved'").fetchall()
        for r in rows:
            if not r['show_date']:
                continue
            notice = (f'你的投稿《{r["title"][:12]}…》已通过审核，将于 {r["show_date"]} 上墙'
                      + (f'，署名「{r["signature"]}」' if r['signature'] else '，将以「网友投稿」展示'))
            conn.execute("UPDATE submissions SET show_date=?, notify_text=? WHERE id=?",
                         (r['show_date'], notice, r['id']))
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
            if _verify_password(request.form.get('password') or ''):
                _login_record(ip, True)
                session['user'] = 'admin'
                return redirect(url_for('dashboard'))
            _login_record(ip, False)
            left = _LOCK_AFTER - _login_locked(ip)[1]
            flash('密码错误' + (f'，再错 {left} 次将锁定 5 分钟' if left > 0 else ''), 'error')
        return render_template('login.html')

    @app.route('/password', methods=['GET', 'POST'])
    @login_required
    def change_password():
        if request.method == 'POST':
            old = request.form.get('old_password') or ''
            new = request.form.get('new_password') or ''
            confirm = request.form.get('confirm_password') or ''
            if not _verify_password(old):
                flash('当前密码不正确', 'error')
            elif len(new) < 8:
                flash('新密码至少 8 位', 'error')
            elif new != confirm:
                flash('两次输入的新密码不一致', 'error')
            elif new == old:
                flash('新密码不能与当前密码相同', 'error')
            else:
                _set_password_hash(new)
                # 改过密码后删掉引导文件里的明文
                if os.path.exists(PASSWORD_FILE):
                    os.remove(PASSWORD_FILE)
                flash('密码已更新，下次登录请使用新密码', 'ok')
                return redirect(url_for('change_password'))
        return render_template('password.html')

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

    def _clean_image(val):
        """奖品图片只接受本服务上传的 /uploads/prizes/ 相对路径，其他一律清空。"""
        v = (val or '').strip()
        if not v:
            return ''
        return v if (v.startswith('/uploads/prizes/') and '..' not in v) else ''

    @app.route('/prizes/upload-image', methods=['POST'])
    @login_required
    def prize_upload_image():
        """奖品图片上传：multipart 文件，落盘 backend/api/uploads/prizes/，返回相对路径给表单保存。"""
        f = request.files.get('file')
        if not f or not f.filename:
            return jsonify({'ok': False, 'message': '请选择图片'}), 400
        ext = os.path.splitext(f.filename)[1].lower().lstrip('.')
        if ext == 'jpeg':
            ext = 'jpg'
        if ext not in ('jpg', 'png', 'webp'):
            return jsonify({'ok': False, 'message': '只支持 jpg / png / webp'}), 400
        blob = f.read()
        if not blob or len(blob) > 2 * 1024 * 1024:
            return jsonify({'ok': False, 'message': '图片需小于 2MB'}), 400
        prize_dir = os.path.join(UPLOADS_DIR, 'prizes')
        os.makedirs(prize_dir, exist_ok=True)
        fname = 'pz_' + datetime.now().strftime('%Y%m%d%H%M%S') + '_' + secrets.token_hex(4) + '.' + ext
        with open(os.path.join(prize_dir, fname), 'wb') as fh:
            fh.write(blob)
        return jsonify({'ok': True, 'url': '/uploads/prizes/' + fname})

    @app.route('/prize-image/<filename>')
    @login_required
    def prize_image(filename):
        """后台预览奖品图片（与 Node API 共享 uploads 目录）。"""
        return send_from_directory(os.path.join(UPLOADS_DIR, 'prizes'), filename)

    @app.route('/prizes/new', methods=['GET', 'POST'])
    @login_required
    def prize_new():
        if request.method == 'POST':
            name = request.form.get('name', '').strip()
            desc = request.form.get('desc', '').strip()
            image = _clean_image(request.form.get('image'))
            cost = _parse_int(request.form.get('cost'), 0, 0)
            stock = _parse_int(request.form.get('stock'), 0, 0)
            limit_n = _parse_int(request.form.get('monthly_limit'), 1, 1)
            if not name:
                flash('奖品名称必填', 'error')
                return redirect(url_for('prize_new'))
            pid = 'p' + datetime.now().strftime('%Y%m%d%H%M%S')
            conn = get_conn()
            conn.execute(
                'INSERT INTO prizes (id, name, desc, image, cost, stock, monthly_limit) VALUES (?,?,?,?,?,?,?)',
                (pid, name, desc, image, cost, stock, limit_n))
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
                'UPDATE prizes SET name=?, desc=?, image=?, cost=?, stock=?, monthly_limit=? WHERE id=?',
                (name, request.form.get('desc', '').strip(),
                 _clean_image(request.form.get('image')),
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

    # ---------- 积分规则（小程序积分发放数值，动态配置） ----------
    # 答题不再直接发积分（积分只通过转盘获得），这两项默认 0；保留开关以备应急
    POINTS_RULE_DEFAULTS = {'points_answer': 0, 'points_streak7': 0, 'points_daily_cap': 60}
    POINTS_RULE_META = {
        'points_answer': ('每日答题得分', 0, 1000),
        'points_streak7': ('连答 7 天奖励', 0, 1000),
        'points_daily_cap': ('单日获取上限', 0, 100000),
    }

    def _read_points_rules(conn) -> dict:
        values = dict(POINTS_RULE_DEFAULTS)
        rows = conn.execute(
            "SELECT key, value FROM settings "
            "WHERE key IN ('points_answer','points_streak7','points_daily_cap')").fetchall()
        for r in rows:
            try:
                n = int(r['value'])
            except (TypeError, ValueError):
                continue
            _, lo, hi = POINTS_RULE_META[r['key']]
            values[r['key']] = min(hi, max(lo, n))
        return values

    @app.route('/points-rules', methods=['GET', 'POST'])
    @login_required
    def points_rules():
        """积分规则：小程序答题/连答奖励与单日上限，改完立刻对新发放生效。"""
        if request.method == 'POST':
            updates = {}
            for key, (label, lo, hi) in POINTS_RULE_META.items():
                try:
                    n = int(str(request.form.get(key, '')).strip())
                except (TypeError, ValueError):
                    flash(f'「{label}」请填整数', 'error')
                    return redirect(url_for('points_rules'))
                if not (lo <= n <= hi):
                    flash(f'「{label}」需在 {lo}~{hi} 之间', 'error')
                    return redirect(url_for('points_rules'))
                updates[key] = n
            conn = get_conn()
            for key, n in updates.items():
                conn.execute(
                    'INSERT INTO settings(key, value) VALUES(?,?) '
                    'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(n)))
            conn.commit()
            conn.close()
            flash('积分规则已保存，新发放立即生效（历史流水不变）', 'ok')
            return redirect(url_for('points_rules'))
        conn = get_conn()
        values = _read_points_rules(conn)
        conn.close()
        return render_template('points_rules.html', values=values, meta=POINTS_RULE_META)

    # ---------- 运营设置（小程序全部可配参数） ----------
    OPERATIONS_GROUPS = [
        ('active', '活动与内容', [
            ('submit_daily_limit', '投稿每日上限（道）', 'int', 0, 100, 3, '0 表示不限制'),
            ('feedback_daily_limit', '反馈每日上限（条）', 'int', 0, 100, 3, '0 表示不限制'),
            ('weekly_unlock_streak', '周报解锁连答天数', 'int', 1, 100, 7, '连答达到该天数解锁 AI 周报'),
            ('lookback_draw_per_day', '回看券每日抽题次数', 'int', 1, 20, 1, '持券用户每天可回看的题数'),
            ('lookback_ticket_days', '回看券有效天数', 'int', 1, 3650, 30, '兑换后超过该天数自动失效'),
            ('minority_min_samples', '少数派最少样本数', 'int', 0, 100000, 30, '样本不足不统计少数派'),
            ('minority_ratio_pct', '少数派占比上限（%）', 'int', 0, 100, 40, '我的选项占比不超过该值算少数派'),
            ('report_hide_threshold', '举报自动隐藏阈值', 'int', 0, 100, 3, '同一短评被举报达到次数后自动隐藏；0 关闭'),
        ]),
        ('points', '积分与转盘', [
            ('points_valid_days', '积分有效天数', 'int', 1, 3650, 365, '超过该天数的积分自动失效'),
            ('points_expire_tip_days', '过期提醒提前天数', 'int', 1, 3650, 90, '积分页提示「N 天内过期」'),
            ('skin_valid_days', '限定皮肤有效天数', 'int', 1, 3650, 30, '兑换皮肤后的有效期'),
            ('draw_per_answer', '每日答题送抽奖次数', 'int', 0, 100, 1, '答完当天题目发放'),
            ('draw_streak7_bonus', '连答 7 天额外次数', 'int', 0, 100, 3, '每满 7 天连答额外发放'),
            ('draw_daily_cap', '单日抽奖次数上限', 'int', 0, 1000, 3, '当天累计获得抽奖次数上限'),
        ]),
        ('ai', 'AI 与分享图', [
            ('ai_profile_length', 'AI 点评字数', 'int', 20, 120, 50, 'AI 侧写的目标字数'),
            ('share_image_interval_min', '分享图巡检间隔（分钟）', 'int', 1, 1440, 15, '后台预生成每日分享图的间隔'),
        ]),
    ]
    OPERATIONS_BOOLS = [
        ('share_image_enabled', '启用每日 AI 分享图', True),
        ('announcement_enabled', '启用首页公告', False),
        ('module_submit', '开放「投稿题目」', True),
        ('module_feedback', '开放「意见反馈」', True),
        ('module_weekly', '开放「AI 周报」', True),
        ('module_prizes', '开放「积分兑换」', True),
        ('module_relook', '开放「往期回看券」', True),
        ('module_wheel', '开放「转盘抽奖」', True),
    ]
    OPERATIONS_TEXTS = [
        ('announcement_text', '公告内容', 200),
        ('ai_profile_style', 'AI 点评额外风格要求', 200),
        ('about_updated_at', '关于页更新日期', 40),
        ('about_intro', '关于页开篇介绍', 400),
        ('about_footer', '关于页页脚', 100),
    ]

    def _read_operations(conn) -> dict:
        values = {}
        for _, _, items in OPERATIONS_GROUPS:
            for key, _label, _t, lo, hi, default, _hint in items:
                values[key] = default
        for key, _label, default in OPERATIONS_BOOLS:
            values[key] = '1' if default else '0'
        for key, _label, _maxlen in OPERATIONS_TEXTS:
            values[key] = ''
        rows = conn.execute('SELECT key, value FROM settings').fetchall()
        for r in rows:
            if r['key'] in values:
                values[r['key']] = r['value']
        # 数字项转成 int 供 el-input-number 使用
        for _, _, items in OPERATIONS_GROUPS:
            for key, _label, _t, _lo, _hi, default, _hint in items:
                try:
                    values[key] = int(values[key])
                except (TypeError, ValueError):
                    values[key] = default
        return values

    @app.route('/operations', methods=['GET', 'POST'])
    @login_required
    def operations():
        """运营设置：小程序全部可配参数集中管理（改完立即对新请求生效）。"""
        if request.method == 'POST':
            updates = {}
            for _, _, items in OPERATIONS_GROUPS:
                for key, label, _t, lo, hi, _default, _hint in items:
                    try:
                        n = int(str(request.form.get(key, '')).strip())
                    except (TypeError, ValueError):
                        flash(f'「{label}」请填整数', 'error')
                        return redirect(url_for('operations'))
                    if not (lo <= n <= hi):
                        flash(f'「{label}」需在 {lo}~{hi} 之间', 'error')
                        return redirect(url_for('operations'))
                    updates[key] = str(n)
            for key, _label, _default in OPERATIONS_BOOLS:
                updates[key] = '1' if request.form.get(key) == '1' else '0'
            for key, label, maxlen in OPERATIONS_TEXTS:
                v = (request.form.get(key) or '').strip()
                if len(v) > maxlen:
                    flash(f'「{label}」最多 {maxlen} 字', 'error')
                    return redirect(url_for('operations'))
                updates[key] = v
            conn = get_conn()
            for key, n in updates.items():
                conn.execute(
                    'INSERT INTO settings(key, value) VALUES(?,?) '
                    'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, n))
            conn.commit()
            conn.close()
            flash('运营设置已保存，小程序下次请求即生效', 'ok')
            return redirect(url_for('operations'))
        conn = get_conn()
        values = _read_operations(conn)
        conn.close()
        return render_template('operations.html', groups=OPERATIONS_GROUPS,
                               bools=OPERATIONS_BOOLS, texts=OPERATIONS_TEXTS,
                               values=values)

    # ---------- 转盘奖品 ----------
    @app.route('/wheel-prizes')
    @login_required
    def wheel_prizes():
        conn = get_conn()
        rows = conn.execute(
            'SELECT p.*, (SELECT COUNT(*) FROM wheel_draws d WHERE d.prize_id=p.id) AS win_count '
            'FROM wheel_prizes p ORDER BY p.sort, p.id').fetchall()
        conn.close()
        return render_template('wheel_prizes.html', rows=rows)

    @app.route('/wheel-prizes/save', methods=['POST'])
    @login_required
    def wheel_prize_save():
        pid = (request.form.get('id') or '').strip()
        name = (request.form.get('name') or '').strip()[:40]
        ptype = request.form.get('type') if request.form.get('type') in (
            'points', 'physical', 'none') else 'points'
        if not name:
            flash('奖品名称必填', 'error')
            return redirect(url_for('wheel_prizes'))
        value = _parse_int(request.form.get('value'), 0, 0)
        weight = _parse_int(request.form.get('weight'), 1, 0)
        stock = _parse_int(request.form.get('stock'), -1, -1)
        sort = _parse_int(request.form.get('sort'), 0, 0)
        enabled = 1 if request.form.get('enabled') == '1' else 0
        conn = get_conn()
        if pid:
            if not conn.execute('SELECT 1 FROM wheel_prizes WHERE id=?', (pid,)).fetchone():
                conn.close()
                flash('奖品不存在', 'error')
                return redirect(url_for('wheel_prizes'))
            conn.execute(
                'UPDATE wheel_prizes SET name=?, type=?, value=?, weight=?, stock=?, enabled=?, sort=? '
                'WHERE id=?', (name, ptype, value, weight, stock, enabled, sort, pid))
            flash(f'奖品已更新：{name}', 'ok')
        else:
            pid = 'w' + datetime.now().strftime('%Y%m%d%H%M%S')
            conn.execute(
                'INSERT INTO wheel_prizes (id, name, type, value, weight, stock, enabled, sort) '
                'VALUES (?,?,?,?,?,?,?,?)', (pid, name, ptype, value, weight, stock, enabled, sort))
            flash(f'奖品已新增：{name}', 'ok')
        conn.commit()
        conn.close()
        return redirect(url_for('wheel_prizes'))

    @app.route('/wheel-prizes/<pid>/delete', methods=['POST'])
    @login_required
    def wheel_prize_delete(pid):
        conn = get_conn()
        n = conn.execute('SELECT COUNT(*) c FROM wheel_draws WHERE prize_id=?', (pid,)).fetchone()['c']
        if n:
            conn.close()
            flash(f'该奖品已有 {n} 条中奖记录，不可删除（可改为停用或把库存设为 0）', 'error')
            return redirect(url_for('wheel_prizes'))
        conn.execute('DELETE FROM wheel_prizes WHERE id=?', (pid,))
        conn.commit()
        conn.close()
        flash('奖品已删除', 'ok')
        return redirect(url_for('wheel_prizes'))

    # ---------- 转盘中奖记录 ----------
    @app.route('/wheel-draws')
    @login_required
    def wheel_draws():
        tab = request.args.get('tab', 'all')
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 50
        conn = get_conn()
        where, params = [], []
        if tab == 'physical':
            where.append("prize_type='physical'")
        elif tab == 'pending':
            where.append("status IN ('pending_contact','pending_ship')")
        wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
        total = conn.execute('SELECT COUNT(*) c FROM wheel_draws' + wsql, params).fetchone()['c']
        rows = conn.execute('SELECT * FROM wheel_draws' + wsql +
                            ' ORDER BY id DESC LIMIT ? OFFSET ?',
                            params + [per, (page - 1) * per]).fetchall()
        pages = max(1, (total + per - 1) // per)
        conn.close()
        return render_template('wheel_draws.html', rows=rows, tab=tab, page=page, pages=pages,
                               total=total)

    @app.route('/wheel-draws/<int:did>/status', methods=['POST'])
    @login_required
    def wheel_draw_status(did):
        status = request.form.get('status', '')
        if status not in ('won', 'pending_contact', 'pending_ship', 'shipped', 'done'):
            flash('状态不合法', 'error')
            return redirect(url_for('wheel_draws'))
        conn = get_conn()
        conn.execute(
            "UPDATE wheel_draws SET status=?, updated_at=datetime('now','localtime') WHERE id=?",
            (status, did))
        conn.commit()
        conn.close()
        flash(f'中奖记录 #{did} 状态已更新', 'ok')
        return redirect(url_for('wheel_draws'))

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

    # ---------- 用户管理（微信登录档案 + 封禁 + 积分调整） ----------
    @app.route('/users')
    @login_required
    def users():
        """用户列表：档案来自登录/答题行为，含答题数、短评数、积分余额"""
        q = request.args.get('q', '').strip()
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 20
        conn = get_conn()
        where, params = '', []
        if q:
            where = ' WHERE u.id LIKE ? OR u.nickname LIKE ?'
            like = f'%{q}%'
            params = [like, like]
        total = conn.execute(
            'SELECT COUNT(*) c FROM users u' + where, params).fetchone()['c']
        rows = conn.execute(
            'SELECT u.*, '
            '(SELECT COUNT(*) FROM votes v WHERE v.user_id=u.id) AS vote_count, '
            '(SELECT COUNT(*) FROM comments c WHERE c.user_id=u.id) AS comment_count, '
            '(SELECT COALESCE(SUM(l.amount),0) FROM points_ledger l WHERE l.user_id=u.id) AS balance '
            'FROM users u' + where + ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?',
            params + [per, (page - 1) * per]).fetchall()
        pages = max(1, (total + per - 1) // per)
        conn.close()
        return render_template('users.html', rows=rows, q=q, page=page,
                               pages=pages, total=total)

    @app.route('/users/<uid>')
    @login_required
    def user_detail(uid):
        conn = get_conn()
        row = conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if not row:
            conn.close()
            flash('用户不存在', 'error')
            return redirect(url_for('users'))
        balance = conn.execute(
            'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=?',
            (uid,)).fetchone()['s']
        votes = conn.execute(
            'SELECT v.option, v.question_date, v.created_at, q.title, q.optionA, q.optionB '
            'FROM votes v LEFT JOIN questions q ON q.id=v.question_id '
            'WHERE v.user_id=? ORDER BY v.created_at DESC LIMIT 50', (uid,)).fetchall()
        comments = conn.execute(
            'SELECT * FROM comments WHERE user_id=? ORDER BY created_at DESC LIMIT 50',
            (uid,)).fetchall()
        reports = conn.execute(
            'SELECT * FROM reports WHERE user_id=? ORDER BY id DESC LIMIT 50', (uid,)).fetchall()
        orders = conn.execute(
            'SELECT * FROM redeem_orders WHERE user_id=? ORDER BY id DESC LIMIT 50',
            (uid,)).fetchall()
        ledger = conn.execute(
            'SELECT * FROM points_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50',
            (uid,)).fetchall()
        conn.close()
        return render_template('user_detail.html', row=row, uid=uid, balance=balance,
                               votes=votes, comments=comments, reports=reports,
                               orders=orders, ledger=ledger, reason_labels=REASON_LABELS)

    @app.route('/users/<uid>/status', methods=['POST'])
    @login_required
    def user_status(uid):
        """封禁/解封：封禁后答题、评论、兑换等写接口统一拒绝（server.js 管线拦截，code 4030）"""
        action = request.form.get('action', '')
        conn = get_conn()
        if action == 'ban':
            reason = (request.form.get('reason') or '').strip()[:100]
            conn.execute(
                "UPDATE users SET status='banned', banned_reason=?, "
                "updated_at=datetime('now','localtime') WHERE id=?", (reason, uid))
            flash(f'用户 {uid} 已封禁' + (f'：{reason}' if reason else ''), 'ok')
        else:
            conn.execute(
                "UPDATE users SET status='active', banned_reason='', "
                "updated_at=datetime('now','localtime') WHERE id=?", (uid,))
            flash(f'用户 {uid} 已解封', 'ok')
        conn.commit()
        conn.close()
        return redirect(url_for('user_detail', uid=uid))

    @app.route('/users/<uid>/adjust', methods=['POST'])
    @login_required
    def user_adjust(uid):
        """手动调整积分：写 adjust 流水（正加负减），不允许调为负余额"""
        try:
            amount = int(request.form.get('amount', '0'))
        except ValueError:
            amount = 0
        reason = (request.form.get('reason') or '').strip()[:50]
        if amount == 0:
            flash('调整数值不能为 0', 'error')
            return redirect(url_for('user_detail', uid=uid))
        conn = get_conn()
        balance = conn.execute(
            'SELECT COALESCE(SUM(amount),0) s FROM points_ledger WHERE user_id=?',
            (uid,)).fetchone()['s']
        if balance + amount < 0:
            conn.close()
            flash(f'调整后余额将为负（当前 {balance}），已拒绝', 'error')
            return redirect(url_for('user_detail', uid=uid))
        conn.execute(
            'INSERT INTO points_ledger (user_id, type, amount, reason, created_at) '
            'VALUES (?,?,?,?,?)',
            (uid, 'adjust', amount, f'后台调整：{reason or "无备注"}',
             datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
        conn.commit()
        conn.close()
        sign = '+' if amount > 0 else ''
        flash(f'已调整 {uid} 积分 {sign}{amount}，当前余额 {balance + amount}', 'ok')
        return redirect(url_for('user_detail', uid=uid))

    @app.route('/avatar/<filename>')
    @login_required
    def avatar(filename):
        """用户头像（Node API 写入 backend/api/uploads/，与后台共享磁盘）"""
        return send_from_directory(UPLOADS_DIR, filename)

    # ---------- 用户管理 END ----------

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

    @app.route('/questions/<qid>')
    @login_required
    def question_detail(qid):
        """单题数据：题目信息 + 投票/评论/举报统计（投稿审核「查看题目」跳这里）。"""
        conn = get_conn()
        row = conn.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
        if not row:
            conn.close()
            flash('题目不存在', 'error')
            return redirect(url_for('questions'))
        votes = conn.execute(
            "SELECT COALESCE(SUM(option='A'), 0) a, COALESCE(SUM(option='B'), 0) b, "
            "COALESCE(AVG(duration), 0) avg_duration FROM votes WHERE question_id=?", (qid,)
        ).fetchone()
        total = votes['a'] + votes['b']
        stats = {
            'a': votes['a'],
            'b': votes['b'],
            'total': total,
            'pct_a': round(votes['a'] * 100.0 / total, 1) if total else 0,
            'pct_b': round(votes['b'] * 100.0 / total, 1) if total else 0,
            'avg_duration': round(votes['avg_duration'] or 0, 1),
            'comments': conn.execute(
                'SELECT COUNT(*) c FROM comments WHERE question_id=? AND hidden=0',
                (qid,)).fetchone()['c'],
            'reports': conn.execute(
                "SELECT COUNT(*) c FROM reports WHERE target_id=? AND target_type='question'",
                (qid,)).fetchone()['c'],
        }
        sub = conn.execute(
            'SELECT * FROM submissions WHERE question_id=? ORDER BY created_at DESC LIMIT 1',
            (qid,)).fetchone()
        conn.close()
        return render_template('question_detail.html', q=row, stats=stats, sub=sub,
                               today=today_str())

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
        # 处理结果说明：填写后会同步给举报用户的小程序「举报反馈」卡片
        result = (request.form.get('result') or '').strip()[:100]
        conn = get_conn()
        conn.execute("UPDATE reports SET status='closed', result=? WHERE id=?", (result, rid))
        conn.commit()
        conn.close()
        flash(f'举报 #{rid} 已标记处理' + ('，结果已同步给用户' if result else ''), 'ok')
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

    # ---------- 意见反馈（小程序提交，后台采纳发积分 + 回复用户） ----------
    FEEDBACK_REWARD_DEFAULT = 20

    def _feedback_reward(conn) -> int:
        row = conn.execute(
            "SELECT value FROM settings WHERE key='feedback_reward_points'").fetchone()
        try:
            return max(0, int(row['value'])) if row else FEEDBACK_REWARD_DEFAULT
        except (TypeError, ValueError):
            return FEEDBACK_REWARD_DEFAULT

    def _utc_iso() -> str:
        return datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

    @app.route('/feedback')
    @login_required
    def feedback():
        tab = request.args.get('tab', 'pending')
        page = _parse_int(request.args.get('page'), 1, 1)
        per = 30
        conn = get_conn()
        where, params = [], []
        if tab in ('pending', 'accepted', 'rejected'):
            where.append('status=?')
            params.append(tab)
        wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
        total = conn.execute('SELECT COUNT(*) c FROM feedback' + wsql, params).fetchone()['c']
        rows = conn.execute('SELECT * FROM feedback' + wsql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
                            params + [per, (page - 1) * per]).fetchall()
        reward_points = _feedback_reward(conn)
        pages = max(1, (total + per - 1) // per)
        conn.close()
        return render_template('feedback.html', rows=rows, tab=tab, page=page, pages=pages,
                               total=total, reward_points=reward_points)

    @app.route('/feedback/settings', methods=['POST'])
    @login_required
    def feedback_settings():
        """采纳奖励积分（全局设置，后台可改，不硬编码在小程序里）"""
        try:
            points = int(request.form.get('reward_points', ''))
        except ValueError:
            points = -1
        if not (0 <= points <= 1000):
            flash('奖励积分需在 0~1000 之间', 'error')
            return redirect(url_for('feedback'))
        conn = get_conn()
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('feedback_reward_points', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(points),))
        conn.commit()
        conn.close()
        flash(f'采纳奖励积分已设为 {points}', 'ok')
        return redirect(url_for('feedback'))

    @app.route('/feedback/<int:fid>/accept', methods=['POST'])
    @login_required
    def feedback_accept(fid):
        """采纳：写回复 + 按奖励积分入账（幂等 ref_id=feedback_<id>），采纳后不可逆"""
        reply = (request.form.get('reply') or '').strip()
        if len(reply) > 300:
            flash('回复最多 300 字', 'error')
            return redirect(url_for('feedback'))
        try:
            reward = int(request.form.get('reward', '0'))
        except ValueError:
            reward = -1
        if not (0 <= reward <= 1000):
            flash('奖励积分需在 0~1000 之间', 'error')
            return redirect(url_for('feedback'))
        conn = get_conn()
        row = conn.execute('SELECT * FROM feedback WHERE id=?', (fid,)).fetchone()
        if not row:
            conn.close()
            flash('反馈不存在或已删除', 'error')
            return redirect(url_for('feedback'))
        if row['status'] != 'pending':
            conn.close()
            flash('该反馈已处理，不能重复操作', 'error')
            return redirect(url_for('feedback'))
        uid = (row['user_id'] or '').strip()
        handled_at = _utc_iso()
        awarded = 0
        try:
            conn.execute(
                "UPDATE feedback SET status='accepted', reply=?, reward=?, handled_at=? "
                "WHERE id=? AND status='pending'", (reply, reward, handled_at, fid))
            if reward > 0 and uid and uid != 'anonymous':
                ref = f'feedback_{fid}'
                exists = conn.execute(
                    "SELECT 1 FROM points_ledger WHERE user_id=? AND type='earn' AND ref_id=?",
                    (uid, ref)).fetchone()
                if not exists:
                    conn.execute(
                        'INSERT INTO points_ledger (user_id, type, amount, reason, ref_id, created_at) '
                        'VALUES (?,?,?,?,?,?)',
                        (uid, 'earn', reward, '意见采纳奖励', ref, handled_at))
                    awarded = reward
            conn.commit()
        except Exception as e:  # noqa: BLE001 - 失败回滚并提示运营
            conn.rollback()
            conn.close()
            flash(f'采纳失败：{e}', 'error')
            return redirect(url_for('feedback'))
        conn.close()
        flash(f'已采纳并回复用户' + (f'，发放 {awarded} 积分' if awarded else '（未发放积分）'), 'ok')
        return redirect(url_for('feedback'))

    @app.route('/feedback/<int:fid>/reject', methods=['POST'])
    @login_required
    def feedback_reject(fid):
        """不采纳：可填说明（会展示给用户），不发积分"""
        reply = (request.form.get('reply') or '').strip()[:300]
        conn = get_conn()
        row = conn.execute('SELECT status FROM feedback WHERE id=?', (fid,)).fetchone()
        if not row:
            conn.close()
            flash('反馈不存在或已删除', 'error')
            return redirect(url_for('feedback'))
        if row['status'] != 'pending':
            conn.close()
            flash('该反馈已处理，不能重复操作', 'error')
            return redirect(url_for('feedback'))
        conn.execute(
            "UPDATE feedback SET status='rejected', reply=?, reward=0, handled_at=? WHERE id=?",
            (reply, _utc_iso(), fid))
        conn.commit()
        conn.close()
        flash('已标记为不采纳' + ('，说明已同步用户' if reply else ''), 'ok')
        return redirect(url_for('feedback'))

    @app.route('/feedback/<int:fid>/delete', methods=['POST'])
    @login_required
    def feedback_delete(fid):
        """删除反馈记录（已发放的积分不回收）"""
        conn = get_conn()
        conn.execute('DELETE FROM feedback WHERE id=?', (fid,))
        conn.commit()
        conn.close()
        flash('反馈已删除', 'ok')
        return redirect(url_for('feedback'))

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
                  'points_ledger', 'prizes', 'redeem_orders', 'ai_profiles', 'feedback',
                  'wheel_prizes', 'wheel_draws', 'draw_chances'):
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
                   'points_ledger', 'prizes', 'redeem_orders', 'ai_profiles', 'feedback',
                   'wheel_prizes', 'wheel_draws', 'draw_chances'}
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
