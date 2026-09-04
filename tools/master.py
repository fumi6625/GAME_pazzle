#!/usr/bin/env python3
"""参考曲の「聞こえ方」に合わせて、ゲーム内曲を仕上げ直す。

旋律・和音・リズムは一切写さない。写すのは、人が「良い」と感じる原因になる
物理量だけで、しかも1/2オクターブまで均した粗い量しか使わない。

なにを直すか（参考3曲とゲーム4曲を同じ物差しで測って分かった差）:

  1. 層のバランス   … 打点/持続 比がゲーム側は 4〜6dB も低い。
                      ＝ ドラムが弱く、推進力が出ていない。ステムがあるので
                      ドラムを持ち上げて比を合わせる（一番効く）。
  2. 帯域バランス   … 1〜2kHz が 5〜6dB へこみ、逆に 20〜60Hz が 6〜10dB 多い。
                      前者が「遠い・迫力がない」、後者が「もこもこする」原因。
                      1/2オクターブに均したカーブを ±4.5dB 以内で寄せる。
  3. 高域の床       … 参考曲の高域は「常時ノイズ」ではなく「短い閃光」。
                      8kHz 以上を下向きエキスパンダで床だけ下げると抜ける。
  4. ステレオ幅     … 参考は side/mid が -10dB 前後。ゲーム側は広げすぎで
                      芯が抜けていた。150Hz 以下はモノにする（スマホ対策）。
  5. 迫力           … クレスト（ピーク/実効値）を 12dB へ、
                      ラウドネスを -12.5 LUFS 相当へ。参考は -11.3 だが
                      20分聞き続ける BGM なので少し控えめにする。

ステム間の加算関係は壊さない。非線形な処理は「合計から求めたゲイン曲線」を
全ステムへ同じように掛けるので、処理後のステムの合計＝処理後の本体になる。

使い方:
  python3 tools/master.py --learn <参考曲...>              目標カーブを学習
  python3 tools/master.py --out <出力先> <ステムのディレクトリ>
"""
import argparse
import json
import os
import sys

import numpy as np
from scipy import signal as sg
from scipy.ndimage import maximum_filter1d, uniform_filter1d

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synthkit import SR, write_wav                   # noqa: E402
import analyze as A                                   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET_JSON = os.path.join(HERE, "master_target.json")
STEMS = ["01_drums", "02_bass", "03_chords", "04_melody", "05_atmos"]

GOAL = {
    "hf_wash": 0.34,     # 参考 0.12〜0.36（低いほど高域が「閃光」になる）
    "hpss": -3.4,        # 参考 -2.2〜-3.6 dB（打点/持続）
    "stereo": -10.0,     # 参考 -9.2〜-12.7 dB（side/mid）
    "lufs": -12.5,       # 参考 -11.0〜-11.6。BGM なので 1.2dB 控えめ
    "crest": 12.1,       # 参考 11.9〜12.3 dB
    "peak": 0.94,
    "eq_limit": 4.5,     # EQ の最大補正量（これ以上いじると音が壊れる）
    "drum_max": 4.0,     # ドラムを持ち上げる上限(dB)
    "transient": 0.35,   # 立ち上がりを立てる量（0=そのまま）
}
NB = 19                  # 1/2オクターブ・30Hz〜17kHz
VERBOSE = os.environ.get("MASTER_VERBOSE") == "1"


# ------------------------------------------------------------ スペクトル
def log_spectrum(x, bins=NB, f_lo=30.0, f_hi=17000.0, sr=SR):
    """1/2オクターブに均した長時間スペクトル（dB, 平均を 0 に正規化）。
    ここまで均すと旋律は消え、音色の傾向だけが残る。"""
    m = x.mean(1) if x.ndim > 1 else x
    n = 1 << 15
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
    acc /= max(cnt, 1)
    f = np.fft.rfftfreq(n, 1 / sr)
    edges = np.geomspace(f_lo, f_hi, bins + 1)
    out = np.array([acc[(f >= edges[i]) & (f < edges[i + 1])].mean()
                    if ((f >= edges[i]) & (f < edges[i + 1])).any() else 1e-20
                    for i in range(bins)])
    centers = np.sqrt(edges[:-1] * edges[1:])
    db = 10 * np.log10(out + 1e-20)
    return centers, db - db.mean()


def learn(paths, seconds=120):
    curves = []
    for p in paths:
        c, db = log_spectrum(A.load(p, limit=seconds))
        curves.append(db)
        print(f"  学習: {os.path.basename(p)}")
    db = np.median(np.array(curves), axis=0)
    json.dump({"freq": c.tolist(), "db": db.tolist()}, open(TARGET_JSON, "w"), indent=1)
    print(f"→ {os.path.relpath(TARGET_JSON, os.path.dirname(HERE))}")
    print("  目標カーブ(dB): " + " ".join(f"{int(a)}:{b:+.0f}" for a, b in zip(c, db)))


