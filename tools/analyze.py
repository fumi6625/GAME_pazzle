#!/usr/bin/env python3
"""参考曲とゲーム内曲を同じ物差しで測る解析器。

目的は「人が聞いたときに感じるもの」を数値に落とすこと。旋律そのものは
著作物なので絶対に写さない。ここで取るのは、聞こえ方を決める客観量だけ:

  テンポ / スウィング量        … ノリの速さと跳ね方
  16分位置ごとの打点密度        … グルーヴの骨格（どこを叩くか）
  クロマとキー / コード進行     … 明るさ・切なさの土台
  帯域バランスと傾き            … 音の明るさ、太さ
  クレスト（ピーク/実効値）      … 迫力とパンチ
  高域のウォッシュ              … きらびやかさ／刺さらなさ
  ハーモニック／パーカッシブ比  … 「歌もの」寄りか「リズムもの」寄りか
  ステレオ幅（帯域別）          … 広がり
  自己相似からの区切り          … 展開の速さ（飽きにくさ）
  オンセット密度                … 情報量（にぎやかさ）

使い方:  python3 tools/analyze.py <音声ファイル...>
        python3 tools/analyze.py --json out.json <音声ファイル...>
"""
import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np
from scipy import signal as sg

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
SR = 44100
PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# --------------------------------------------------------------- 読み込み
def load(path, sr=SR, mono=False, limit=None):
    """ffmpeg で復号して float32 の (n, 2) を返す。"""
    cmd = [FF, "-v", "error", "-i", path]
    if limit:
        cmd += ["-t", str(limit)]
    cmd += ["-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    x = np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)
    return x.mean(1) if mono else x


# --------------------------------------------------------------- 下ごしらえ
def stft(x, n=2048, hop=512):
    w = np.hanning(n)
    frames = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.fft.rfft(x[idx] * w, axis=1)


def onset_env(x, sr=SR, hop=512, band=None):
    """スペクトルフラックス。打点の立ち上がりだけを拾う。
    band=(lo, hi) を渡すと、その帯域だけを見る。
    キック(30-120Hz) / スネア(150-400Hz) / ハイハット(6-12kHz) のように
    帯域を分けると、それぞれの楽器がどの16分を叩いているかが読める。"""
    n = 2048
    S = np.abs(stft(x, n, hop))
    if band:
        f = np.fft.rfftfreq(n, 1 / sr)
        S = S[:, (f >= band[0]) & (f < band[1])]
    # 対数にすると小さい打点も同じ重みで見える（人の耳に近い）
    S = np.log1p(S * 10)
    d = np.diff(S, axis=0)
    return np.maximum(d, 0).sum(1)


# 打楽器の帯域。ここを分けて見ると「誰がどこを叩いているか」が分かる
DRUM_BANDS = {"キック": (30, 120), "スネア/クラップ": (150, 450), "ハット/シェイカー": (6000, 13000)}


# --------------------------------------------------------------- テンポ
def _beat_strength(env, fps, bpm, phase, offset=0.0):
    """拍位置（offset 拍ぶんずらした点）に乗っている打点の平均の強さ。"""
    per = 60.0 / bpm * fps
    n = int((len(env) - phase * fps) / per)
    if n < 4:
        return 0.0
    idx = (phase * fps + (np.arange(n) + offset) * per).round().astype(int)
    idx = idx[(idx >= 1) & (idx < len(env) - 1)]
    if len(idx) < 4:
        return 0.0
    # 前後1フレームまで許容（検出のぶれを吸収）
    return float(np.maximum.reduce([env[idx - 1], env[idx], env[idx + 1]]).mean())


def tempo(x, sr=SR, hop=512, lo=70, hi=190):
    """オンセット包絡の自己相関から BPM と拍位相を求める。

    自己相関だけだと必ず「半分の BPM」に引っ張られる（拍が少ないほど
    1拍あたりの打点が強く見えるため）。そこで候補ごとに
    「拍の真ん中にも同じくらい打点があるか」を見て、あるなら倍を採る。
    これは人が『ここが4分音符』と感じる判断とほぼ同じ。
    """
    env = onset_env(x, sr, hop)
    env = np.maximum(env - np.median(env), 0)
    fps = sr / hop
    e = env - env.mean()
    ac = np.correlate(e, e, "full")[len(e) - 1:]
    lags = np.arange(len(ac)) / fps
    with np.errstate(divide="ignore"):
        bpm = 60.0 / np.where(lags > 0, lags, np.inf)
    m = (bpm >= lo / 2) & (bpm <= hi)
    prior = np.exp(-0.5 * (np.log2(np.maximum(bpm, 1e-9) / 125.0) / 0.75) ** 2)
    score = np.where(m, ac * prior, -np.inf)
    bpm0 = float(bpm[int(np.argmax(score))])

    def best_phase(b):
        per = 60.0 / b * fps
        cand = np.arange(0, int(per))
        n = int((len(env) - per) / per)
        if n < 4:
            return 0.0, 0.0
        grid = np.clip((np.arange(n)[:, None] * per + cand[None, :]).round().astype(int),
                       0, len(env) - 1)
        s = env[grid].mean(0)
        k = int(np.argmax(s))
        return k / fps, float(s[k])

    # 低い候補から始めて、裏拍が十分強ければ倍テンポへ昇格させる
    cands = []
    for r in (0.25, 0.5, 1.0, 2.0, 4.0):
        b = bpm0 * r
        if lo <= b <= hi:
            ph, st = best_phase(b)
            cands.append((b, ph, _beat_strength(env, fps, b, ph, 0.0),
                          _beat_strength(env, fps, b, ph, 0.5)))
    if not cands:
        return bpm0, 0.0, env, fps
    cands.sort()
    b, ph, on, half = cands[0]
    for nb, nph, non, nhalf in cands[1:]:
        if abs(nb / b - 2.0) < 0.06 and half / (on + 1e-12) >= 0.62:
            b, ph, on, half = nb, nph, non, nhalf
    return float(b), float(ph), env, fps


def onset_peaks(env, fps):
    thr = env.mean() + env.std() * 0.5
    pk, _ = sg.find_peaks(env, height=thr, distance=max(1, int(fps * 0.05)))
    return pk / fps


def swing(env, fps, bpm, phase):
    """裏16分がどれだけ後ろにずれているか（0=イーブン, 0.333=3連のハネ）。

    打点の時刻を1拍で折り返してヒストグラムにし、
    16分の「裏」(0.25 と 0.75) の山がどこに立っているかを測る。
    """
    beat = 60.0 / bpm
    t = onset_peaks(env, fps) - phase
    if len(t) < 24:
        return 0.0, 0.0, [0.0] * 96
    ph = (t % beat) / beat                      # 0..1（1拍の中の位置）
    h, edges = np.histogram(ph, bins=96, range=(0, 1))
    centers = (edges[:-1] + edges[1:]) / 2
    h = np.convolve(np.r_[h[-4:], h, h[:4]], np.ones(5) / 5, "same")[4:-4]

    def local_max(lo, hi):
        """区間の中の山の位置。表拍の裾を拾わないよう、区間を狭く切る。"""
        m = (centers >= lo) & (centers <= hi)
        if not m.any():
            return None, 0.0
        w = h[m]
        if w.max() <= 0:
            return None, 0.0
        c = centers[m]
        k = int(np.argmax(w))
        # 山の頂点まわりだけで重心を取る（分解能を上げる）
        a, b = max(0, k - 3), min(len(w), k + 4)
        return float((c[a:b] * w[a:b]).sum() / w[a:b].sum()), float(w.max())

    # 表拍(0, 0.5)の山と、裏16分(0.25, 0.75)の山を別々に探す
    on = [local_max(*r) for r in ((0.90, 1.0), (0.0, 0.10), (0.42, 0.58))]
    onp = [p if p is None or p < 0.5 else p - 1.0 for p, _ in on if p is not None]
    base = float(np.mean([p % 0.5 if p >= 0 else p for p in onp])) if onp else 0.0
    offs = []
    for lo, hi, tgt in ((0.16, 0.40, 0.25), (0.60, 0.90, 0.75)):
        p, strength = local_max(lo, hi)
        if p is not None and strength > h.mean() * 0.55:
            offs.append((p - tgt) * 4)
    if not offs:
        return 0.0, float(h.std() / (h.mean() + 1e-12)), h.tolist()
    return float(np.mean(offs) - base * 4), float(h.std() / (h.mean() + 1e-12)), h.tolist()


def downbeat(env_kick, fps, bpm, phase):
    """4拍のうちどれが小節頭かを、キックの乗り方で選ぶ。
    これを合わせないとグルーヴ図の「1」がずれて読めなくなる。"""
    beat = 60.0 / bpm
    best, bs = 0, -1
    for k in range(4):
        s = _beat_strength(env_kick, fps, bpm / 4, phase + k * beat, 0.0)
        if s > bs:
            best, bs = k, s
    return phase + best * beat


def groove_map(env, fps, bpm, phase, div=16):
    """1小節を div 分割して、各位置の打点の強さを平均する。
    どこを叩く曲かがそのまま出る（グルーヴの骨格）。"""
    bar = 60.0 / bpm * 4
    step = bar / div
    n = int((len(env) / fps - phase) / bar)
    if n < 2:
        return np.zeros(div)
    out = np.zeros(div)
    win = max(1, int(step * 0.22 * fps))
    for i in range(div):
        vals = []
        for b in range(n):
            c = int((phase + b * bar + i * step) * fps)
            if 0 <= c - win and c + win < len(env):
                vals.append(env[c - win:c + win + 1].max())
        if vals:
            out[i] = np.mean(vals)
    out = out - out.min()
    return out / (out.max() or 1)


# --------------------------------------------------------------- 音程
KS_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def chroma(x, sr=SR, hop=2048, n=8192):
    """FFT のビンを音名へ畳み込む。低い方は倍音が濁るので 65Hz 以上だけ使う。"""
    S = np.abs(stft(x, n, hop)) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    ok = (f > 65) & (f < 2200)
    midi = 69 + 12 * np.log2(np.maximum(f[ok], 1e-9) / 440.0)
    pc = np.round(midi).astype(int) % 12
    C = np.zeros((S.shape[0], 12))
    Sok = S[:, ok]
    for p in range(12):
        m = pc == p
        if m.any():
            C[:, p] = Sok[:, m].sum(1)
    C /= (C.sum(1, keepdims=True) + 1e-12)
    return C


def key_of(C):
    v = C.mean(0)
    v = (v - v.mean()) / (v.std() + 1e-12)
    best = (None, -9)
    for r in range(12):
        for name, prof in (("major", KS_MAJ), ("minor", KS_MIN)):
            p = np.roll(prof, r)
            p = (p - p.mean()) / p.std()
            c = float((v * p).mean())
            if c > best[1]:
                best = (f"{PITCH[r]} {name}", c)
    return best


CHORDS = {
    "": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10], "sus4": [0, 5, 7], "dim": [0, 3, 6], "m6": [0, 3, 7, 9],
    "9": [0, 4, 7, 10, 14 % 12], "m9": [0, 3, 7, 10, 14 % 12],
}


