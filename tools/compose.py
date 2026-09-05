#!/usr/bin/env python3
"""ジャンルとテンポの違うループ曲を3本書き出す。

なぜテンポを分けるか:
  参考動画（RTA in Japan 2019 / ルミネス リマスター）を実測したところ、
  タイムラインが盤面を1周する時間はスキン（＝曲）ごとに違い、
  残差の小さい計測で 4.0〜5.6 秒の幅があった。
  つまり「掃引の速さは曲のテンポで決まる」のが本家の設計。
  そこで既存の PRISM SHUFFLE(96BPM) に加え、掃引がその幅に収まる
  テンポの曲を3本用意する。

  曲              BPM   ジャンル              2小節=16列の掃引
  PRISM SHUFFLE    96   ビッグビート / ファンク   5.000 秒
  NEON MARCH      120   4つ打ちテクノ            4.000 秒
  CIRCUIT RUSH    112   エレクトロ・ブレイクス     4.286 秒
  GLASS TIDE       84   ダウンテンポ・ダブ        5.714 秒
  SODA DRIFT      128   ビッグビート・ファンク     3.750 秒
  CHROME SPRINT   140   ファンク・ブレイクス       3.429 秒

  後ろの2曲は、作者の好きな3曲（129.2 / 107.7 / 139.7 BPM）と同じテンポ帯に
  合わせて後から足したもの。参考曲の掃引より速いが、作者提供の実機録画
  （掃引 3.588 秒）の範囲内なので、終盤の曲として成立する。

  BPM はすべて 32小節 × 44100Hz がサンプル単位で割り切れる値を選んである
  （32小節 = 7680/BPM 秒。7680×44100 = 2^11·3^3·5^3·7^2 の約数から選定）。
  ループ境界にサンプルの端数が出ると、繰り返すたびに位相がずれてしまうため。

構成は既存曲と揃えて 32小節 / 5ステム。
  01_drums 02_bass 05_atmos … 常時
  03_chords … 標準以上、04_melody … 高揚時のみ
ゲーム側の切り替え機構をそのまま使えるようにしてある。
"""
import os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synthkit import *      # noqa
from synthkit import _t

OUT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "PRISM_SHUFFLE")
BARS = 32


# ============================================================ ドラム音源
def kick(dur=0.36, f0=118, f1=44, click=0.5, rng=None):
    n = int(dur * SR)
    t = _t(n)
    # ピッチ包絡: 一瞬だけ高いところから落ちる。これが「打点」の正体。
    f = f1 + (f0 - f1) * np.exp(-t * 46)
    ph = np.cumsum(TAU * f / SR)
    body = np.sin(ph) * perc_env(n, decay=0.9, curve=1.5)
    cl = hp(noise(int(0.006 * SR), rng or np.random.default_rng(1)), 1200)
    out = body
    out[: len(cl)] += cl * click * 0.5
    return lp(out, 6000) * 0.95


def snare(dur=0.24, tone=192, bright=1.0, rng=None):
    rng = rng or np.random.default_rng(2)
    n = int(dur * SR)
    nz = bp(noise(n, rng), 200, 7800 * bright) * perc_env(n, decay=0.6, curve=2.6)
    tn = (sine(tone, n) + sine(tone * 1.48, n) * 0.6) * perc_env(n, decay=0.35, curve=3.4)
    return (nz * 0.85 + tn * 0.5) * 0.8


def hat(dur=0.05, open_=False, rng=None):
    rng = rng or np.random.default_rng(3)
    n = int((0.32 if open_ else dur) * SR)
    x = hp(noise(n, rng), 7000)
    return x * perc_env(n, decay=0.35 if open_ else 1.6, curve=2.2) * 0.42


def clap(rng=None):
    rng = rng or np.random.default_rng(4)
    n = int(0.30 * SR)
    out = np.zeros(n)
    for i, d in enumerate((0.0, 0.009, 0.019)):
        s = int(d * SR)
        seg = bp(noise(n - s, rng), 700, 5200) * perc_env(n - s, decay=1.6, curve=3.0)
        out[s:] += seg * (1.0 - i * 0.22)
    tail = bp(noise(n, rng), 700, 3600) * perc_env(n, decay=0.5, curve=2.0) * 0.35
    return (out + tail) * 0.5


def rim(rng=None):
    rng = rng or np.random.default_rng(5)
    n = int(0.09 * SR)
    return (bp(noise(n, rng), 1400, 5200) * perc_env(n, decay=2.4, curve=3.0)
            + sine(880, n) * perc_env(n, decay=3.0, curve=3.0) * 0.4) * 0.5


def tom(f=140, dur=0.3, rng=None):
    n = int(dur * SR)
    t = _t(n)
    ph = np.cumsum(TAU * (f * (1 + 0.5 * np.exp(-t * 24))) / SR)
    return np.sin(ph) * perc_env(n, decay=1.0, curve=1.8) * 0.7


def shaker(rng=None):
    rng = rng or np.random.default_rng(6)
    n = int(0.07 * SR)
    return hp(noise(n, rng), 5200) * perc_env(n, decay=1.4, curve=2.4) * 0.3


# ============================================================ 楽器
def sub_bass(f, dur, drive=1.4):
    n = int(dur * SR)
    x = sine(f, n) + sine(f * 2, n) * 0.22
    x = np.tanh(x * drive) / np.tanh(drive)
    return x * adsr(n, 0.006, 0.05, 0.85, min(0.12, dur * 0.3))


def reese(f, dur, cutoff=900):
    """わずかにデチューンしたノコギリ2枚。うねりが出る定番のベース。"""
    n = int(dur * SR)
    x = saw(f, n) + saw(f * 1.006, n) * 0.9 + saw(f * 0.994, n) * 0.9
    x = reso_lp(x, cutoff, q=2.2)
    return x * adsr(n, 0.008, 0.09, 0.7, min(0.15, dur * 0.35)) * 0.33


def pluck(f, dur, cutoff=2600, q=3.0):
    n = int(dur * SR)
    x = saw(f, n) * 0.7 + square(f, n) * 0.3
    x = reso_lp(x, cutoff, q=q)
    return x * perc_env(n, decay=0.9, curve=2.0) * 0.3


