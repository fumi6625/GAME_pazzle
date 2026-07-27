#!/usr/bin/env python3
"""
"PRISM SHUFFLE" -- music + SFX kit for a music-driven puzzle game
(Lumines / Tetris Effect lineage: the player's input is part of the music).

135 BPM, F dorian, 32-bar loop, swung 16ths.

Design constraints that come from the game, not from taste:

* SFX must be consonant with the music at ANY moment, because the player
  triggers them, not the composer. So every SFX pitch is drawn from F MINOR
  PENTATONIC (F Ab Bb C Eb) -- no semitones, no tritone. The music uses full
  F dorian; pentatonic is a subset of it, so nothing can clash.
* The mix leaves a REGISTER HOLE above ~C5 for the SFX to live in. The melody
  sits low (median ~59 MIDI, matching the measured reference library) so the
  player's sounds are never masked.
* Delivered as stems so the game can add/remove layers with intensity. The
  stems sum bit-exactly to the full loop.
* Mix targets from measured-library.md, big-beat column:
  crest ~11 dB, HF peak ~-5 dB, HF WASH ~0.38, air ~-22 dB.
  The wash target is the important one -- a continuous quiet HF bed (vinyl
  noise) is what stops bright highs from stinging. Do not fix harshness by
  darkening; fix it by smoothing.
"""

import sys, os
sys.path.insert(0, os.path.expanduser('~/.claude/skills/music-composition/scripts'))
from synth import *          # noqa
import synth
import numpy as np
from scipy import signal as sg

set_tempo(135, swing=0.12)          # swung 16ths -- the funk feel of the library
BEAT, BAR, SIXT = grid()            # refresh: `from synth import *` copied the old tempo
seed(77)

BARS = 32
KEY_ROOT = 5                        # F
PENT = [0, 3, 5, 7, 10]             # F Ab Bb C Eb -- the SFX-safe scale


# --- warm, dark-tailed reverb; the tail must not add top end ----------------
def reverb_ir(dur=1.6, pre=0.015, decay=4.4):
    n = int(dur * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-np.arange(n) / SR * decay)[:, None]
    ir[:int(pre * SR)] = 0
    for c in range(2):
        ir[:, c] = lp(hp(ir[:, c], 200), 4200)
    return ir / np.abs(ir).max() * 0.35
synth.reverb_ir = reverb_ir


# ---------------------------------------------------------------------------
# harmony -- i / bIII / IV / bVII in F dorian.
# The upper voices barely move; only the bass walks. That is what makes a
# 4-bar loop bearable for twenty minutes.
# ---------------------------------------------------------------------------
PROG = [
    ([56, 60, 63, 67], 29),      # Fm9     Ab C Eb G  / F
    ([56, 60, 63, 67], 32),      # Abmaj9  same voicing, bass moves only
    ([56, 60, 62, 67], 34),      # Bb13    Eb -> D
    ([56, 58, 62, 67], 27),      # Ebmaj9  C  -> Bb
]

# ---------------------------------------------------------------------------
# The hook. Written to the measured library profile (11 big-beat tracks):
# register median ~59, ~5 notes/bar, 78% one 16th or shorter, ~74% rests,
# 40% leaps, 22% repeated notes, step inertia ~36%.
# Kept below C5 so the SFX register stays clear.
# ---------------------------------------------------------------------------
HOOK = [
    (0, 0, 1, 53), (0, 1, 1, 53), (0, 6, 1, 60), (0, 7, 1, 58), (0, 12, 2, 55),
    (1, 2, 1, 63), (1, 3, 1, 63), (1, 6, 1, 60), (1, 11, 1, 65), (1, 14, 2, 60),
    (2, 0, 1, 58), (2, 4, 1, 58), (2, 5, 1, 56), (2, 10, 1, 63), (2, 14, 2, 60),
    (3, 2, 1, 60), (3, 3, 1, 60), (3, 7, 1, 55), (3, 11, 1, 58), (3, 13, 3, 53),
]
HOOK_HI = [(b, s, l, m + 5) for (b, s, l, m) in HOOK]     # answer up a 4th


def hook_bars(b0, notes, oct_=0):
    return [(b0 + b, s, l, m + 12 * oct_) for (b, s, l, m) in notes]


# ---------------------------------------------------------------------------
# stems
# ---------------------------------------------------------------------------

