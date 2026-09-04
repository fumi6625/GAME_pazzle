#!/usr/bin/env python3
"""タッチ操作のボタンが「指で押せる大きさ」かを物理寸法で確かめる。

CSS px のままでは判断できない。実機の CSS ビューポート(pt/dp)と
画面の物理サイズから mm を出して、指針と突き合わせる。

  Apple HIG        最小 44x44 pt
  Material Design  最小 48x48 dp
  実測の指の接触面  人差し指 8〜10mm / 親指 10〜14mm
  → 動きの速いゲームで親指を使うなら 9mm(≒55pt) 以上ほしい。

注意: これまでのスクリーンショットは 1568x720 で撮っていたが、
これは参考画面の「物理ピクセル」であって CSS ビューポートではない。
実機の横持ちは 667x375 〜 932x430 pt しかなく、その差は2倍。
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://127.0.0.1:8765/index.html")
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

# (名前, CSSビューポート幅, 高さ, mm/pt) — 横持ち
DEVICES = [
    ("iPhone SE(3)",      667, 375, 0.1560),
    ("iPhone 13/14",      844, 390, 0.1656),
    ("iPhone 15 Pro Max", 932, 430, 0.1657),
    ("Pixel 7",           915, 412, 0.1600),
]
MIN_PT = 44        # Apple HIG の最小
GOOD_MM = 9.0      # 親指で速く押すのに欲しい大きさ

TARGETS = [
    ("左移動",   ".mbtn[data-act='left']"),
    ("右移動",   ".mbtn[data-act='right']"),
    ("BURST A",  ".tbtn-a"),
    ("BURST B",  ".tbtn-b"),
    ("左回転",   ".touchpad .tbtn-rot:nth-of-type(3)"),
    ("右回転",   ".touchpad .tbtn-rot:nth-of-type(4)"),
    ("即落下",   ".tbtn-hard"),
    ("一時停止", ".toptouch .tbtn:nth-of-type(1)"),
]


def main():
    allok = True
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME,
                              args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
                                    "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        for name, W, H, mmpt in DEVICES:
            c = b.new_context(viewport={"width": W, "height": H},
                              is_mobile=True, has_touch=True, device_scale_factor=3)
            pg = c.new_page()
            pg.goto(URL); pg.wait_for_timeout(600)
            pg.tap("#start-btn"); pg.wait_for_timeout(700)
            print(f"\n[{name}] {W}x{H} pt / {W*mmpt:.0f}x{H*mmpt:.0f} mm  "
                  f"({mmpt:.4f} mm/pt)")
            print(f"  {'ボタン':<9s} {'pt':>11s} {'mm':>11s}  短辺  判定")
            for label, sel in TARGETS:
                el = pg.query_selector(sel)
                if not el:
                    print(f"  {label:<9s} 見つからない × NG"); allok = False; continue
                r = el.bounding_box()
                w, h = r["width"], r["height"]
                mn = min(w, h)
                mmv = mn * mmpt
                if mn >= 55: mark = "◎ 余裕"
                elif mn >= MIN_PT: mark = "○ 最小は満たす"
                else: mark = "× NG 小さすぎ"
                if mn < MIN_PT: allok = False
                print(f"  {label:<9s} {w:5.0f}x{h:<5.0f} {w*mmpt:5.1f}x{h*mmpt:<5.1f} "
                      f"{mmv:4.1f}mm {mark}")
            # 画面からはみ出していないか（レールが狭いと押せない位置へ出る）
            out = pg.evaluate("""() => {
              const bad=[];
              for (const e of document.querySelectorAll('.touchpad .tbtn, .movepad .mbtn, .toptouch .tbtn')) {
                const b=e.getBoundingClientRect();
                if (b.left<-1||b.top<-1||b.right>innerWidth+1||b.bottom>innerHeight+1)
                  bad.push(e.getAttribute('data-act')||e.className);
              }
              return bad; }""")
            if out:
                print(f"  ★ 画面外へはみ出し: {', '.join(out)} × NG"); allok = False
            # ボタン同士の間隔（誤タップ防止に 8pt 以上ほしい）
            gaps = pg.evaluate("""() => {
              const es=[...document.querySelectorAll('.touchpad .tbtn, .movepad .mbtn')]
                .map(e=>e.getBoundingClientRect());
              let m=1e9;
              for (let i=0;i<es.length;i++) for (let j=i+1;j<es.length;j++){
                const a=es[i],b=es[j];
                const dx=Math.max(0, Math.max(a.left-b.right, b.left-a.right));
                const dy=Math.max(0, Math.max(a.top-b.bottom, b.top-a.bottom));
                if (dx===0&&dy===0) continue;
                m=Math.min(m, Math.hypot(dx,dy));
              }
              return m===1e9?null:m; }""")
            if gaps is not None:
                ok = gaps >= 6
                if not ok: allok = False
                print(f"  ボタン間の最小すき間 {gaps:.0f}pt / {gaps*mmpt:.1f}mm "
                      f"{'OK' if ok else '× NG 近すぎ'}")
            c.close()
        b.close()
    print("\n判定:", "合格" if allok else "不合格")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