def chords_per_bar(x, bpm, phase, bars=16, sr=SR):
    """小節ごとにいちばん近い和音を返す。進行の傾向を見るためのもの。"""
    bar = 60.0 / bpm * 4
    out = []
    for b in range(bars):
        a = int((phase + b * bar) * sr)
        e = int((phase + (b + 1) * bar) * sr)
        if e > len(x):
            break
        C = chroma(x[a:e]).mean(0)
        best = ("", -9)
        for r in range(12):
            for suf, iv in CHORDS.items():
                t = np.zeros(12)
                for i in iv:
                    t[(r + i) % 12] = 1
                t /= t.sum()
                sc = float(np.dot(C - C.mean(), t - t.mean()) /
                           ((C.std() + 1e-12) * (t.std() + 1e-12)) / 12)
                if sc > best[1]:
                    best = (PITCH[r] + suf, sc)
        out.append(best[0])
    return out


# --------------------------------------------------------------- 音色・音量
BANDS = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000),
         (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]
BAND_NAMES = ["sub", "低", "中低", "中1", "中2", "中3", "中高", "高", "超高"]


def band_energy(x, sr=SR):
    m = x.mean(1) if x.ndim > 1 else x
    S = np.abs(np.fft.rfft(m * np.hanning(len(m)))) ** 2
    f = np.fft.rfftfreq(len(m), 1 / sr)
    tot = S.sum() + 1e-20
    return np.array([10 * np.log10(S[(f >= a) & (f < b)].sum() / tot + 1e-20)
                     for a, b in BANDS])


