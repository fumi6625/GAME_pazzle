#!/usr/bin/env python3
"""PRISM_SHUFFLE/sfx/*.wav を FLAC + base64 にして sfx-assets.js を書き出す。

なぜ埋め込むか:
  file:// でこのゲームを開くと fetch が CORS で弾かれる。効果音だけは
  埋め込みにしておけば、どの開き方でも 16分グリッドへ正確に置ける。

なぜ FLAC か:
  可逆で、しかもエンコーダ遅延が入らない。AAC/MP3 は先頭に数十msの
  無音が付くので、発音タイミングが16分からずれてしまう。
"""
import base64
import glob
import os
import subprocess
import tempfile

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "PRISM_SHUFFLE", "sfx")
DST = os.path.join(ROOT, "sfx-assets.js")

HEAD = """/*
 * PRISM SHUFFLE — 操作音アセット（自動生成 / 手で編集しない）
 *
 * PRISM_SHUFFLE/sfx/*.wav を FLAC(可逆)にして base64 で埋め込んだもの。
 * file:// で開くと fetch が CORS で弾かれるため、効果音だけは埋め込みにして
 * どの開き方でも 16分グリッドへ正確にクオンタイズできるようにしている。
 * FLAC は可逆かつエンコーダ遅延がないので、発音タイミングが原音とずれない
 * （AAC/MP3 は数十msの前詰めが入る）。
 *
 * 作り直すには: python3 tools/sfx.py && python3 tools/embed_sfx.py
 */
const SFX_ASSETS = {
"""


def main():
    names = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(SRC, "*.wav")))
    out = [HEAD]
    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for n in names:
            f = os.path.join(tmp, n + ".flac")
            subprocess.run([FF, "-v", "error", "-y", "-i", os.path.join(SRC, n + ".wav"),
                            "-c:a", "flac", "-compression_level", "12", f], check=True)
            b = base64.b64encode(open(f, "rb").read()).decode()
            total += len(b)
            out.append(f'  "{n}": "{b}",\n')
    out.append("};\n")
    open(DST, "w").write("".join(out))
    print(f"{len(names)} 音 → {os.path.relpath(DST, ROOT)}  {total/1e6:.2f} MB(base64)")


if __name__ == "__main__":
    main()
