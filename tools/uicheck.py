#!/usr/bin/env python3
"""画面レイアウトが docs/UI_REFERENCE.md の目標どおりかを数値で確かめる。

参考画面（ルミネス リマスター / モバイル）を実測して決めた合格条件を、
実際の DOM の座標と突き合わせる。目視の比較用エージェントは
「絵として似ているか」を見るが、こちらは寸法をずらさないための歯止め。

使い方: python3 tools/uicheck.py [幅x高さ ...]
        （先に python3 -m http.server 8765 をリポジトリ直下で起動しておく）
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://127.0.0.1:8765/index.html")
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
SIZES = sys.argv[1:] or ["1568x720", "932x430", "1440x900"]

# (名前, 下限, 上限) — 画面幅/高さに対する割合
RULES = {
    "盤面の左端": (0.23, 0.29), "盤面の右端": (0.71, 0.78),
    "盤面の上端": (0.23, 0.31), "盤面の下端": (0.87, 0.94),
    "左レールの幅": (0.06, 0.16), "右レールの幅": (0.11, 0.19),
}


def check(pg, W, H, touch):
    def rect(sel):
        return pg.eval_on_selector(sel, "e=>{const b=e.getBoundingClientRect();"
                                        "return {x:b.x,y:b.y,w:b.width,h:b.height,"
                                        "r:b.right,b:b.bottom}}") if pg.query_selector(sel) else None
    # 参考画面の比率に切り出した .game-area を基準に測る
    ga = rect(".game-area")
    W, H = ga["w"], ga["h"]
    ox, oy = ga["x"], ga["y"]
    bd = rect(".board-wrap")
    lr, rr = rect(".rail-left"), rect(".rail-right")
    for r in (bd, lr, rr):
        r["x"] -= ox; r["r"] -= ox; r["y"] -= oy; r["b"] -= oy
    got = {
        "盤面の左端": bd["x"] / W, "盤面の右端": bd["r"] / W,
        "盤面の上端": bd["y"] / H, "盤面の下端": bd["b"] / H,
        "左レールの幅": lr["w"] / W, "右レールの幅": rr["w"] / W,
    }
    ok = True
    for k, (lo, hi) in RULES.items():
        v = got[k]
        good = lo <= v <= hi
        ok &= good
        print(f"  {k:<12s} {v*100:5.1f}%  目標 {lo*100:.0f}〜{hi*100:.0f}%  {'OK' if good else '× NG'}")
    cell = pg.evaluate("""() => {const b=document.querySelector('#board').getBoundingClientRect();
        return {w:b.width/16, h:b.height/12}}""")
    ar = cell["w"] / cell["h"]
    print(f"  セルの縦横比   {ar:5.2f}    目標 0.90〜1.10        {'OK' if 0.9 <= ar <= 1.1 else '× NG'}")
    ok &= 0.9 <= ar <= 1.1

    q = pg.evaluate("LUMINA && LUMINA.nextQueue ? LUMINA.nextQueue().length : 0")
    print(f"  左レールの次コマ {q} 個   目標 3 個              {'OK' if q == 3 else '× NG'}")
    ok &= q == 3

    labels = pg.eval_on_selector_all(".hud .stat-label", "es=>es.map(e=>e.textContent.trim())")
    want = ["LEVEL", "TIME", "SCORE", "HI-SCORE", "ERASED"]
    miss = [w for w in want if w not in labels]
    print(f"  右レールの項目 {'すべてある' if not miss else '欠け: ' + ','.join(miss)}"
          f"            {'OK' if not miss else '× NG'}")
    ok &= not miss

    if touch:
        a, rot, hard = rect(".tbtn-a"), rect(".tbtn-rot"), rect(".tbtn-hard")
        if a and rot and hard:
            o1, o2 = a["y"] < rot["y"], rot["y"] < hard["y"]
            print(f"  BURST が回転の上   {'OK' if o1 else '× NG'}")
            print(f"  回転が即落下の上   {'OK' if o2 else '× NG'}")
            ok &= o1 and o2
        else:
            print("  操作ボタンが見つからない × NG"); ok = False

    # はみ出しは .game-area の枠を基準に見る（レターボックスの外は背景）
    over = pg.evaluate("""() => {
        const g=document.querySelector('.game-area').getBoundingClientRect();
        const bad=[];
        for (const e of document.querySelectorAll(
             '.rail *, .main > *, .hud .stat, .touchpad .tbtn, .movepad .mbtn')) {
          const b=e.getBoundingClientRect();
          if (b.width===0||b.height===0) continue;
          if (b.left<g.left-1||b.top<g.top-1||b.right>g.right+1||b.bottom>g.bottom+1)
            bad.push((e.id||e.className||e.tagName)+'');
        }
        return [...new Set(bad)].slice(0,6); }""")
    print(f"  画面内に収まる   {'OK' if not over else '× NG ' + ', '.join(over)}")
    ok &= not over
    return ok


def main():
    allok = True
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME,
                              args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required",
                                    "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        for s in SIZES:
            W, H = (int(v) for v in s.split("x"))
            touch = W < 1200
            c = b.new_context(viewport={"width": W, "height": H},
                              is_mobile=touch, has_touch=touch)
            pg = c.new_page()
            pg.goto(URL); pg.wait_for_timeout(700)
            pg.click("#start-btn"); pg.wait_for_timeout(900)
            print(f"\n[{s}] {'スマホ' if touch else 'PC'}")
            allok &= check(pg, W, H, touch)
            c.close()
        b.close()
    print("\n判定:", "合格" if allok else "不合格")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