def match_curve(x, tf, td, limit=GOAL["eq_limit"]):
    f, db = log_spectrum(x)
    corr = np.interp(np.log(f), np.log(tf), td) - db
    corr -= np.average(corr)               # 全体の音量は変えない
    corr = np.convolve(np.r_[corr[0], corr, corr[-1]], [0.25, 0.5, 0.25], "same")[1:-1]
    return f, np.clip(corr, -limit, limit)


def apply_curve(x, f, corr, sr=SR):
    """ゼロ位相の FFT 乗算。位相が動かないので、ステムを足したときに
    打ち消しが起きない（＝ステムの合計＝本体、が保たれる）。"""
    n = len(x)
    nf = 1 << int(np.ceil(np.log2(n + 1)))
    F = np.fft.rfftfreq(nf, 1 / sr)
    lf = np.log(np.maximum(F, 1e-3))
    g = 10 ** (np.interp(lf, np.log(f), corr, left=corr[0], right=corr[-1]) / 20)
    out = np.empty_like(x)
    for ch in range(x.shape[1]):
        out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch], nf) * g, nf)[:n]
    return out


# ------------------------------------------------------------ 包絡
def env_fast(x, atk, rel, sr=SR):
    e = np.abs(x)
    a_a = np.exp(-1 / (atk * sr))
    a_r = np.exp(-1 / (rel * sr))
    return np.maximum(sg.lfilter([1 - a_a], [1, -a_a], e),
                      sg.lfilter([1 - a_r], [1, -a_r], e) * 0.999)


def hf_gain_curve(mix, cut=7000.0, target=GOAL["hf_wash"], sr=SR):
    """高域の床だけを下げる下向きエキスパンダ。床が下がると
    ハットやスクラッチが「閃光」のように立って、抜けが出る。
    強さは、実際に測る指標（hf_wash）そのもので二分探索して決める。"""
    b, a = sg.butter(4, cut / (sr / 2), "high")
    # filtfilt（ゼロ位相）でないと「元 - 高域」が本当の低域にならず、
    # 位相のずれたぶんの高域が残って、床が下がらない
    e = env_fast(sg.filtfilt(b, a, mix.mean(1)), 0.002, 0.050)
    med = np.median(e) + 1e-12
    cur = A.hf_wash(mix)
    if cur <= target * 1.05:
        return np.ones(len(e)), cur, cur

    def make(k):
        g = np.minimum(1.0, (e / med) ** k)
        return np.clip(uniform_filter1d(g, size=int(0.006 * sr), mode="nearest"), 0.15, 1.0)

    lo, hi, gbest, dbest = 0.0, 6.0, np.ones(len(e)), 1e9
    got = cur
    for _ in range(10):
        k = (lo + hi) / 2
        g = make(k)
        w = A.hf_wash(mix * g[:, None])
        if abs(w - target) < dbest:
            dbest, gbest, got = abs(w - target), g, w
        if w > target:
            lo = k
        else:
            hi = k
    return gbest, cur, got


def clip_gain(mix, drive, peak=GOAL["peak"]):
    """ピーク/実効値（クレスト）を確実に下げるための、穏やかな波形飽和。
    コンプだと「アタックだけ通り抜けてピークが下がらず、
    それ以外が潰れる」という失敗をしやすい。飽和は drive に対して
    クレストが単調に下がるので、狙い値へ確実に追い込める。"""
    pk = max(float(np.abs(mix).max()), 1e-9)
    y = np.tanh(mix / pk * drive) / np.tanh(drive) * pk
    g = np.abs(y).max(1) / np.maximum(np.abs(mix).max(1), 1e-9)
    return uniform_filter1d(g, size=9, mode="nearest")


def transient_curve(mix, amount, sr=SR):
    """立ち上がりを持ち上げ、伸びをわずかに抑えるゲイン曲線。
    ドラムの音量だけでは足りない「推進力」はここで作る。"""
    m = mix.mean(1)
    fast = env_fast(m, 0.0015, 0.020)
    slow = env_fast(m, 0.030, 0.180)
    g = 1.0 + amount * (fast / (slow + 1e-9) - 1.0)
    return uniform_filter1d(np.clip(g, 0.80, 1.6), size=int(0.002 * sr), mode="nearest")


def soft_clip(x, drive):
    """密度を上げるための穏やかな飽和。リミッタだけでは
    「上げてから削る」の堂々巡りになってラウドネスが上がらない。"""
    return np.tanh(x * drive) / np.tanh(drive)