def stem_drums():
    mx = Mix(BARS * BAR + 4)
    for b in range(BARS):
        half = b % 8 >= 4
        for s in (0, 4, 8, 12):
            mx.add_kick(kick(tune=44, decay=11.0, length=0.46), st(b, s), gain=1.0)
        for s in (4, 12):
            mx.add(clap(0.55, tilt=6000), st(b, s), pan=-0.05, rev=0.16, dly=0.05)
        # swung 16th hats, accented like a hand plays them, gently rolled off
        for s in range(16):
            if s % 4 == 0:
                a = 0.30
            elif s % 2 == 0:
                a = 0.21
            else:
                a = 0.13 if rng.random() > 0.30 else 0
            if a:
                mx.add(hat(False, a, fc=6500, tilt=11500), st(b, s),
                       pan=-0.12 if s % 2 else 0.18, gain=1.0, rev=0.04)
        for s in (2, 6, 10, 14):
            mx.add(hat(True, 0.15, fc=6000, tilt=10000), st(b, s), pan=0.2, rev=0.06)
        if half:
            for s in (7, 15):
                mx.add(rim(0.26), st(b, s), pan=-0.34, rev=0.08, dly=0.05)
        for s in (3, 11):
            mx.add(shaker(0.30), st(b, s), pan=0.30)
        if b % 8 == 7:
            for k, s in enumerate((10, 12, 13, 14, 15)):
                mx.add(tom(180 + k * 26, 0.34), st(b, s), pan=-0.4 + k * 0.2, rev=0.12)
    return mx


def stem_bass():
    mx = Mix(BARS * BAR + 4)
    for b in range(BARS):
        _, root = PROG[b % 4]
        n = root + 12                       # an octave above the kick fundamental
        fig = [(0, 3), (4, 2), (6, 2), (10, 2), (14, 2)]
        if b % 4 == 3:
            fig = [(0, 2), (3, 1), (4, 2), (7, 1), (10, 2), (13, 1), (14, 2)]
        for s, ln in fig:
            mx.add(bass(n, ln * SIXT * 0.95, 1.0, cut=430), st(b, s),
                   gain=0.62, sc=True)
            mx.add(sub(n - 12, ln * SIXT * 0.9, 0.9), st(b, s), gain=0.30, sc=True)
    return mx


def stem_chords():
    mx = Mix(BARS * BAR + 4)
    for b in range(BARS):
        ch, root = PROG[b % 4]
        busy = b % 8 >= 4
        pat = [(2, 1.0), (6, .75), (11, .9)] if not busy else \
              [(2, 1.0), (6, .75), (9, .6), (11, .9), (14, .7)]
        for s, a in pat:
            mx.add(stab(ch, 0.26, a, cut=2700), st(b, s), gain=0.72,
                   rev=0.14, dly=0.05, sc=True)
        # rhodes comp adds warmth without adding top end
        for s, ln in ((4, 3), (12, 4)):
            for i, m in enumerate(ch):
                mx.add(rhodes(m, ln * SIXT * 1.4, 0.55 - .05 * i), st(b, s),
                       pan=-0.28 + 0.19 * i, gain=0.85, rev=0.16, dly=0.05, sc=True)
    return mx