def pad(f, dur, detune=0.004, cutoff=2200):
    n = int(dur * SR)
    x = np.zeros(n)
    for k, g in ((1 - detune, 0.9), (1.0, 1.0), (1 + detune, 0.9), (2.0, 0.28)):
        x += saw(f * k, n) * g
    x = lp(x, cutoff)
    return x * adsr(n, min(0.35, dur * 0.4), 0.25, 0.75, min(0.6, dur * 0.5)) * 0.16


def bell(f, dur):
    n = int(dur * SR)
    x = (sine(f, n) + sine(f * 2.01, n) * 0.5 + sine(f * 3.03, n) * 0.22
         + sine(f * 4.7, n) * 0.10)
    return x * perc_env(n, decay=0.45, curve=1.2) * 0.26


def lead_sqr(f, dur, cutoff=3200):
    n = int(dur * SR)
    x = square(f, n) * 0.6 + saw(f * 1.004, n) * 0.5
    x = reso_lp(x, cutoff, q=2.6)
    return x * adsr(n, 0.006, 0.07, 0.72, min(0.14, dur * 0.35)) * 0.26


def lead_sine(f, dur):
    n = int(dur * SR)
    x = sine(f, n) + sine(f * 2, n) * 0.30 + sine(f * 3, n) * 0.10
    return x * adsr(n, 0.02, 0.12, 0.7, min(0.25, dur * 0.4)) * 0.30


# ==================================== ファンク向けの音源（SODA DRIFT / CHROME SPRINT 用）
#
# 参考3曲との差で最後まで埋まらなかったのが「打点/持続 比」だった
# （参考 -2.2〜-3.6dB に対しゲーム曲 -3.2〜-5.7dB）。原因は素材側で、
#   * 和音を伸ばすパッドで書いていた       → 持続の側が重い
#   * 高域を「常時鳴るノイズの層」で埋めた  → 持続かつ高域の床も上がる
# の2つ。ここから下の音源は、どれも「短く切れる」ことを条件に作ってある。
# 高域は連続した層ではなく、点（パチパチ・タンバリン・スクラッチ）で埋める。

def horn(f, dur, bright=1.0):
    """管楽器のスタブ。参考曲で5〜6dB厚かった 1〜2kHz は、ここに芯がある。
    立ち上がりに 12ms の「ため」を作るとブラスらしく鳴る。"""
    n = int(dur * SR)
    x = saw(f, n) * 0.9 + saw(f * 2.003, n) * 0.32 + square(f, n) * 0.22
    body = bp(x, 320, 3000 * bright, 2)
    x = x * 0.30 + body * 1.15
    e = adsr(n, 0.012, 0.050, 0.45, min(0.09, dur * 0.42))
    x = x * e
    # 吹き始めの息。管を鳴らすときの一瞬の雑音で、これが打点として数えられる。
    bn = min(n, int(0.016 * SR))
    x[:bn] += (bp(noise(bn, np.random.default_rng(int(f) % 6011)), 900, 6000, 2)
               * np.exp(-np.linspace(0, 5, bn)) * 0.22)
    return x * 0.26


def clav(f, dur):
    """クラビ。低域を持たせず中高だけの粒にするので、刻んでも濁らない。"""
    n = int(dur * SR)
    x = square(f, n) * 0.7 + saw(f * 1.002, n) * 0.5
    x = hp(reso_lp(x, 3800, q=4.0), 240)
    return x * perc_env(n, decay=1.6, curve=2.6) * 0.30


# 母音のフォルマント（F1, F2, F3）。声そのものは使わず、
# ノコギリ波をこの3つの山で整形して「声のような粒」を作る。
FORMANTS = {"a": (720, 1240, 2540), "e": (500, 1750, 2480),
            "i": (300, 2300, 3000), "o": (500, 900, 2400), "u": (320, 800, 2560)}


def vox_chop(f, dur, vowel="a", tau=0.068):
    """チョップした声のような短い粒。1〜2kHz を埋めるうえに、必ず短く切れる。

    包絡は「音符の長さに対する割合」ではなく秒で決める。割合で書くと、
    長いスロットに置いたときだけ持続音になり、HPSS の持続側に回ってしまう。
    頭の子音（短い高域のノイズ）は、これ自体が打点として数えられる。"""
    n = int(dur * SR)
    src = saw(f, n) * 0.8 + square(f, n) * 0.2
    f1, f2, f3 = FORMANTS[vowel]
    x = (bp(src, f1 * 0.80, f1 * 1.25, 2)
         + bp(src, f2 * 0.85, f2 * 1.20, 2) * 0.55
         + bp(src, f3 * 0.85, f3 * 1.20, 2) * 0.26
         + src * 0.10)
    t = _t(n)
    e = np.exp(-t / tau)
    at = max(2, int(0.004 * SR))
    e[:at] *= np.linspace(0, 1, at)
    x = x * e
    cn = min(n, int(0.014 * SR))
    x[:cn] += (bp(noise(cn, np.random.default_rng(int(f) % 7919)), 1800, 8000, 2)
               * np.exp(-np.linspace(0, 7, cn)) * 0.30)
    return x * 0.52


def scratch(dur=0.20, f=300, rng=None):
    """レコードをこする音。短い素材を、速度を折り返しながら読む（バリスピード）。
    高域が一瞬だけ突き抜けるので、床を上げずにきらびやかさが出る。"""
    rng = rng or np.random.default_rng(9)
    n = int(dur * SR)
    m = int(0.5 * SR)
    src = bp(noise(m, rng), 250, 5200) * 0.8 + saw(f, m) * 0.25
    t = np.linspace(0, 1, n)
    pos = np.cumsum(np.sin(TAU * 1.5 * t) * 2.6)      # 前へ速く → 折り返す
    pos -= pos.min()
    pos *= (m - 2) / max(pos.max(), 1e-9)
    x = np.interp(pos, np.arange(m), src)
    return x * perc_env(n, decay=0.6, curve=1.2) * 0.45


