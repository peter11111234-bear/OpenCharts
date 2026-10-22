import os, json
from pathlib import Path

# ─── 2026-10-16 §4.5 / §6 helpers (night-session, DeepSeek, risk gate) ────

def _load_env(name):
    import os
    k = os.environ.get(name, '').strip()
    if k:
        return k
    for path in (Path(r'C:\MyTradingProjects\.env'),
                 Path(r'C:\Users\bear9\jev-laya-bench\jev-wigolo\.env')):
        try:
            for line in path.read_text(encoding='utf-8').splitlines():
                s = line.strip()
                if s.startswith('export '):
                    s = s[7:].lstrip()
                if s.startswith(name + '='):
                    val = s.split('=', 1)[1].strip()
                    if ' #' in val:
                        val = val.split(' #', 1)[0].rstrip()
                    val = val.strip('"').strip(chr(39))
                    if val:
                        return val
        except OSError:
            continue
    return ''
DEEPSEEK_KEY = _load_env('DEEPSEEK_API_KEY')
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_ESCALATE = os.environ.get('DEEPSEEK_ESCALATE', '1') == '1'
DEEPSEEK_MAX_PER_DAY = int(os.environ.get('DEEPSEEK_MAX_PER_DAY', '150'))
DEEPSEEK_SPEND_FILE = Path(__file__).with_name('jev-deepseek-spend.json')

_DS_SYS = ('You are a quantitative risk reviewer for TMF micro-futures. Given Jev atomic '
           'judgement, decide one of three outcomes and output STRICT JSON only: '
           '{"verdict":"approve|veto|reduce","lots":int,"reason":"<=200 chars"}. '
           'approve: agree. veto: serious issue -> skip. reduce: uncertainty -> Jev lots halved. '
           'lots=0 for veto; otherwise 0,1,2. Cite a concrete risk or signal reason.')


def _get_deepseek_paid_today():
    today = datetime.now(TAIPEI).date().isoformat()
    try:
        if DEEPSEEK_SPEND_FILE.exists():
            d = json.loads(DEEPSEEK_SPEND_FILE.read_text(encoding='utf-8'))
            if d.get('date') == today:
                return int(d.get('count', 0))
    except Exception:
        pass
    return 0


def _bump_deepseek_paid():
    today = datetime.now(TAIPEI).date().isoformat()
    try:
        cnt = _get_deepseek_paid_today()
        DEEPSEEK_SPEND_FILE.write_text(json.dumps({'date': today, 'count': cnt + 1}), encoding='utf-8')
    except Exception:
        pass


def should_escalate(ans):
    """plan-v1 §4.4 triggers: low confidence, volatile env, low reliability setup."""
    if not ans or not ans.get('answers'):
        return False, ''
    a = ans['answers'].get('action_choice', {}) or {}
    try:
        conf = float(a.get('confidence', 1.0))
    except (TypeError, ValueError):
        conf = 1.0
    vol = ans['answers'].get('volatility_regime', {}) or {}
    vol_txt = ' '.join(str(v) for v in (vol.values() if isinstance(vol, dict) else [vol])).lower()
    low_rel = ans['answers'].get('low_reliability_setup', {}) or {}
    if isinstance(low_rel, dict):
        lr = low_rel.get('value') if low_rel.get('value') is not None else low_rel.get('choice')
    else:
        lr = low_rel
    try:
        lr_num = int(lr) if lr is not None else 0
    except (TypeError, ValueError):
        lr_num = 0
    if conf < 0.6:
        return True, 'confidence < 0.6'
    if 'volatile' in vol_txt:
        return True, 'volatile environment'
    if lr_num >= 1:
        return True, 'low reliability setup'
    return False, ''


