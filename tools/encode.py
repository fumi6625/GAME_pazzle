#!/usr/bin/env python3
"""各曲のステムを配信用に符号化する。

なぜ2形式か:
  m4a(AAC) … iOS Safari が確実に再生できる。iPhone で遊ぶ前提なので必須。
  ogg(Vorbis) … Chrome/Firefox 向け。AAC を持たないビルドでも鳴り、
                 しかも AAC より小さい。自動テストの環境もこちらで検証する。
  読み込みは m4a → ogg → wav の順に試す（audio.js の fetchStem）。

どちらの符号化器も先頭/末尾にパディングを入れるため、デコード後の長さは
ループ長ちょうどにならない。audio.js 側の trimToLoop() が
「サンプル数を狙いの値へ切り詰める」ので、ここでは長さを気にしなくてよい。
"""
import os, subprocess, sys
import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "PRISM_SHUFFLE")
STEMS = ["01_drums", "02_bass", "03_chords", "04_melody", "05_atmos"]

# (曲名, wav の置き場, 配信用の置き場, ループ本体の名前)
TRACKS = [
    ("PRISM_SHUFFLE", ROOT + "/stems", ROOT + "/stems_web", ROOT + "/PRISM_SHUFFLE_loop"),
    ("NEON_MARCH", ROOT + "/NEON_MARCH/stems", ROOT + "/NEON_MARCH/stems_web",
     ROOT + "/NEON_MARCH/loop"),
    ("CIRCUIT_RUSH", ROOT + "/CIRCUIT_RUSH/stems", ROOT + "/CIRCUIT_RUSH/stems_web",
     ROOT + "/CIRCUIT_RUSH/loop"),
    ("GLASS_TIDE", ROOT + "/GLASS_TIDE/stems", ROOT + "/GLASS_TIDE/stems_web",
     ROOT + "/GLASS_TIDE/loop"),
]


def enc(src, dst_base):
    subprocess.run([FF, "-v", "error", "-y", "-i", src, "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart", dst_base + ".m4a"], check=True)
    subprocess.run([FF, "-v", "error", "-y", "-i", src, "-c:a", "libvorbis", "-q:a", "4",
                    dst_base + ".ogg"], check=True)


def main():
    only = sys.argv[1:]
    for name, wav_dir, web_dir, loop_base in TRACKS:
        if only and name not in only:
            continue
        if not os.path.isdir(wav_dir):
            print(f"[skip] {name}: {wav_dir} が無い（compose.py を先に実行）")
            continue
        os.makedirs(web_dir, exist_ok=True)
        tot = 0
        for s in STEMS:
            src = os.path.join(wav_dir, s + ".wav")
            enc(src, os.path.join(web_dir, s))
            tot += sum(os.path.getsize(os.path.join(web_dir, s + e)) for e in (".m4a", ".ogg"))
        lw = loop_base + ".wav"
        if os.path.exists(lw):
            subprocess.run([FF, "-v", "error", "-y", "-i", lw, "-c:a", "aac", "-b:a", "192k",
                            "-movflags", "+faststart", loop_base + ".m4a"], check=True)
            subprocess.run([FF, "-v", "error", "-y", "-i", lw, "-c:a", "libvorbis", "-q:a", "5",
                            loop_base + ".ogg"], check=True)
            tot += sum(os.path.getsize(loop_base + e) for e in (".m4a", ".ogg"))
        print(f"{name:14s} 配信用 {tot/1e6:5.1f} MB")


if __name__ == "__main__":
    main()
