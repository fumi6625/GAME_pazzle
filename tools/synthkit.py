"""ゲーム用ループ曲を書くための最小限のシンセ道具箱。

外部ライブラリは numpy / scipy だけ。すべて 44.1kHz ステレオ float32 で扱う。

設計方針（PRISM_SHUFFLE/README.md の考え方をそのまま引き継ぐ）:
  * 操作音は演奏者（プレイヤー）が鳴らすので、曲側は C5 より上を空けておく。
    リードの中心は MIDI 60 前後に置き、上を効果音の居場所として残す。
  * 高域は「連続した静かなノイズの層」で埋める。これがあると明るい高域が
    刺さらなくなる。暗くして解決してはいけない。
  * ステムは5本（drums/bass/chords/melody/atmos）。ゲーム側が盤面の状況で
    03/04 を出し入れするので、それぞれ単体で成立する音量で書く。
"""
import numpy as np
from scipy import signal as sg
from scipy.signal import fftconvolve

SR = 44100
TAU = 2 * np.pi


# ---------------------------------------------------------------- 基本波形
def _t(n):
    return np.arange(n, dtype=np.float64) / SR


# `from synthkit import *` で持ち出す名前（先頭が _ のものは既定で除かれるため明示）
tseq = _t


def sine(f, n, phase=0.0):
    return np.sin(TAU * f * _t(n) + phase)


def saw(f, n, nh=None):
    """加算合成のノコギリ波。ナイキストを超える倍音は作らないので折り返さない。"""
    t = _t(n)
    if nh is None:
        nh = max(1, int(SR / 2 / max(f, 1e-6)))
    nh = min(nh, 90)
    out = np.zeros(n)
    for k in range(1, nh + 1):
        if k * f >= SR / 2:
            break
        out -= np.sin(TAU * k * f * t) / k
    return out * (2 / np.pi)


def square(f, n, nh=None):
    t = _t(n)
    if nh is None:
        nh = max(1, int(SR / 2 / max(f, 1e-6)))
    nh = min(nh, 90)
    out = np.zeros(n)
    for k in range(1, nh + 1, 2):
        if k * f >= SR / 2:
            break
        out += np.sin(TAU * k * f * t) / k
    return out * (4 / np.pi)


def tri(f, n, nh=40):
    t = _t(n)
    out = np.zeros(n)
    for i, k in enumerate(range(1, nh * 2, 2)):
        if k * f >= SR / 2:
            break
        out += ((-1) ** i) * np.sin(TAU * k * f * t) / (k * k)
    return out * (8 / np.pi ** 2)


def noise(n, rng):
    return rng.standard_normal(n)