def crackle(n, rng, per_sec=42, gain=1.0):
    """レコードのパチパチ。連続したノイズの層と違って点で鳴るので、
    高域の床（10パーセンタイル/中央値）を上げない。"""
    out = np.zeros(n)
    for p in rng.integers(0, max(1, n - 128), int(n / SR * per_sec)):
        ln = int(rng.integers(24, 90))
        out[p:p + ln] += (rng.standard_normal(ln)
                          * np.exp(-np.linspace(0, 5, ln)) * rng.uniform(0.3, 1.0))
    return bp(out, 1200, 9000, 2) * 0.35 * gain


def tamb(rng=None):
    rng = rng or np.random.default_rng(12)
    n = int(0.11 * SR)
    x = hp(noise(n, rng), 5800)
    for fq in (6200, 7400, 9100):
        x += sine(fq, n) * 0.05
    return x * perc_env(n, decay=1.1, curve=2.0) * 0.30


def ride(rng=None):
    rng = rng or np.random.default_rng(13)
    n = int(0.55 * SR)
    x = hp(noise(n, rng), 6500) * 0.5
    for fq in (3100, 4300, 5700, 7900):
        x += sine(fq, n) * 0.08
    return x * perc_env(n, decay=0.30, curve=1.0) * 0.20


def conga(f=230, dur=0.22, rng=None):
    rng = rng or np.random.default_rng(14)
    n = int(dur * SR)
    ph = np.cumsum(TAU * (f * (1 + 0.35 * np.exp(-_t(n) * 38))) / SR)
    skin = hp(noise(n, rng), 2500) * perc_env(n, decay=4.0, curve=3.0) * 0.35
    return (np.sin(ph) * perc_env(n, decay=1.3, curve=2.0) + skin) * 0.50


def cowbell():
    n = int(0.18 * SR)
    x = square(540, n) * 0.5 + square(800, n) * 0.4
    return bp(x, 450, 3200, 2) * perc_env(n, decay=1.6, curve=2.2) * 0.26


def fbass(f, dur, cutoff=1500, tau=0.075):
    """指弾きのファンクベース。参考曲は 20〜60Hz が 6〜10dB 少なく、
    そのぶん 150Hz〜1kHz に芯がある。55Hz 以下を落としてその形に寄せる。

    ベースは「打点/持続 比」を一番落とす層だった（単体で -16dB）。
    ピッチのある音を伸ばすと、HPSS はそれを丸ごと持続側に数えるため。
    そこで包絡を秒で決め打ちして必ず 0.2 秒以内に減衰させ、頭に
    指が弦に当たる打点を足して、打点側に立つようにしてある。"""
    n = int(dur * SR)
    x = saw(f, n) * 0.75 + square(f, n) * 0.25 + sine(f * 2, n) * 0.30
    x = hp(reso_lp(x, cutoff, q=3.2), 55)
    t = _t(n)
    e = np.exp(-t / tau) * 0.88 + np.exp(-t / (tau * 0.22)) * 0.30
    at = max(2, int(0.003 * SR))
    e[:at] *= np.linspace(0, 1, at)
    x = x * e
    pk = min(n, int(0.013 * SR))
    x[:pk] += (bp(noise(pk, np.random.default_rng(int(f) % 9973)), 700, 4200, 2)
               * np.exp(-np.linspace(0, 6, pk)) * 0.50)
    return x * 0.34


# ============================================================ 骨組み
class Song:
    def __init__(self, name, bpm, swing=0.0, seed=1):
        assert (7680 * SR) % bpm == 0, f"{bpm}BPM はループ長がサンプル単位で割り切れない"
        self.name = name
        self.bpm = bpm
        self.beat = 60.0 / bpm
        self.bar = self.beat * 4
        self.step = self.beat / 4                 # 16分
        self.swing = swing * self.step
        self.n = int(round(BARS * self.bar * SR))
        self.rng = np.random.default_rng(seed)
        self.stems = {k: np.zeros((self.n, 2)) for k in
                      ("01_drums", "02_bass", "03_chords", "04_melody", "05_atmos")}

    def at(self, bar, step):
        """小節番号と16分番号からサンプル位置を出す（裏拍はスウィングぶん後ろ）。"""
        s = (bar * 16 + step)
        sw = self.swing if step % 2 else 0.0
        return int(round((bar * self.bar + step * self.step + sw) * SR))

    def put(self, stem, x, bar, step, gain=1.0, pan=0.0):
        place(self.stems[stem], x, self.at(bar, step), gain, pan)

    def section(self, bar):
        return 0 if bar < 8 else 1 if bar < 16 else 2 if bar < 24 else 3 if bar < 28 else 4


def hits(pattern):
    """"x..x..x." のような16分の文字列から、鳴る位置の一覧を返す。"""
    return [i for i, c in enumerate(pattern) if c not in "._ -"]