def welch_spectrum(x, sr=SR, n=1 << 15):
    """フレームごとの power を平均した長時間スペクトル。
    1発の FFT だと、音の少ない曲は「音符の谷間」を測ってしまう。
    power で平均すると、実際に耳へ届くエネルギー配分が出る。"""
    m = x.mean(1) if x.ndim > 1 else x
    hop = n // 2
    w = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    cnt = 0
    for i in range(0, max(1, len(m) - n), hop):
        seg = m[i:i + n]
        if len(seg) < n:
            break
        acc += np.abs(np.fft.rfft(seg * w)) ** 2
        cnt += 1
    return np.fft.rfftfreq(n, 1 / sr), acc / max(cnt, 1)


def spectral_tilt(x, sr=SR):
    """1オクターブあたり何 dB 落ちるか。人の感じる「明るさ」の主因。
    power 平均のスペクトルを 1/3 オクターブに束ねてから直線を当てる。"""
    f, S = welch_spectrum(x, sr)
    edges = np.geomspace(100, 12000, 37)
    xs, ys = [], []
    for i in range(len(edges) - 1):
        m2 = (f >= edges[i]) & (f < edges[i + 1])
        if m2.any():
            xs.append(np.log2(np.sqrt(edges[i] * edges[i + 1])))
            ys.append(10 * np.log10(S[m2].mean() + 1e-20))
    if len(xs) < 5:
        return 0.0
    return float(np.polyfit(xs, ys, 1)[0])