# ---------------------------------------------------------------- 包絡線
def adsr(n, a=0.005, d=0.08, s=0.6, r=0.12):
    """秒指定の ADSR。合計が n を超える場合は素直に切り詰める。"""
    an, dn, rn = int(a * SR), int(d * SR), int(r * SR)
    sn = max(0, n - an - dn - rn)
    if an + dn + rn > n:                       # 短い音は A/R だけに縮める
        an = min(an, n // 3); rn = min(rn, n // 3)
        dn = max(0, n - an - rn); sn = 0
    e = np.concatenate([
        np.linspace(0, 1, an, endpoint=False) if an else np.empty(0),
        np.linspace(1, s, dn, endpoint=False) if dn else np.empty(0),
        np.full(sn, s),
        np.linspace(s, 0, rn) if rn else np.empty(0),
    ])
    if len(e) < n:
        e = np.concatenate([e, np.zeros(n - len(e))])
    return e[:n]


def perc_env(n, hold=0.0, decay=0.18, curve=2.2):
    """打楽器用の「立ち上がり即・あとは指数減衰」。"""
    hn = int(hold * SR)
    e = np.ones(n)
    dn = max(1, n - hn)
    e[hn:] = np.exp(-np.linspace(0, curve * 6, dn)) ** 1.0
    e[: max(1, int(0.0012 * SR))] *= np.linspace(0, 1, max(1, int(0.0012 * SR)))
    return e


# ---------------------------------------------------------------- フィルタ
def lp(x, fc, order=4):
    fc = min(fc, SR / 2 * 0.98)
    b, a = sg.butter(order, fc / (SR / 2), "low")
    return sg.filtfilt(b, a, x) if len(x) > 3 * order else x


def hp(x, fc, order=4):
    fc = max(10.0, min(fc, SR / 2 * 0.95))
    b, a = sg.butter(order, fc / (SR / 2), "high")
    return sg.filtfilt(b, a, x) if len(x) > 3 * order else x


def bp(x, lo, hi, order=2):
    lo = max(10.0, lo); hi = min(hi, SR / 2 * 0.95)
    b, a = sg.butter(order, [lo / (SR / 2), hi / (SR / 2)], "band")
    return sg.filtfilt(b, a, x) if len(x) > 6 * order else x


def reso_lp(x, fc, q=6.0):
    """共振つきの1段ローパス。フィルタらしい癖を足したい時に使う。"""
    fc = min(max(fc, 30.0), SR / 2 * 0.95)
    w0 = TAU * fc / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
    a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    return sg.lfilter(b / a[0], a / a[0], x)


# ---------------------------------------------------------------- 空間
def make_reverb(dur=1.8, decay=4.2, pre=0.012, top=4200, rng=None):
    """暗めのテールを持つ残響。テールで高域を足さないのが肝。"""
    rng = rng or np.random.default_rng(7)
    n = int(dur * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-np.arange(n) / SR * decay)[:, None]
    ir[: int(pre * SR)] = 0
    for c in range(2):
        ir[:, c] = lp(hp(ir[:, c], 180), top)
    return (ir / np.abs(ir).max() * 0.32).astype(np.float64)


def reverb(x, ir, mix=0.25):
    """x: (n,2)。ループ素材なので、末尾からはみ出したテールは先頭へ回り込ませる。
    ここを切り捨てると繰り返しの継ぎ目で残響が途切れて段差になる。"""
    n = len(x)
    wet = np.zeros_like(x)
    for c in range(2):
        full = fftconvolve(x[:, c], ir[:, c])
        head = full[:n].copy()
        over = full[n:]
        if len(over):
            k = min(len(over), n)
            head[:k] += over[:k]           # はみ出したぶんを頭へ足す（循環畳み込み）
        wet[:, c] = head
    return x * (1 - mix) + wet * mix


def pingpong(x, time, fb=0.35, mix=0.28, n_rep=6):
    """左右に振れるディレイ。ループ素材なので巻き込み（np.roll）で回す。
    末尾で切ると継ぎ目でディレイが消えて段差になる。"""
    out = x.copy()
    d = int(time * SR)
    g = fb
    for i in range(1, n_rep + 1):
        if d * i >= len(x):
            break
        s = np.roll(x, d * i, axis=0) * g
        if i % 2:
            s[:, 0] *= 0.35
        else:
            s[:, 1] *= 0.35
        out += s * mix
        g *= fb
    return out


def widen(mono, amount=0.5, ms=12):
    """モノ素材を薄く広げる。位相差だけなのでモノ互換を大きく崩さない。"""
    d = int(ms / 1000 * SR)
    l = mono.copy()
    r = np.concatenate([np.zeros(d), mono[:-d]]) if d else mono.copy()
    return np.stack([l, l * (1 - amount) + r * amount], 1)


# ---------------------------------------------------------------- 配置
def place(buf, x, at, gain=1.0, pan=0.0):
    """buf(n,2) に x(モノ or ステレオ) を at サンプル位置から加算する。
    ループの端を越えたぶんは先頭へ回り込ませる（循環ループのため）。"""
    if x.ndim == 1:
        l = np.sqrt((1 - pan) / 2) * 2 ** 0.5 / 2 ** 0.5
        r = np.sqrt((1 + pan) / 2) * 2 ** 0.5 / 2 ** 0.5
        x = np.stack([x * l, x * r], 1)
    n = len(x)
    idx = (np.arange(n) + int(at)) % len(buf)
    np.add.at(buf, idx, x * gain)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# ---------------------------------------------------------------- 仕上げ
def soft_limit(x, ceil=0.94, w=int(0.03 * SR)):
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    pk = np.abs(x).max(axis=1)
    m = maximum_filter1d(pk, size=2 * w + 1, mode="wrap")
    g = np.minimum(1.0, ceil / np.maximum(m, 1e-9))
    g = uniform_filter1d(g, size=2 * w + 1, mode="wrap")
    y = x * g[:, None]
    p = float(np.abs(y).max())
    return y * (ceil / p) if p > ceil else y


def write_wav(path, x):
    import wave
    x = np.clip(np.asarray(x, np.float64), -1.0, 1.0)
    d = (x * 32767.0).astype(np.int16)
    w = wave.open(path, "wb")
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(d.tobytes()); w.close()