def deepseek_escalate(state, ans, trigger):
    """Shadow second opinion. Returns dict {verdict, lots, reason, trigger} or None."""
    if not DEEPSEEK_ESCALATE or not DEEPSEEK_KEY:
        return None
    if _get_deepseek_paid_today() >= DEEPSEEK_MAX_PER_DAY:
        return None
    answers = (ans or {}).get('answers') or {}
    payload = {
        'model': DEEPSEEK_MODEL,
        'messages': [
            {'role': 'system', 'content': _DS_SYS},
            {'role': 'user', 'content':
                'Jev answer (JSON):\n' + json.dumps(answers, ensure_ascii=False) + '\n\n'
                'Escalation trigger: ' + trigger + '\n\n'
                'Signal state (key indicators):\n'
                ' current_price=' + str(state.get('current_price')) +
                '  change_percent=' + str(state['price'].get('change_percent')) + '\n'
                ' day_high=' + str(state['price'].get('day_high')) +
                '  day_low=' + str(state['price'].get('day_low')) + '\n'
                ' oscillators=' + str(state.get('oscillators', [])) + '\n'
                ' position=' + str(state.get('position')) + '  quantity=' + str(state.get('quantity')) +
                '  risk_appetite=' + str(state.get('risk_appetite')) + '\n'
                'Return JSON only.'},
        ],
        'response_format': {'type': 'json_object'},
        'temperature': 0.0,
        'max_tokens': 200,
    }
    import urllib.request
    try:
        req = urllib.request.Request(
            'https://api.deepseek.com/v1/chat/completions',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + DEEPSEEK_KEY,
                     'Content-Type': 'application/json'},
            method='POST')
        txt = json.loads(urllib.request.urlopen(req, timeout=25).read().decode('utf-8'))
        content = txt['choices'][0]['message']['content']
        out = json.loads(content)
        v = (out.get('verdict') or 'approve').lower()
        if v not in ('approve', 'veto', 'reduce'):
            v = 'approve'
        lots = int(out.get('lots', 0))
        lots = 0 if v == 'veto' else max(0, min(lots, 3))
        _bump_deepseek_paid()
        return {'verdict': v, 'lots': lots,
                'reason': str(out.get('reason', ''))[:200],
                'trigger': trigger}
    except Exception as e:
        return {'error': str(type(e).__name__) + ': ' + str(e), 'trigger': trigger}


class RiskSession:
    """Track within-day counters for §6 risk rules (shadow mode).

    Trade outcomes simulated via forward prices: when a new bar closes after
    our last entry, infer P&L from direction suggested vs close.
    In real execution this must be replaced by the broker's fills.
    """

    def __init__(self):
        self.follow_count_today = 0
        self.realized_points = 0.0
        self.consecutive_losses = 0
        self.in_profit_protect = False
        self.open_entry = None
        self.open_direction = None
        self.open_ts = None

    def _close_open_position(self, current_bar):
        if self.open_entry is None or self.open_direction is None:
            return None
        if self.open_direction == 'flat':
            self.open_entry = None
            self.open_direction = None
            self.open_ts = None
            return None
        cur = current_bar['close']
        mult = 1 if self.open_direction == 'buy' else -1
        pnl = mult * (cur - self.open_entry)
        self.realized_points += pnl
        if pnl >= 0:
            self.consecutive_losses = 0
        else:
            self.consecutive_losses += 1
        if self.realized_points >= 800:
            self.in_profit_protect = True
        outcome = {'entry': self.open_entry, 'exit': cur,
                   'direction': self.open_direction, 'pnl_points': round(pnl, 2),
                   'realized_points': round(self.realized_points, 2)}
        self.open_entry = None
        self.open_direction = None
        self.open_ts = None
        return outcome

    def gate(self, bar, ans):
        answers = (ans or {}).get('answers') or {}
        a = answers.get('action_choice', {}) or {}
        choice = a.get('choice')
        try:
            conf = float(a.get('confidence', 0.0) or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        vol = answers.get('volatility_regime', {}) or {}
        vol_txt = ' '.join(str(v) for v in (vol.values() if isinstance(vol, dict) else [vol])).lower()

        # --- hard vetoes ---
        if choice == 'flat':
            return 'veto', 0.0, 'flat choice', 'flat'
        if 'volatile' in vol_txt:
            return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'
        if self.follow_count_today >= 5:
            return 'veto', 0.0, 'daily follow cap (5) reached', 'max_follow_day'
        if self.in_profit_protect and choice in ('buy', 'sell'):
            return 'veto', 0.0, 'daily profit protect gate (+800 pts already)', 'profit_protect'
        if self.consecutive_losses >= 3:
            return 'veto', 0.0, '3 consecutive losses -> stop for day', 'consec_loss_stop'

        # --- reduces ---
        lots_mult = 1.0
        reasons = []
        if conf < 0.85:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('medium confidence (<0.85)')
        if conf < 0.6:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('low confidence (<0.6)')
        if self.consecutive_losses == 2:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('2 consecutive losses -> half lots')
        if lots_mult < 1.0:
            return 'reduce', lots_mult, reasons[0], 'reduce'
        return 'approve', 1.0, 'strong signal, risk=0', 'full'