def crest(x, sr=SR, win=0.4):
    m = x.mean(1) if x.ndim > 1 else x
    n = int(win * sr)
    k = len(m) // n
    if k < 2:
        return 0.0
    seg = m[:k * n].reshape(k, n)
    r = np.sqrt((seg ** 2).mean(1))
    p = np.abs(seg).max(1)
    return float(np.median(20 * np.log10(p / (r + 1e-12))))


def lufs_ish(x, sr=SR):
    """K 特性の簡易版で積分ラウドネスに近い値を出す。曲同士の比較用。"""
    m = x.mean(1) if x.ndim > 1 else x
    b, a = sg.butter(2, 60 / (sr / 2), "high")
    y = sg.lfilter(b, a, m)
    b2, a2 = sg.butter(2, [1500 / (sr / 2), 0.99], "band")
    y = y + 1.2 * sg.lfilter(b2, a2, m)
    return float(-0.691 + 10 * np.log10((y ** 2).mean() + 1e-20))


def hf_wash(x, sr=SR):
    """高域の「連続した床」。大きいほどきらびやかで、しかも刺さらない。
    8kHz 以上のエンベロープの (10パーセンタイル / 中央値)。"""
    m = x.mean(1) if x.ndim > 1 else x
    b, a = sg.butter(4, 8000 / (sr / 2), "high")
    e = np.abs(sg.hilbert(sg.lfilter(b, a, m)[:sr * 30]))
    e = sg.savgol_filter(e, 441, 2)
    med = np.median(e)
    return float(np.percentile(e, 10) / (med + 1e-12))


def stereo_width(x, sr=SR):
    if x.ndim == 1:
        return 0.0, np.zeros(len(BANDS))
    mid = (x[:, 0] + x[:, 1]) / 2
    side = (x[:, 0] - x[:, 1]) / 2
    tot = 20 * np.log10((np.sqrt((side ** 2).mean()) + 1e-12) /
                        (np.sqrt((mid ** 2).mean()) + 1e-12))
    per = []
    for lo, hi in BANDS:
        hi = min(hi, sr / 2 - 100)
        b, a = sg.butter(2, [max(lo, 20) / (sr / 2), hi / (sr / 2)], "band")
        ms = np.sqrt((sg.lfilter(b, a, mid) ** 2).mean())
        ss = np.sqrt((sg.lfilter(b, a, side) ** 2).mean())
        per.append(20 * np.log10((ss + 1e-12) / (ms + 1e-12)))
    return float(tot), np.array(per)


def hpss_ratio(x, sr=SR):
    """打楽器成分と持続音成分の比。大きいほど「リズムもの」。"""
    m = x.mean(1) if x.ndim > 1 else x
    S = stft(m, 2048, 512)
    A = np.abs(S)
    H = sg.medfilt(A, [17, 1])       # 時間方向に均す → 持続音
    P = sg.medfilt(A, [1, 17])       # 周波数方向に均す → 打点
    return float(10 * np.log10((P ** 2).sum() / ((H ** 2).sum() + 1e-20)))


def onset_rate(env, fps, bpm):
    """1拍あたり何回の打点があるか（にぎやかさ）。"""
    thr = env.mean() + env.std() * 0.6
    pk, _ = sg.find_peaks(env, height=thr, distance=int(fps * 0.045))
    return float(len(pk) / (len(env) / fps) * (60.0 / bpm))


def segments(x, bpm, phase, sr=SR):
    """小節ごとの特徴量の自己相似から、展開の切り替わりを数える。"""
    bar = 60.0 / bpm * 4
    n = int((len(x) / sr - phase) / bar)
    if n < 8:
        return 0, 0.0
    m = x.mean(1) if x.ndim > 1 else x
    feats = []
    for b in range(n):
        a = int((phase + b * bar) * sr)
        e = int((phase + (b + 1) * bar) * sr)
        seg = m[a:e]
        if len(seg) < 1024:
            break
        feats.append(np.concatenate([band_energy(seg[:, None].repeat(2, 1)),
                                     chroma(seg).mean(0) * 30]))
    F = np.array(feats)
    F = (F - F.mean(0)) / (F.std(0) + 1e-9)
    d = np.linalg.norm(np.diff(F, axis=0), axis=1)
    thr = d.mean() + d.std()
    bounds = int((d > thr).sum())
    return bounds, float(len(F) * bar / max(bounds, 1))