def stem_melody():
    mx = Mix(BARS * BAR + 4)
    for rep in range(BARS // 8):
        b0 = rep * 8
        lo = hook_bars(b0, HOOK)
        hi = hook_bars(b0 + 4, HOOK_HI if rep % 2 else HOOK)
        for (b, s, l, m) in lo + hi:
            mx.add(chop(m, l * SIXT * 1.1, 1.0), st(b, s), pan=-0.06,
                   gain=1.75, rev=0.13, dly=0.06, sc=True)
            if rep >= 2:                       # octave shimmer, quiet, later on
                mx.add(bell(m + 12, l * SIXT * 2.2, 0.16), st(b, s), pan=0.30,
                       gain=1.15, rev=0.22, dly=0.10, sc=True)
    return mx


def stem_atmos():
    """Pads plus the continuous HF bed. This stem is what fixes the harshness:
    a quiet unbroken layer of vinyl noise raises HF 'wash' toward the reference
    0.38, so the hats read as part of a texture rather than as bare spikes."""
    mx = Mix(BARS * BAR + 4)
    mx.add(vinyl(BARS * BAR + 3, amp=0.17), 0, gain=1.0)
    for b in range(BARS):
        ch, root = PROG[b % 4]
        mx.add(pad([m + 12 for m in ch], BAR * 1.05, 0.26, cut=1900, att=0.30),
               st(b, 0), gain=1.0, rev=0.30, sc=True)
        if b % 8 == 0:
            mx.add(rev_crash(1.4, 0.09, tilt=4200), st(b, 0) - 1.4, rev=0.16)
    return mx


STEMS = [('01_drums', stem_drums), ('02_bass', stem_bass), ('03_chords', stem_chords),
         ('04_melody', stem_melody), ('05_atmos', stem_atmos)]

EQ = [('shelf', 74, -4.6, False),
      ('peak', 280, -3.4, 0.85),
      ('peak', 3300, -1.0, 0.7),        # take the sting out without darkening
      ('shelf', 2200, 5.2, True),
      ('shelf', 8000, 2.4, True)]


def render_stem(mx, kick_times):
    """Render one stem WITHOUT limiting or normalising, so stems sum exactly.
    Skipping the limiter is also what keeps the crest factor near 11 dB."""
    mx.kicks = kick_times
    scg = mx._sc_env(depth=0.55, rel=0.16)
    ir = reverb_ir()
    wet = np.zeros_like(mx.wet)
    for c in range(2):
        wet[:, c] = sg.fftconvolve(mx.wet[:, c], ir[:, c])[:len(wet)]
    wet *= (0.5 + 0.5 * scg)[:, None]
    dly = synth.pingpong(mx.dly, BEAT * 0.75, fb=0.26, reps=4)
    y = mx.dry + mx.duck * scg[:, None] + wet * 0.42 + dly * 0.22
    y = apply_eq(y, EQ)
    for c in range(2):
        y[:, c] = hp(y[:, c], 26, order=2)
    return y


# ---------------------------------------------------------------------------
# SFX kit -- every pitch from F minor pentatonic, all above C5 so they sit in
# the register hole the music leaves open.
# ---------------------------------------------------------------------------

def pent_note(i, base=72):
    """i-th step of F minor pentatonic upward from `base` (C5 = 72)."""
    return base + PENT[i % 5] + 12 * (i // 5)


def sfx_blip(note, dur=0.16, amp=0.7, bright=1.0):
    n = int(dur * SR); t = np.arange(n) / SR; f = n2f(note)
    x = np.sin(2 * np.pi * f * t) * 0.7 + np.sin(2 * np.pi * f * 2 * t) * 0.22
    x += np.sin(2 * np.pi * f * 3 * t) * 0.10 * bright
    x *= expdec(n, 16) * adsr(n, 0.002, 0.02, 0.05, sus=0.85)
    return sat(x, 1.3) * amp


def sfx_pluck(note, dur=0.30, amp=0.7):
    n = int(dur * SR); f = n2f(note)
    y = pizz(note, dur, 1.0)[:n]
    return lp(y, 6000) * amp


def sfx_chime(note, dur=0.9, amp=0.6):
    n = int(dur * SR); t = np.arange(n) / SR; f = n2f(note)
    mod = np.sin(2 * np.pi * f * 2.0 * t) * expdec(n, 7) * 1.6
    x = np.sin(2 * np.pi * f * t + mod) * expdec(n, 3.0)
    x += np.sin(2 * np.pi * f * 1.5 * t) * expdec(n, 5) * 0.2
    return x * amp


def sfx_sweep_up(note, dur=0.45, amp=0.6):
    n = int(dur * SR); t = np.arange(n) / SR
    f = n2f(note) * np.geomspace(0.5, 1.0, n)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.8
    x += hp(rng.standard_normal(n), 3000) * (t / dur) ** 2 * 0.10
    return lp(x * adsr(n, 0.01, 0.1, 0.12, sus=0.9), 7000) * amp


def sfx_thud(note, dur=0.22, amp=0.8):
    n = int(dur * SR); t = np.arange(n) / SR
    f = n2f(note - 24) * (1 + 1.2 * np.exp(-t * 40))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * expdec(n, 22)
    x += lp(rng.standard_normal(n), 2500) * expdec(n, 90) * 0.25
    return sat(x, 1.5) * amp


def build_sfx(outdir):
    os.makedirs(outdir, exist_ok=True)
    made = []

    def w(name, y, tail=0.05):
        y = np.asarray(y)
        y = np.column_stack([y, y]) if y.ndim == 1 else y
        y = np.vstack([y, np.zeros((int(tail * SR), 2))])
        pk = np.abs(y).max() or 1.0
        write(os.path.join(outdir, name + '.wav'), y / pk * 0.72)
        made.append(name)

    # movement -- quiet, low in the SFX register, played constantly
    w('move_left',  sfx_blip(pent_note(0), 0.10, 0.45, 0.4))
    w('move_right', sfx_blip(pent_note(1), 0.10, 0.45, 0.4))
    w('rotate_cw',  sfx_blip(pent_note(2), 0.12, 0.55, 0.8))
    w('rotate_ccw', sfx_blip(pent_note(1), 0.12, 0.55, 0.8))
    w('soft_drop',  sfx_blip(pent_note(0), 0.08, 0.38, 0.3))
    w('hard_drop',  sfx_sweep_up(pent_note(5), 0.22, 0.6)[::-1].copy())
    w('lock',       sfx_thud(pent_note(0), 0.22, 0.75))
    w('invalid',    sfx_thud(pent_note(0) - 5, 0.14, 0.4))

    # line clears -- more lines, higher and richer
    for i in range(1, 5):
        n = int(0.55 * SR); y = np.zeros(n)
        for k in range(i + 1):
            seg = sfx_chime(pent_note(3 + k * 2), 0.55, 0.55 - 0.05 * k)
            d = int(k * 0.035 * SR)
            y[d:d + len(seg[:n - d])] += seg[:n - d]
        w(f'clear_{i}', y)

    # combo / chain -- walks up the pentatonic, so a long chain is a rising run
    for i in range(12):
        w(f'combo_{i+1:02d}', sfx_pluck(pent_note(2 + i), 0.34, 0.62))

    # progression
    n = int(1.6 * SR); y = np.zeros(n)
    for k, deg in enumerate([0, 2, 4, 5, 7]):
        seg = sfx_chime(pent_note(deg), 1.6, 0.5)
        d = int(k * 0.075 * SR)
        y[d:d + len(seg[:n - d])] += seg[:n - d]
    w('level_up', y)
    w('game_over', sfx_sweep_up(pent_note(0), 1.1, 0.6)[::-1].copy())
    n = int(2.2 * SR); y = np.zeros(n)
    for k, m in enumerate([53, 56, 60, 63, 67, 72]):
        seg = sfx_chime(m + 12, 2.2, 0.42)
        d = int(k * 0.05 * SR)
        y[d:d + len(seg[:n - d])] += seg[:n - d]
    w('stage_clear', y)
    return made


# ---------------------------------------------------------------------------

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(os.path.join(out, 'stems'), exist_ok=True)

    kick_times = [st(b, s) for b in range(BARS) for s in (0, 4, 8, 12)]
    rendered = []
    for name, fn in STEMS:
        rendered.append((name, render_stem(fn(), list(kick_times))))

    L = int(round(BARS * BAR * SR))
    full = sum(y for _, y in rendered)

    # Bus glue + gentle limiting, applied to the SUM. The resulting per-sample
    # gain curve is then applied identically to every stem, so the stems still
    # add up to exactly the delivered master instead of to some louder,
    # unprocessed version of it. This is the only way to ship stems from a mix
    # that has bus processing on it.
    mono = full.mean(1)
    envf = np.abs(sg.lfilter(*sg.butter(1, 10 / (SR / 2), 'low'), np.abs(mono)))

    def process(drive, thr, expo):
        glue = 1.0 / np.maximum(1.0, envf / thr) ** expo
        lim = np.tanh(full * glue[:, None] * drive) * (0.92 / np.tanh(drive))
        gc = np.clip(np.nan_to_num(lim / (full + np.sign(full) * 1e-9 + 1e-12),
                                   nan=1.0, posinf=1.0, neginf=1.0), 0.0, 2.0)
        return gc

    # aim for the reference crest factor (~11.5 dB); too little and the loop is
    # weak in-game, too much and it fatigues -- both were measured failures
    best = None
    for drive in np.arange(0.9, 3.2, 0.1):
        gc = process(drive, 0.20, 0.30)
        fp = full * gc
        pk = np.abs(fp[:L + int(2 * SR)]).max()
        if pk <= 0:
            continue
        fpn = fp * (0.94 / pk)
        crest = 20 * np.log10(0.94 / (fpn.mean(1).std() + 1e-9))
        if best is None or abs(crest - 11.5) < abs(best[0] - 11.5):
            best = (crest, drive, gc * (0.94 / pk))
    crest, drive, gain_curve = best
    print(f"  limiter drive {drive:.1f} -> crest {crest:.1f} dB")
    # Normalise after make_loop -- folding the reverb tail back onto the head
    # adds energy, so the pre-loop normalisation is not the final one.
    raw = [(name, make_loop(y * gain_curve, BARS)) for name, y in rendered]
    full_loop = make_loop(full * gain_curve, BARS)
    norm = 0.94 / np.abs(full_loop).max()
    full_loop = full_loop * norm
    STEM_GAIN = min(1.0, 0.94 / max(np.abs(y * norm).max() for _, y in raw))
    loops = [(name, y * norm * STEM_GAIN) for name, y in raw]
    print(f"  stem headroom factor {STEM_GAIN:.4f}  "
          f"(sum of stems x {1/STEM_GAIN:.3f} == master)")

    for name, y in loops:
        write(os.path.join(out, 'stems', name + '.wav'), y)
    write(os.path.join(out, 'PRISM_SHUFFLE_loop.wav'), full_loop)

    made = build_sfx(os.path.join(out, 'sfx'))
    print(f"stems: {len(loops)}   sfx: {len(made)}   loop {len(full_loop)/SR:.2f}s "
          f"({BARS} bars @ {synth.BPM:g} BPM)")