def limit_curve(mix, peak=GOAL["peak"], sr=SR):
    """先読み 3ms のピークリミッタ。均しを短くしておかないと
    ピークだけでなく周辺まで下がってしまい、かえって音圧が落ちる。"""
    look = int(0.003 * sr)
    p = np.abs(mix).max(1)
    m = maximum_filter1d(p, size=2 * look + 1, mode="nearest")
    g = np.minimum(1.0, peak / np.maximum(m, 1e-9))
    return uniform_filter1d(g, size=int(0.003 * sr), mode="nearest")


def ms_process(x, side_db, mono_below=150.0, sr=SR):
    mid = (x[:, 0] + x[:, 1]) / 2
    side = (x[:, 0] - x[:, 1]) / 2
    side = side * 10 ** (side_db / 20)
    b, a = sg.butter(2, mono_below / (sr / 2), "high")
    side = sg.lfilter(b, a, side)
    return np.stack([mid + side, mid - side], 1)


def side_db(x):
    mid = (x[:, 0] + x[:, 1]) / 2
    side = (x[:, 0] - x[:, 1]) / 2
    return float(20 * np.log10((np.sqrt((side ** 2).mean()) + 1e-12) /
                               (np.sqrt((mid ** 2).mean()) + 1e-12)))


# ------------------------------------------------------------ 本体
# 段の順番には意味がある。
#   ・トランジェントはコンプの前。後ろに置くと、持ち上げた尖りをリミッタが
#     そのまま削り、曲全体が小さくなるだけで終わる。
#   ・高域の床下げはコンプの後。コンプは谷を相対的に持ち上げるので、
#     先に床を下げても打ち消される。
def master(indir, outdir, target, report=True):
    stems = {}
    for s in STEMS:
        p = os.path.join(indir, s + ".wav")
        if not os.path.exists(p):
            raise SystemExit(f"{p} が無い")
        stems[s] = A.load(p)
    n = min(len(v) for v in stems.values())
    stems = {k: v[:n] for k, v in stems.items()}
    mix = sum(stems.values())
    before = measure(mix)

    # ループ曲なので、前後に「反対側の端」を貼ってから処理する。
    # こうしないと因果フィルタや包絡追従の立ち上がりが曲の先頭に残り、
    # 1周目だけ音が違う／継ぎ目で段差が出る、ということになる。
    pad = min(int(5.0 * SR), n // 4)
    stems = {k: np.concatenate([v[-pad:], v, v[:pad]]) for k, v in stems.items()}

    def norm(st, peak=GOAL["peak"], tag=None):
        """はみ出したピークはリミッタで丸めてから、全体を 0.94 に合わせる。
        ここで「一番高い1サンプル」を基準に割ってしまうと、
        たった数サンプルの尖りのせいで曲全体が数 dB 小さくなる
        （EQ を掛けると必ず数サンプルだけ 1.5 まで跳ねる）。"""
        m = sum(st.values())
        if float(np.abs(m).max()) > peak:
            gl = limit_curve(m, peak)
            st = {k: v * gl[:, None] for k, v in st.items()}
            m = sum(st.values())
        g = peak / max(float(np.abs(m).max()), 1e-9)
        st, m = {k: v * g for k, v in st.items()}, m * g
        if tag and VERBOSE:
            q = measure(m)
            print(f"    [{tag:<10s}] lufs{q['lufs']:7.2f} crest{q['crest']:6.2f} "
                  f"tilt{q['tilt']:6.2f} wash{q['wash']:6.3f} "
                  f"side{q['stereo']:7.2f} hpss{q['hpss']:6.2f}")
        return st, m

    # 1) ドラムの音量で「打点/持続」比を寄せる。EQ では作れない推進力。
    #    この素材ではたいてい上限（drum_max）で止まる。参考曲は生音のコラージュで
    #    全パートが打点的なのに対し、こちらはシンセの持続音が主体なので、
    #    ステムの音量だけでは比を埋めきれない。埋めるには編曲を変えるしかない。
    lo, hi, gd = 0.0, GOAL["drum_max"], 0.0
    for _ in range(8):
        gd = (lo + hi) / 2
        trial = sum(v * (10 ** (gd / 20) if k == "01_drums" else 1.0)
                    for k, v in stems.items())
        if A.hpss_ratio(trial) < GOAL["hpss"]:
            lo = gd
        else:
            hi = gd
    stems["01_drums"] = stems["01_drums"] * 10 ** (gd / 20)
    stems, mix = norm(stems, tag="1 ドラム")

    # 2) 帯域バランス（線形・全ステム共通なので合計が保たれる）
    f, corr = match_curve(mix, np.array(target["freq"]), np.array(target["db"]))
    stems = {k: apply_curve(v, f, corr) for k, v in stems.items()}
    stems, mix = norm(stems, tag="2 EQ")

    # 3) ステレオ幅（M/S は加算と交換できるのでステムごとに掛けてよい）
    d = GOAL["stereo"] - side_db(mix)
    stems = {k: ms_process(v, d) for k, v in stems.items()}
    stems, mix = norm(stems, tag="3 ステレオ")

    # 4b) 立ち上がりを少しだけ立てる。上げ幅は 1.6倍で頭打ちにして、
    #     1発の尖りで曲全体の音量が下がるのを防ぐ。
    tr = GOAL["transient"]
    gt = transient_curve(mix, tr)
    stems = {k: v * gt[:, None] for k, v in stems.items()}
    stems, mix = norm(stems, tag="4b トランジェント")

    # 5) 密度（クレスト）を参考曲と同じにする。ピークを 0.94 に固定した上で
    #    クレストを合わせると、実効値＝ラウドネスも自動的に参考曲並みになる。
    # 単調とは限らないので、掃引して一番近いものを選ぶ（各評価は軽い）
    #    評価は「この後のリミッタと正規化まで通した状態」で行う。
    #    飽和のあとは必ずピークが持ち上がるので、リミッタが更にクレストを
    #    下げる。そこまで含めないと必ず潰しすぎになる。
    gcbest, best = np.ones(len(mix)), 1e9
    for dr in np.linspace(0.25, 4.0, 20):
        g = clip_gain(mix, dr)
        y = mix * g[:, None]
        if float(np.abs(y).max()) > GOAL["peak"]:
            y = y * limit_curve(y)[:, None]
        y = y * (GOAL["peak"] / max(float(np.abs(y).max()), 1e-9))
        c = abs(A.crest(y) - GOAL["crest"])
        if c < best:
            best, gcbest = c, g
    stems = {k: v * gcbest[:, None] for k, v in stems.items()}
    stems, mix = norm(stems, tag="5 サチュレーション")

    # 6) 高域の床を下げる（コンプの後でないと打ち消される）
    g_hf, w0, w1 = hf_gain_curve(mix)
    b, a = sg.butter(4, 7000 / (SR / 2), "high")
    for k, v in stems.items():
        hi_ = np.stack([sg.filtfilt(b, a, v[:, c]) for c in range(2)], 1)
        stems[k] = v - hi_ + hi_ * g_hf[:, None]
    stems, mix = norm(stems, tag="6 高域の床")

    # 7) 仕上げのピーク処理
    gl = limit_curve(mix)
    stems = {k: v * gl[:, None] for k, v in stems.items()}
    stems, mix = norm(stems, tag="7 リミッタ")

    stems = {k: v[pad:pad + n] for k, v in stems.items()}
    mix = sum(stems.values())
    os.makedirs(outdir, exist_ok=True)
    for k, v in stems.items():
        write_wav(os.path.join(outdir, k + ".wav"), v)
    write_wav(os.path.join(outdir, "loop.wav"), mix)
    if report:
        show(os.path.basename(os.path.dirname(indir.rstrip("/"))) or indir,
             before, measure(mix), corr, f, gd, tr)
    return mix


def measure(x):
    return {"lufs": A.lufs_ish(x), "crest": A.crest(x), "tilt": A.spectral_tilt(x),
            "wash": A.hf_wash(x), "stereo": side_db(x), "hpss": A.hpss_ratio(x),
            "peak": float(np.abs(x).max())}


def show(name, b, a, corr, f, gd, tr=0.0):
    print(f"\n[{name}]  ドラム {gd:+.1f} dB / トランジェント {tr:.2f}")
    rows = [("ラウドネス(LUFS-ish)", "lufs", GOAL["lufs"]),
            ("クレスト(dB)", "crest", GOAL["crest"]),
            ("スペクトル傾き(dB/oct)", "tilt", -3.43),
            ("高域の床", "wash", GOAL["hf_wash"]),
            ("ステレオ side/mid(dB)", "stereo", GOAL["stereo"]),
            ("打点/持続(dB)", "hpss", GOAL["hpss"]),
            ("ピーク", "peak", GOAL["peak"])]
    print(f"  {'項目':<22s} {'前':>8s} {'後':>8s} {'狙い':>8s}")
    for lab, k, t in rows:
        print(f"  {lab:<22s} {b[k]:8.2f} {a[k]:8.2f} {t:8.2f}")
    print("  EQ 補正(dB): " + " ".join(f"{int(fr)}:{c:+.1f}" for fr, c in zip(f, corr)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="*")
    ap.add_argument("--learn", nargs="*")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.learn:
        learn(a.learn)
        return
    if not os.path.exists(TARGET_JSON):
        raise SystemExit("先に --learn で目標カーブを作る")
    t = json.load(open(TARGET_JSON))
    for d in a.dirs:
        master(d, a.out or (d.rstrip("/") + "_master"), t)


if __name__ == "__main__":
    main()
