#!/usr/bin/env python3
"""操作音のうち「回転」と「落下」を作り直す。

なぜ作り直すか:
  もとの回転音・落下音は単純なサイン波のブリップと逆再生スイープで、
  曲の上に乗せると「別の場所で鳴っている電子音」に聞こえていた。
  ルミネス系のゲームでは、プレイヤーの操作音は曲の一部（＝アクセント）
  として鳴るのが正しい。そこで打楽器としての立ち上がりを持たせ、
  音程は曲と同じ音階から取り、長さを16分音符前後に収める。

設計:
  回転  … 木琴/リムのような打点。4ms のノイズのアタック + 倍音が
          非整数（2.76倍）の金属バー。減衰 120ms。CW と CCW は
          完全4度違いにして、交互に回すと音型になる。
  即落下 … 下降するアクセント。ピッチが2オクターブ落ちてサブに着地し、
          同時にノイズがローパスで閉じていく。0.30 秒。
  着地  … 短いリム + 低いタム。連打しても濁らないよう 0.16 秒。

音程はすべて C マイナーペンタトニック（C E♭ F G B♭）から取る。
これは PRISM SHUFFLE の F ドリアンの部分集合で、他の3曲も
audio.js 側が曲の主音ぶんだけ再生レートで移調するので破綻しない。
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synthkit import SR, TAU, lp, hp, bp, midi, write_wav  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "PRISM_SHUFFLE", "sfx")
rng = np.random.default_rng(4242)

PENT = [0, 3, 5, 7, 10]          # C マイナーペンタトニック（C E♭ F G B♭）


def note(i, base=72):
    """ペンタトニックの i 番目（base = C5）。"""
    return base + PENT[i % 5] + 12 * (i // 5)


def env_exp(n, k):
    return np.exp(-np.linspace(0, k, n))


def click(n, lo=1800, hi=6000, k=180):
    """立ち上がりのカチッという成分。これが無いと曲に埋もれる。"""
    return bp(rng.standard_normal(n), lo, hi) * env_exp(n, k)


def tine(f, n, k=14, inharm=2.76, drop=0.06):
    """木琴/金属バーの打点。倍音を非整数にすると「打った」音になる。
    立ち上がりだけピッチを少し上から落とすと、撥が当たった感じが出る。"""
    t = np.arange(n) / SR
    bend = 1.0 + drop * np.exp(-t * 90)
    ph = TAU * np.cumsum(f * bend) / SR
    y = np.sin(ph) * env_exp(n, k)
    y += np.sin(ph * inharm) * env_exp(n, k * 2.4) * 0.30
    y += np.sin(ph * 5.40) * env_exp(n, k * 4.0) * 0.10
    return y


def sat(x, d=1.6):
    return np.tanh(x * d) / np.tanh(d)


# ------------------------------------------------------------------ 回転
def s_rotate(n_note, dur=0.24, amp=0.95):
    n = int(dur * SR)
    f = midi(n_note)
    # 減衰をゆっくりめ(k=9)にして、16分〜8分ぶん鳴らす。曲の隙間で「鳴った」
    # と分かる長さが要る。短すぎるとクリックにしか聞こえない。
    y = tine(f, n, k=9) * 0.90
    y += click(n, 2600, 7000, 220) * 0.34
    # 5度上を重ねると、単音より「和音のアクセント」に聞こえる
    y += tine(f * 1.5, n, k=13) * 0.26
    y += tine(f * 2.0, n, k=18) * 0.12
    return sat(lp(y, 11000), 1.4) * amp


# ------------------------------------------------------------------ 即落下
def s_hard_drop(n_note, dur=0.30, amp=1.0):
    """上から下へ2オクターブ落ちて、サブの一撃に着地する。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    # ピッチは指数的に落とす。最後の 1/3 は下げ止まってサブとして残る
    f = midi(n_note) * np.exp(-t * 11.0)
    f = np.maximum(f, midi(n_note - 26))
    body = np.sin(TAU * np.cumsum(f) / SR) * env_exp(n, 4.2)
    # 一緒に閉じていくノイズ。落下の「風切り」
    cut = 9000 * np.exp(-t * 9.0) + 400
    air = rng.standard_normal(n) * env_exp(n, 6.0)
    # 時変ローパスは重いので、3帯域を包絡でクロスフェードして近似する
    bands = [lp(air, 7000), lp(air, 2200), lp(air, 700)]
    w = np.clip(np.stack([
        (cut - 4000) / 5000,
        1 - np.abs(cut - 2200) / 2500,
        (2200 - cut) / 1800,
    ]), 0, 1)
    w /= w.sum(0) + 1e-9
    air = sum(b * wi for b, wi in zip(bands, w))
    y = body * 0.95 + air * 0.30
    y += click(n, 3000, 9000, 260) * 0.35      # 押した瞬間の立ち上がり
    return sat(y, 1.8) * amp


# ------------------------------------------------------------------ 着地
def s_lock(n_note, dur=0.20, amp=0.95):
    """リム + 低いタム。短くして連打でも濁らせない。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(n_note - 24) * (1 + 1.1 * np.exp(-t * 55))
    tom = np.sin(TAU * np.cumsum(f) / SR) * env_exp(n, 11)
    rim = bp(rng.standard_normal(n), 1400, 4200) * env_exp(n, 90)
    y = tom * 0.9 + rim * 0.55 + tine(midi(n_note), n, k=14) * 0.30
    return sat(hp(y, 45), 1.5) * amp


# ------------------------------------------------------------------ 移動
def s_move(n_note, dur=0.14, amp=0.55):
    """左右移動。鳴りっぱなしになるので軽くするが、まったく残らないと
    「押した感触」が消えるので、木の余韻を少しだけ残す。"""
    n = int(dur * SR)
    y = click(n, 2200, 6500, 220) * 0.55 + tine(midi(n_note), n, k=15) * 0.75
    return sat(lp(y, 9000), 1.2) * amp


def w(name, y, tail=0.03, peak=0.86):
    y = np.asarray(y, np.float64)
    y = np.column_stack([y, y]) if y.ndim == 1 else y
    y = np.vstack([y, np.zeros((int(tail * SR), 2))])
    pk = np.abs(y).max() or 1.0
    write_wav(os.path.join(OUT, name + ".wav"), y / pk * peak)
    return name, len(y) / SR


def main():
    os.makedirs(OUT, exist_ok=True)
    made = [
        # 回転は完全4度違い（G と C）。交互に回すと素直な音型になる
        w("rotate_cw",  s_rotate(note(3)), peak=0.94),      # G5
        w("rotate_ccw", s_rotate(note(0)), peak=0.94),      # C5
        w("hard_drop",  s_hard_drop(note(5)), peak=0.92),   # C6 から落ちる
        w("lock",       s_lock(note(0)), peak=0.90),
        w("soft_drop",  s_move(note(1), 0.10, 0.42), peak=0.70),
        w("move_left",  s_move(note(0)), peak=0.74),
        w("move_right", s_move(note(1)), peak=0.74),
    ]
    for name, d in made:
        print(f"  {name:12s} {d*1000:5.0f} ms")


if __name__ == "__main__":
    main()