# --------------------------------------------------------------- まとめ
def analyze(path, seconds=90):
    x = load(path, limit=seconds)
    m = x.mean(1)
    bpm, phase, env, fps = tempo(m)
    # 16分グリッドはハイハット帯がいちばんはっきり出るので、
    # スウィングとグルーヴはその帯域の打点で測る
    env_hat = onset_env(m, SR, 512, (5000, 13000))
    env_kick = onset_env(m, SR, 512, DRUM_BANDS["キック"])
    sw, jitter, phist = swing(env_hat, fps, bpm, phase)
    bar_phase = downbeat(env_kick, fps, bpm, phase)
    gm = groove_map(env, fps, bpm, bar_phase)
    drums = {k: groove_map(onset_env(m, SR, 512, b), fps, bpm, bar_phase).tolist()
             for k, b in DRUM_BANDS.items()}
    C = chroma(m)
    key, kconf = key_of(C)
    tot_w, band_w = stereo_width(x)
    bounds, seg_len = segments(x, bpm, bar_phase)
    return {
        "file": os.path.basename(path),
        "duration": len(x) / SR,
        "bpm": bpm,
        "swing": sw,
        "jitter": jitter,
        "beat_hist": phist,
        "groove": gm.tolist(),
        "drums": drums,
        "key": key,
        "key_conf": kconf,
        "chords": chords_per_bar(m, bpm, bar_phase, 16),
        "bands": band_energy(x).tolist(),
        "tilt": spectral_tilt(x),
        "crest": crest(x),
        "lufs": lufs_ish(x),
        "hf_wash": hf_wash(x),
        "stereo": tot_w,
        "stereo_bands": band_w.tolist(),
        "hpss": hpss_ratio(x),
        "onset_rate": onset_rate(env, fps, bpm),
        "seg_bounds": bounds,
        "seg_len": seg_len,
    }


def show(r):
    print(f"\n=== {r['file']} ===")
    print(f"  長さ {r['duration']:.0f}s   BPM {r['bpm']:.1f}   "
          f"キー {r['key']} (確度 {r['key_conf']:.2f})")
    print(f"  スウィング {r['swing']*100:+.1f}%（16分に対する裏の遅れ） 打点の偏り {r['jitter']:.2f}")
    bh = np.array(r["beat_hist"])
    if bh.max() > 0:
        bh = bh / bh.max()
        lev = " ▁▂▃▄▅▆▇█"
        print("  1拍の中の打点分布（左=表拍, 目盛は16分）:")
        print("    " + "".join(lev[min(8, int(v * 8.99))] for v in bh))
        print("    " + "".join("|" if i % 24 == 0 else ("+" if i % 12 == 0 else " ")
                               for i in range(len(bh))))
    print(f"  ラウドネス {r['lufs']:.1f} LUFS-ish   クレスト {r['crest']:.1f} dB")
    print(f"  スペクトル傾き {r['tilt']:+.2f} dB/oct   高域ウォッシュ {r['hf_wash']:.3f}")
    print(f"  打点/持続 比 {r['hpss']:+.1f} dB   打点密度 {r['onset_rate']:.2f} 回/拍")
    print(f"  ステレオ幅 {r['stereo']:+.1f} dB   展開の切替 {r['seg_bounds']} 回 "
          f"（平均 {r['seg_len']:.1f} 秒ごと）")
    print("  帯域バランス(dB, 全体比):")
    print("    " + "  ".join(f"{n}{v:+.0f}" for n, v in zip(BAND_NAMES, r["bands"])))
    print("  グルーヴ（1小節=16分。■が強い打点）:")
    print("    位置      1 e & a 2 e & a 3 e & a 4 e & a")
    for k, v in list(r.get("drums", {}).items()) + [("全体", r["groove"])]:
        arr = np.array(v)
        print(f"    {k:<9s} " + " ".join("■" if q > 0.66 else "▧" if q > 0.42 else "・"
                                          for q in arr))
    print("  コード進行（先頭16小節の推定）:")
    print("    " + " ".join(r["chords"][:16]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--seconds", type=int, default=90)
    a = ap.parse_args()
    out = []
    for p in a.files:
        r = analyze(p, a.seconds)
        out.append(r)
        show(r)
    if a.json:
        json.dump(out, open(a.json, "w"), ensure_ascii=False, indent=1)
        print(f"\n→ {a.json}")


if __name__ == "__main__":
    main()
