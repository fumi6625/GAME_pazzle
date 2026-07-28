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


def export(s, target_peak=0.94):
    d = os.path.join(OUT_ROOT, s.name)
    os.makedirs(d, exist_ok=True)
    # 1) 層ごとに狙いの RMS へそろえ、突出したピークだけ抑える。
    #    リミッタを通すと RMS が下がるので、2回まわして狙い値に寄せる。
    for _ in range(2):
        for k in s.stems:
            r = float(np.sqrt((s.stems[k] ** 2).mean()))
            if r > 1e-9:
                s.stems[k] = s.stems[k] * (TARGET_RMS[k] / r)
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
    write_wav(os.path.join(d, "loop.wav"), mix)
    return mix


if __name__ == "__main__":
    which = sys.argv[1:] or ["neon", "circuit", "glass"]
    fn = {"neon": neon_march, "circuit": circuit_rush, "glass": glass_tide}
    for w in which:
        export(fn[w]())