# ============================================================ 曲1 NEON MARCH
def neon_march():
    """120 BPM / 4つ打ちテクノ。掃引 4.000 秒。
    A エオリアン。1拍目の重心がはっきりしていて、掃引の頭が体で分かる曲。"""
    s = Song("NEON_MARCH", 120, swing=0.0, seed=11)
    rv = make_reverb(1.5, 4.6, rng=s.rng)
    # Am - F - C - G を2小節ずつ、8小節で一巡
    PROG = [(57, [57, 60, 64, 67]), (53, [53, 57, 60, 65]),
            (48, [48, 55, 60, 64]), (55, [55, 59, 62, 67])]

    K = kick(0.34, 128, 46, rng=s.rng)
    C = clap(s.rng)
    HC = hat(0.045, False, s.rng)
    HO = hat(open_=True, rng=s.rng)
    SH = shaker(s.rng)

    for bar in range(BARS):
        sec = s.section(bar)
        ch_i = (bar // 2) % 4
        root, chord = PROG[ch_i]

        # --- ドラム ---
        if sec != 3 or bar >= 26:                       # ブレイクはキックを抜く
            for st in (0, 4, 8, 12):
                s.put("01_drums", K, bar, st, 1.0)
        if sec >= 1:
            for st in (4, 12):
                s.put("01_drums", C, bar, st, 0.85, pan=0.05)
        if sec >= 1:
            for st in range(0, 16, 2):
                s.put("01_drums", HC, bar, st, 0.55 if st % 4 == 0 else 0.4,
                      pan=0.18 if st % 4 else -0.12)
        if sec >= 2:
            for st in (2, 6, 10, 14):
                s.put("01_drums", HO, bar, st, 0.30, pan=0.22)
        if sec >= 2:
            for st in (1, 5, 7, 9, 13, 15):
                s.put("01_drums", SH, bar, st, 0.30, pan=-0.25)
        if bar % 8 == 7:                                 # 8小節ごとのフィル
            for i, st in enumerate((10, 12, 13, 14, 15)):
                s.put("01_drums", tom(180 - i * 18, 0.22, s.rng), bar, st,
                      0.55, pan=-0.3 + i * 0.15)

        # --- ベース: 裏拍で跳ねる4つ打ちの定番 ---
        for st in (2, 6, 10, 14):
            s.put("02_bass", sub_bass(midi(root - 12), s.step * 1.6), bar, st, 0.85)
        if sec >= 2:
            for st in (0, 8):
                s.put("02_bass", reese(midi(root), s.step * 2.2, 700), bar, st, 0.5)

        # --- コード: 2拍4拍の「ウラ」で刺す ---
        if sec >= 1:
            for st in (6, 14):
                for i, m in enumerate(chord):
                    s.put("03_chords", pluck(midi(m + 12), s.step * 2.4, 2800),
                          bar, st, 0.55, pan=(i - 1.5) * 0.16)
        if sec >= 1:
            for m in chord:
                s.put("03_chords", pad(midi(m), s.bar * 0.95, cutoff=1800),
                      bar, 0, 0.5 if sec == 1 else 0.7)

        # --- メロディ: 上がって落ちる4小節のフック ---
        if sec >= 2:
            HOOK = [(0, 0, 3), (3, 4, 1), (4, 7, 2), (6, 12, 2), (8, 7, 2),
                    (10, 4, 3), (13, 3, 3)]
            SCALE = [0, 2, 3, 5, 7, 8, 10]
            for st, deg, ln in HOOK:
                oc, d = divmod(deg, 7)
                m = 57 + oc * 12 + SCALE[d]
                s.put("04_melody", lead_sqr(midi(m), s.step * ln, 3600),
                      bar, st, 0.8 if sec == 2 else 1.0, pan=0.08)

    # --- 空気の層: 常時鳴る静かな高域のベッド + 8小節ごとの上昇 ---
    air = hp(noise(s.n, s.rng), 3600) * 0.030
    air *= 1 + 0.35 * np.sin(TAU * np.arange(s.n) / (s.bar * 4 * SR))
    s.stems["05_atmos"] += widen(air, 0.75, 14)
    for bar in range(0, BARS, 8):
        n = int(s.bar * 2 * SR)
        sweep = hp(noise(n, s.rng), 900) * np.linspace(0, 1, n) ** 3 * 0.05
        place(s.stems["05_atmos"], widen(sweep, 0.6, 9), s.at(bar + 6, 0))

    s.stems["03_chords"] = reverb(s.stems["03_chords"], rv, 0.30)
    s.stems["04_melody"] = pingpong(s.stems["04_melody"], s.step * 3, 0.3, 0.22)
    return s


# ============================================================ 曲2 CIRCUIT RUSH
def circuit_rush():
    """112 BPM / エレクトロ・ブレイクス。掃引 4.286 秒。
    E エオリアン。裏で跳ねるので、置く位置をずらす面白さが出る。"""
    s = Song("CIRCUIT_RUSH", 112, swing=0.09, seed=23)
    rv = make_reverb(1.3, 5.2, rng=s.rng)
    PROG = [(52, [52, 55, 59, 62]), (48, [48, 52, 55, 60]),
            (55, [55, 59, 62, 66]), (50, [50, 53, 57, 60])]

    K = kick(0.30, 140, 48, click=0.8, rng=s.rng)
    SN = snare(0.22, 205, 1.0, s.rng)
    SNq = snare(0.12, 230, 0.7, s.rng)
    HC = hat(0.04, False, s.rng)
    RM = rim(s.rng)

    # ブレイクビーツ: キックは 1 と「2の裏」、スネアは 2 と 4
    KICK_P = "x.....x...x....."
    SNR_P = "....x.......x..."
    GHOST = "..x....x..x..x.x"

    for bar in range(BARS):
        sec = s.section(bar)
        root, chord = PROG[(bar // 2) % 4]

        if sec != 3 or bar >= 26:
            for st in hits(KICK_P):
                s.put("01_drums", K, bar, st, 1.0)
        for st in hits(SNR_P):
            s.put("01_drums", SN, bar, st, 0.9, pan=0.04)
        if sec >= 1:
            for st in hits(GHOST):
                s.put("01_drums", SNq, bar, st, 0.20, pan=-0.1)
        if sec >= 1:
            for st in range(16):
                if st % 2 == 0 or sec >= 2:
                    s.put("01_drums", HC, bar, st,
                          0.5 if st % 4 == 0 else 0.28, pan=0.2 if st % 2 else -0.15)
        if sec >= 2:
            for st in (3, 11):
                s.put("01_drums", RM, bar, st, 0.5, pan=-0.3)
        if bar % 8 == 7:
            for i, st in enumerate((12, 13, 14, 15)):
                s.put("01_drums", SNq, bar, st, 0.45 + i * 0.12, pan=(i - 1.5) * 0.2)

        # --- ベース: シンコペーションの効いたエレクトロ ---
        BASS_P = [(0, 2), (3, 1), (6, 2), (10, 1), (11, 2), (14, 2)]
        for st, ln in BASS_P:
            f = midi(root - 12 if st in (0, 6) else root - 12 + (7 if st == 11 else 0))
            s.put("02_bass", sub_bass(f, s.step * ln, 1.8), bar, st, 0.8)
        if sec >= 2:
            for st in (0, 8):
                s.put("02_bass", reese(midi(root), s.step * 3, 620), bar, st, 0.45)

        # --- コード: 短いプラックを裏に散らす ---
        if sec >= 1:
            for st in (2, 7, 10, 15):
                for i, m in enumerate(chord):
                    s.put("03_chords", pluck(midi(m + 12), s.step * 1.6, 3200, 3.6),
                          bar, st, 0.42, pan=(i - 1.5) * 0.2)
        if sec >= 1:
            for m in chord:
                s.put("03_chords", pad(midi(m - 12), s.bar * 0.9, cutoff=1400),
                      bar, 0, 0.45)

        # --- メロディ: 跳ねる短いフレーズ ---
        if sec >= 2:
            SCALE = [0, 2, 3, 5, 7, 8, 10]
            HOOK = [(0, 4, 2), (2, 7, 1), (3, 6, 1), (4, 4, 2), (7, 2, 1),
                    (8, 4, 2), (11, 9, 2), (14, 7, 2)]
            for st, deg, ln in HOOK:
                oc, d = divmod(deg, 7)
                m = 52 + oc * 12 + SCALE[d]
                s.put("04_melody", lead_sqr(midi(m), s.step * ln, 4200),
                      bar, st, 0.9, pan=-0.06)

    air = hp(noise(s.n, s.rng), 4200) * 0.026
    s.stems["05_atmos"] += widen(air, 0.8, 11)
    for bar in range(0, BARS, 8):
        n = int(s.bar * SR)
        rise = bp(noise(n, s.rng), 400, 6000) * np.linspace(0, 1, n) ** 2.4 * 0.045
        place(s.stems["05_atmos"], widen(rise, 0.7, 8), s.at(bar + 7, 0))

    s.stems["03_chords"] = reverb(s.stems["03_chords"], rv, 0.26)
    s.stems["04_melody"] = pingpong(s.stems["04_melody"], s.step * 3, 0.34, 0.26)
    return s


# ============================================================ 曲3 GLASS TIDE
def glass_tide():
    """84 BPM / ダウンテンポ・ダブ。掃引 5.714 秒。
    D ドリアン。掃引が遅いので、大きい正方形を組む回に向く。"""
    s = Song("GLASS_TIDE", 84, swing=0.14, seed=37)
    rv = make_reverb(2.6, 3.0, top=3400, rng=s.rng)
    PROG = [(50, [50, 57, 60, 64]), (55, [55, 58, 62, 65]),
            (58, [58, 62, 65, 69]), (57, [57, 60, 64, 67])]

    K = kick(0.46, 96, 38, click=0.25, rng=s.rng)
    RM = rim(s.rng)
    SN = snare(0.28, 168, 0.55, s.rng)
    HC = hat(0.055, False, s.rng)

    # ハーフタイム: キックは1、スネアは3拍目だけ
    for bar in range(BARS):
        sec = s.section(bar)
        root, chord = PROG[(bar // 2) % 4]

        if sec != 3 or bar >= 26:
            s.put("01_drums", K, bar, 0, 1.0)
            if sec >= 2:
                s.put("01_drums", K, bar, 10, 0.7)
        s.put("01_drums", SN, bar, 8, 0.72, pan=0.05)
        if sec >= 1:
            for st in (3, 6, 11, 14):
                s.put("01_drums", RM, bar, st, 0.34, pan=-0.28 if st % 4 else 0.24)
        if sec >= 1:
            for st in range(2, 16, 4):
                s.put("01_drums", HC, bar, st, 0.26, pan=0.3)
        if bar % 8 == 7:
            s.put("01_drums", SN, bar, 14, 0.5, pan=-0.2)

        # --- ベース: 長く伸ばすサブ。動かさないことで水面の感じを出す ---
        s.put("02_bass", sub_bass(midi(root - 12), s.bar * 0.62, 1.2), bar, 0, 0.9)
        if sec >= 2:
            s.put("02_bass", sub_bass(midi(root - 12 + 7), s.step * 3, 1.2), bar, 11, 0.5)

        # --- コード: 立ち上がりの遅いパッド ---
        for m in chord:
            s.put("03_chords", pad(midi(m), s.bar * 1.35, 0.006, 1500), bar, 0,
                  0.6 if sec >= 1 else 0.35)
        if sec >= 2:
            for i, m in enumerate(chord):
                s.put("03_chords", bell(midi(m + 12), 0.9), bar, 6 + i,
                      0.30, pan=(i - 1.5) * 0.3)

        # --- メロディ: 間を空けた鐘のモチーフ ---
        if sec >= 2:
            SCALE = [0, 2, 3, 5, 7, 9, 10]        # D ドリアン
            HOOK = [(0, 4, 4), (5, 7, 3), (9, 6, 2), (12, 4, 4)]
            if bar % 4 in (2, 3):
                HOOK = [(2, 9, 3), (6, 7, 3), (11, 4, 5)]
            for st, deg, ln in HOOK:
                oc, d = divmod(deg, 7)
                m = 50 + oc * 12 + SCALE[d]
                s.put("04_melody", lead_sine(midi(m), s.step * ln), bar, st, 0.9)

    air = lp(hp(noise(s.n, s.rng), 2200), 11000) * 0.034
    air *= 1 + 0.5 * np.sin(TAU * np.arange(s.n) / (s.bar * 8 * SR) + 1.1)
    s.stems["05_atmos"] += widen(air, 0.9, 20)
    for bar in range(0, BARS, 16):
        n = int(s.bar * 3 * SR)
        wash = lp(noise(n, s.rng), 1400) * np.hanning(n) * 0.05
        place(s.stems["05_atmos"], widen(wash, 0.8, 24), s.at(bar + 13, 0))

    s.stems["03_chords"] = reverb(s.stems["03_chords"], rv, 0.42)
    s.stems["04_melody"] = reverb(pingpong(s.stems["04_melody"], s.step * 3, 0.42, 0.34),
                                  rv, 0.30)
    return s


# ============================================================ 曲4 SODA DRIFT
def soda_drift():
    """128 BPM / ビッグビート・ファンク。掃引 3.750 秒。G マイナー（B♭ メジャー系）。

    参考3曲の共通項（PRISM_SHUFFLE/ANALYSIS.md 第2節）を編曲の条件にしてある:
      * 和音は小節ごとに動かす。maj7 / m9 / sus4 を混ぜる
      * 伸ばさない。和音はスタブ、高域は点で置く
      * 1〜2kHz を痩せさせない（ブラスとクラビがこの帯域の芯）
      * 4〜8小節で必ず何かが入れ替わる
    旋律・和音進行・リズムはすべて書き下ろしで、参考曲からは写していない。
    """
    s = Song("SODA_DRIFT", 128, swing=0.10, seed=51)
    rv = make_reverb(1.1, 6.0, top=3800, rng=s.rng)
    # 短くて明るい「部屋鳴り」。参考曲の高域の床（0.12〜0.36）は、
    # 常時鳴るノイズではなく打楽器の余韻でできている。連続した層を足さずに
    # ここを埋めたいので、打楽器だけに薄い部屋を掛ける。
    room = make_reverb(0.24, 14.0, pre=0.005, top=9500, rng=s.rng)

    # (ベースの根音, スタブの和音)。8小節で一巡し、毎小節動く。
    PROG = [
        (43, [58, 62, 65, 69]),   # Gm9      B♭ D F A
        (39, [58, 62, 63, 67]),   # E♭maj7   B♭ D E♭ G
        (48, [55, 58, 60, 63]),   # Cm7      G B♭ C E♭
        (41, [57, 60, 63, 65]),   # F9sus4   A C E♭ F
        (43, [58, 62, 65, 70]),   # Gm11     B♭ D F B♭
        (46, [58, 62, 65, 69]),   # B♭6/9    B♭ D F A
        (39, [58, 63, 67, 70]),   # E♭maj7   B♭ E♭ G B♭
        (50, [57, 62, 65, 69]),   # Dm7      A D F A
    ]

    K = kick(0.26, 138, 50, click=0.85, rng=s.rng)
    SN = snare(0.22, 198, 1.05, s.rng)
    GH = snare(0.10, 240, 0.6, s.rng)
    HC = hat(0.038, False, s.rng)
    HO = hat(open_=True, rng=s.rng)
    RM = rim(s.rng)
    TB = tamb(s.rng)
    CB = cowbell()
    CG = [conga(f, 0.20, s.rng) for f in (300, 230, 175)]

    # ビッグビートらしい、キックが跳ねてスネアが 2・4 に立つ break
    KICK_P = "x.....x..x..x..."
    SNR_P = "....x.......x..."
    GHOST_P = "..x..x.x..x...x."

    for bar in range(BARS):
        sec = s.section(bar)
        root, chord = PROG[bar % 8]

        # --- ドラム ---
        if sec != 3 or bar >= 26:
            for st in hits(KICK_P):
                s.put("01_drums", K, bar, st, 1.0)
            if sec >= 2 and bar % 2 == 1:
                s.put("01_drums", K, bar, 14, 0.7)
        for st in hits(SNR_P):
            s.put("01_drums", SN, bar, st, 0.95, pan=0.03)
        if sec >= 1:
            for st in hits(GHOST_P):
                s.put("01_drums", GH, bar, st, 0.22, pan=-0.12)
        for st in range(16):
            if st % 2 == 0 or sec >= 1:
                s.put("01_drums", HC, bar, st,
                      0.52 if st % 4 == 0 else 0.26, pan=0.20 if st % 2 else -0.14)
        s.put("01_drums", HO, bar, 14, 0.34, pan=0.24)
        if sec >= 2:
            for st in (3, 11):
                s.put("01_drums", RM, bar, st, 0.42, pan=-0.30)
        if bar % 8 == 7:                                  # 8小節ごとのフィル
            for i, st in enumerate((10, 11, 12, 13, 14, 15)):
                s.put("01_drums", GH, bar, st, 0.35 + i * 0.11, pan=(i - 2.5) * 0.14)

        # --- ベース: 16分で刻む指弾き。跳ねる位置に休符を置いて前へ進める ---
        # 休符が2ステップ以上あくように置く。ベースが途切れないと、
        # 1音1音を短くしても HPSS は「ずっと鳴っている持続音」と数える。
        BASS_P = [(0, 2), (3, 1), (4, 2), (7, 2), (10, 2), (13, 2)]
        for st, ln in BASS_P:
            deg = {0: 0, 3: 7, 4: 0, 7: 12, 10: 0, 13: 10}[st]
            s.put("02_bass", fbass(midi(root + deg), s.step * ln * 0.90, tau=0.055),
                  bar, st, 0.92)
        s.put("02_bass", sub_bass(midi(root - 12), s.step * 2.2, 1.3), bar, 0, 0.55)

        # --- 和音: 伸ばさない。ブラスのスタブとクラビの刻みだけ ---
        if sec >= 1:
            for st, g in ((2, 0.9), (6, 0.6), (11, 0.85), (14, 0.5)):
                for i, m in enumerate(chord):
                    s.put("03_chords", horn(midi(m), s.step * 1.05),
                          bar, st, g, pan=(i - 1.5) * 0.15)
            for st in (0, 3, 5, 8, 10, 13, 15):
                for i, m in enumerate(chord[1:]):
                    s.put("03_chords", clav(midi(m + 12), s.step * 0.85),
                          bar, st, 0.36 if st % 4 else 0.5, pan=(i - 1) * 0.26)

        # --- 旋律: 声を刻んだような粒と、合いの手のスクラッチ ---
        if sec >= 2:
            SCALE = [0, 2, 3, 5, 7, 8, 10]                # G エオリアン
            HOOK = ([(0, 7, 2, "a"), (2, 9, 1, "e"), (3, 7, 1, "a"), (5, 4, 2, "o"),
                     (8, 7, 2, "a"), (10, 11, 2, "i"), (13, 9, 3, "o")]
                    if bar % 4 < 2 else
                    [(1, 4, 2, "o"), (4, 7, 1, "a"), (5, 8, 1, "e"), (6, 7, 2, "a"),
                     (9, 4, 2, "o"), (12, 2, 4, "u")])
            for st, deg, ln, vw in HOOK:
                oc, d = divmod(deg, 7)
                s.put("04_melody", vox_chop(midi(55 + oc * 12 + SCALE[d]),
                                            s.step * ln * 0.9, vw),
                      bar, st, 0.85, pan=0.06)
            if bar % 4 == 3:
                s.put("04_melody", scratch(0.18, 340, s.rng), bar, 12, 0.9, pan=-0.3)
                s.put("04_melody", scratch(0.13, 460, s.rng), bar, 14, 0.75, pan=0.34)

    # --- 05_atmos: 常時鳴る層だが、ノイズのベッドではなく「打楽器と点」で作る。
    #     ここを持続音にしないことが、打点/持続 比と高域の床の両方に効く。 ---
    s.stems["05_atmos"] += widen(crackle(s.n, s.rng, 46), 0.55, 7)
    for bar in range(BARS):
        sec = s.section(bar)
        for st in range(0, 16, 2):                       # タンバリンの8分
            s.put("05_atmos", TB, bar, st, 0.36 if st % 4 == 0 else 0.24,
                  pan=0.28 if st % 4 else -0.2)
        if sec >= 1:
            for i, st in enumerate((1, 5, 6, 9, 13, 15)):
                s.put("05_atmos", CG[i % 3], bar, st, 0.34, pan=-0.34 + (i % 3) * 0.3)
        if sec >= 2 and bar % 2 == 0:
            for st in (4, 12):
                s.put("05_atmos", CB, bar, st, 0.26, pan=0.3)
        if bar % 8 == 6:                                 # 上がる合図は2小節ではなく半小節
            s.put("05_atmos", scratch(0.26, 260, s.rng), bar, 12, 0.5, pan=0.0)

    s.stems["01_drums"] = reverb(s.stems["01_drums"], room, 0.065)
    s.stems["05_atmos"] = reverb(s.stems["05_atmos"], room, 0.090)
    s.stems["03_chords"] = reverb(s.stems["03_chords"], rv, 0.16)
    s.stems["04_melody"] = pingpong(s.stems["04_melody"], s.step * 3, 0.24, 0.14)
    return s


# ============================================================ 曲5 CHROME SPRINT
def chrome_sprint():
    """140 BPM / ファンク・ブレイクス。掃引 3.429 秒。C マイナー（E♭ メジャー系）。

    SODA DRIFT と同じ条件で、より速く・より細かく刻んだ側。
    参考曲の一番速いもの（139.7 BPM）と同じテンポ帯に置いてある。
    素材の主音は PRISM SHUFFLE と同じ集合なので、操作音の移調は 0。
    """
    s = Song("CHROME_SPRINT", 140, swing=0.06, seed=67)
    rv = make_reverb(0.9, 7.0, top=3600, rng=s.rng)
    room = make_reverb(0.20, 16.0, pre=0.004, top=10000, rng=s.rng)

    PROG = [
        (36, [55, 58, 62, 63]),   # Cm9      G B♭ D E♭
        (44, [55, 60, 63, 67]),   # A♭maj7   G C E♭ G
        (46, [58, 62, 65, 68]),   # B♭7      B♭ D F A♭
        (43, [58, 62, 65, 67]),   # Gm7      B♭ D F G
        (36, [55, 58, 63, 65]),   # Cm11     G B♭ E♭ F
        (41, [56, 60, 63, 68]),   # Fm9      A♭ C E♭ A♭
        (44, [56, 60, 63, 70]),   # A♭maj9   A♭ C E♭ B♭
        (46, [58, 62, 63, 68]),   # B♭7sus4  B♭ D E♭ A♭
    ]

    K = kick(0.26, 145, 50, click=0.9, rng=s.rng)
    SN = snare(0.18, 215, 1.1, s.rng)
    GH = snare(0.08, 250, 0.65, s.rng)
    HC = hat(0.032, False, s.rng)
    HO = hat(open_=True, rng=s.rng)
    RD = ride(s.rng)
    TB = tamb(s.rng)
    CG = [conga(f, 0.17, s.rng) for f in (330, 250, 190)]

    # 速いブレイク。スネアを 2・4 に置いたまま、キックを16分でずらす
    KICK_P = "x..x....x.x....."
    SNR_P = "....x.......x..."
    GHOST_P = ".x..x.x..x.x..x."

    for bar in range(BARS):
        sec = s.section(bar)
        root, chord = PROG[bar % 8]

        if sec != 3 or bar >= 26:
            for st in hits(KICK_P):
                s.put("01_drums", K, bar, st, 1.0)
            if sec >= 2:
                s.put("01_drums", K, bar, 14 if bar % 2 else 6, 0.72)
        for st in hits(SNR_P):
            s.put("01_drums", SN, bar, st, 0.95, pan=0.03)
        if sec >= 1:
            for st in hits(GHOST_P):
                s.put("01_drums", GH, bar, st, 0.24, pan=-0.14)
        for st in range(16):
            s.put("01_drums", HC, bar, st,
                  0.5 if st % 4 == 0 else (0.3 if st % 2 == 0 else 0.18),
                  pan=0.22 if st % 2 else -0.16)
        s.put("01_drums", HO, bar, 10, 0.30, pan=0.26)
        if sec >= 2:
            for st in (0, 4, 8, 12):
                s.put("01_drums", RD, bar, st, 0.30, pan=0.3)
        if bar % 4 == 3:
            for i, st in enumerate((13, 14, 15)):
                s.put("01_drums", GH, bar, st, 0.42 + i * 0.16, pan=(i - 1) * 0.24)

        # --- ベース: ほぼ16分の刻み。速い曲ほど休符が効くので3か所だけ空ける ---
        BASS_P = [(0, 2), (2, 1), (3, 2), (6, 2), (8, 1), (9, 2), (11, 1), (12, 2), (14, 2)]
        for st, ln in BASS_P:
            deg = {0: 0, 2: 12, 3: 10, 6: 7, 8: 0, 9: 3, 11: 7, 12: 0, 14: 10}[st]
            s.put("02_bass", fbass(midi(root + 12 + deg), s.step * ln * 0.88, 1700,
                                  tau=0.050), bar, st, 0.88)
        s.put("02_bass", sub_bass(midi(root), s.step * 1.8, 1.4), bar, 0, 0.5)

        # --- 和音: ブラスは短く、クラビは16分で全部 ---
        if sec >= 1:
            for st, g in ((0, 0.85), (5, 0.7), (8, 0.55), (12, 0.8)):
                for i, m in enumerate(chord):
                    s.put("03_chords", horn(midi(m), s.step * 1.2, 1.1),
                          bar, st, g, pan=(i - 1.5) * 0.16)
            for st in range(16):
                if st % 4 == 2 or st % 8 == 7 or st in (1, 10):
                    for i, m in enumerate(chord[1:]):
                        s.put("03_chords", clav(midi(m + 12), s.step * 0.75),
                              bar, st, 0.40, pan=(i - 1) * 0.28)

        # --- 旋律: 細かく走る粒。4小節ごとに入れ替える ---
        if sec >= 2:
            SCALE = [0, 2, 3, 5, 7, 8, 10]                # C エオリアン
            HOOK = ([(0, 4, 1, "a"), (1, 7, 1, "e"), (2, 9, 2, "a"), (4, 7, 1, "o"),
                     (6, 11, 2, "i"), (9, 9, 1, "e"), (10, 7, 2, "a"), (13, 4, 3, "o")]
                    if bar % 4 < 2 else
                    [(0, 9, 2, "i"), (3, 7, 1, "a"), (4, 6, 1, "e"), (5, 4, 2, "o"),
                     (8, 7, 1, "a"), (9, 9, 1, "e"), (10, 11, 2, "i"), (14, 7, 2, "a")])
            for st, deg, ln, vw in HOOK:
                oc, d = divmod(deg, 7)
                s.put("04_melody", vox_chop(midi(48 + oc * 12 + SCALE[d]),
                                            s.step * ln * 0.88, vw),
                      bar, st, 0.85, pan=-0.05)
            if bar % 4 == 1:
                s.put("04_melody", scratch(0.14, 420, s.rng), bar, 15, 0.85, pan=0.32)

    s.stems["05_atmos"] += widen(crackle(s.n, s.rng, 52), 0.5, 6)
    for bar in range(BARS):
        sec = s.section(bar)
        for st in range(16):
            if st % 4 in (0, 3):
                s.put("05_atmos", TB, bar, st, 0.34 if st % 4 == 0 else 0.22,
                      pan=0.3 if st % 8 else -0.24)
        if sec >= 1:
            for i, st in enumerate((2, 3, 7, 10, 11, 14)):
                s.put("05_atmos", CG[i % 3], bar, st, 0.32, pan=-0.32 + (i % 3) * 0.32)
        if bar % 8 == 7:
            s.put("05_atmos", scratch(0.20, 300, s.rng), bar, 13, 0.5)

    s.stems["01_drums"] = reverb(s.stems["01_drums"], room, 0.060)
    s.stems["05_atmos"] = reverb(s.stems["05_atmos"], room, 0.085)
    s.stems["03_chords"] = reverb(s.stems["03_chords"], rv, 0.13)
    s.stems["04_melody"] = pingpong(s.stems["04_melody"], s.step * 3, 0.20, 0.13)
    return s


# ============================================================ 書き出し
# 既存曲 PRISM SHUFFLE の実測バランス。4曲を切り替えて使うので、
# 音量と各層の比率はここに揃える（曲が変わるたびに音量が跳ねると疲れる）。
# 効果音の居場所（C5 より上）を空ける設計も、この比率が前提になっている。
TARGET_RMS = {
    "01_drums": 0.1420,
    "02_bass": 0.1052,
    "03_chords": 0.1002,
    "04_melody": 0.0698,
    "05_atmos": 0.0812,
}

# ファンクの2曲は層の役割が違うので、比率もそれ用にする。
#   03_chords … パッドではなくブラスとクラビの刻みで、この曲の推進力そのもの
#   05_atmos  … ノイズのベッドではなく打楽器。常時鳴る層なので出しすぎない
# 合計の音量は master.py がラウドネスで揃えるので、ここは比率だけを見る。
TARGET_RMS_FUNK = {
    "01_drums": 0.1560,
    "02_bass": 0.0880,
    "03_chords": 0.1020,
    "04_melody": 0.0690,
    "05_atmos": 0.0680,
}
FUNK = ("SODA_DRIFT", "CHROME_SPRINT")


def export(s, target_peak=0.94):
    # 原音の WAV は stems/ に置く（.gitignore の対象。配信には使わない）。
    # tools/master.py が仕上げ直して stems_master/ を作り、
    # tools/encode.py がそれを m4a/ogg にする。
    d = os.path.join(OUT_ROOT, s.name, "stems")
    os.makedirs(d, exist_ok=True)
    # 1) 層ごとに狙いの RMS へそろえ、突出したピークだけ抑える。
    #    リミッタを通すと RMS が下がるので、2回まわして狙い値に寄せる。
    tgt = TARGET_RMS_FUNK if s.name in FUNK else TARGET_RMS
    for _ in range(2):
        for k in s.stems:
            r = float(np.sqrt((s.stems[k] ** 2).mean()))
            if r > 1e-9:
                s.stems[k] = s.stems[k] * (tgt[k] / r)
            if np.abs(s.stems[k]).max() > 0.95:
                s.stems[k] = soft_limit(s.stems[k], 0.95)
    # 2) 合計のピークを抑え、同じゲイン曲線を各ステムにも掛けて合計＝本体を保つ
    raw = sum(s.stems.values())
    total = soft_limit(raw, target_peak)
    pk = np.maximum(np.abs(raw).max(1), 1e-9)
    g = np.abs(total).max(1) / pk
    print(f"\n[{s.name}] {s.bpm} BPM / {s.n} フレーム = {s.n/SR:.4f} 秒 "
          f"/ 1小節 {s.bar:.4f}s / 掃引(2小節) {s.bar*2:.3f}s")
    for k in s.stems:
        y = s.stems[k] * g[:, None]
        s.stems[k] = y
        write_wav(os.path.join(d, f"{k}.wav"), y)
        print(f"   {k:10s} peak {np.abs(y).max():.3f} rms {np.sqrt((y**2).mean()):.4f}")
    mix = sum(s.stems.values())
    r = float(np.sqrt((mix ** 2).mean()))
    print(f"   MIX        peak {np.abs(mix).max():.3f} rms {r:.4f} "
          f"crest {20*np.log10(np.abs(mix).max()/max(r,1e-9)):.1f} dB "
          f"継ぎ目 {float(np.abs(mix[-1]-mix[0]).max()):.4f}")
    write_wav(os.path.join(OUT_ROOT, s.name, "loop.wav"), mix)
    return mix


if __name__ == "__main__":
    which = sys.argv[1:] or ["neon", "circuit", "glass", "soda", "chrome"]
    fn = {"neon": neon_march, "circuit": circuit_rush, "glass": glass_tide,
          "soda": soda_drift, "chrome": chrome_sprint}
    for w in which:
        export(fn[w]())
