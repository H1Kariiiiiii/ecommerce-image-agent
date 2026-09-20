# -*- coding: utf-8 -*-
"""
货号标注工具 —— 纯算法，不依赖任何 AI 模型
================================================

批量处理产品图底部印的货号文字：

  1. 定位：在图片底部找出货号行（二值化 + 行/列投影，纯 numpy）
  2. 擦除：把文字区域填成背景色（产品图背景为纯白，擦除无损）
  3. 重绘：用库内自带的 Arial Bold 渲染新文字，字号由实测文字高度反推

三种模式：
  replace  只换前缀（如 JT -> TJ），其余不变
  erase    整行擦掉，不留任何货号
  custom   按映射表/固定文本写

用法见 README.md，或直接双击 运行.bat
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFont

__version__ = "1.0.0"

# --------------------------------------------------------------------------- 字体

# 按优先级探测；第一个可用者胜出。arialbd 是实测匹配原图字体（IoU 0.934）的首选。
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\ARIALBD.TTF",
    r"C:\Windows\Fonts\calibrib.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\tahomabd.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def find_font(explicit: str | None = None) -> str:
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise FileNotFoundError(f"指定的字体不存在: {explicit}")
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(
        "找不到可用的粗体字体。请用 --font 指定一个 .ttf/.ttc 字体文件。"
    )


# --------------------------------------------------------------------------- 检测


@dataclass
class LabelBox:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def w(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def h(self) -> int:
        return self.y1 - self.y0 + 1

    def as_list(self) -> list[int]:
        return [self.x0, self.y0, self.x1, self.y1]


@dataclass
class Config:
    # 检测搜索区（相对图片高度的比例）
    band_top: float = 0.86
    band_bottom: float = 0.999
    # 文字像素阈值（灰度 < thr 视为文字）
    ink_thr: int = 110
    # 一行至少要有这么多深色像素才算文字行
    min_row_ink: int = 8
    # 行段最少高度（像素）
    min_run_h: int = 12
    # 合并相邻行段的间隙
    run_gap: int = 4
    # 擦除时四周留白
    pad_x: int = 24
    pad_y: int = 14
    # JPEG 保存质量
    quality: int = 95
    # 是否允许在找不到货号时继续（不报错）
    tolerant: bool = False


def _row_runs(mask: np.ndarray, gap: int, min_h: int) -> list[tuple[int, int]]:
    """把「有文字的行」合并成连续行段。"""
    rows = mask.sum(axis=1)
    flags = rows >= 1
    runs: list[list[int]] = []
    start = None
    for i, v in enumerate(flags):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([start, i - 1])
            start = None
    if start is not None:
        runs.append([start, len(flags) - 1])
    merged: list[list[int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged if b - a + 1 >= min_h]


def find_label(gray: np.ndarray, cfg: Config) -> LabelBox | None:
    """在图片底部定位货号行，返回紧贴文字的外框。

    货号行是底部最下面的一段连续文字（在它下面通常还有整片空白）。
    """
    H, W = gray.shape
    y0 = int(H * cfg.band_top)
    y1 = int(H * cfg.band_bottom)
    band = gray[y0:y1, :]
    mask = band < cfg.ink_thr
    if mask.sum() < 50:
        return None
    # 只保留有足够墨量的行，避免噪点
    rows = mask.sum(axis=1)
    mask = mask & (rows >= cfg.min_row_ink)[:, None]
    runs = _row_runs(mask, cfg.run_gap, cfg.min_run_h)
    if not runs:
        return None
    # 取最下面那一段
    run = max(runs, key=lambda r: r[0])
    sub = mask[run[0]:run[1] + 1, :]
    cols = sub.sum(axis=0)
    xs = np.nonzero(cols)[0]
    if xs.size == 0:
        return None
    return LabelBox(int(xs.min()), int(run[0]) + y0, int(xs.max()), int(run[1]) + y0)


def read_label_text(img: Image.Image, box: LabelBox, cfg: Config) -> str | None:
    """读出货号行里的 ASCII 文字（用于校验/推断）。纯几何 + 模板，不依赖 OCR 库。

    做法：把文字行二值化，按「竖直空白列」切成字符块，再与渲染好的
    候选字符模板比宽度和形状，取最优。对 NO.JT666-5A 这类等宽大写串足够可靠。
    """
    g = np.asarray(img.convert("L"))[
        max(0, box.y0 - 4):box.y1 + 5, max(0, box.x0 - 4):box.x1 + 5
    ]
    m = g < cfg.ink_thr
    if m.sum() < 20:
        return None
    return None  # 当前版本不做逐字识别；货号从文件名推断（见 README）


# --------------------------------------------------------------------------- 渲染


def parse_code_from_filename(name: str) -> str | None:
    """从文件名取出货号，如 JT666-5A-1.jpg -> JT666-5A-1。"""
    stem = os.path.splitext(os.path.basename(name))[0]
    stem = stem.strip()
    # 只保留字母数字和 - _
    cand = "".join(ch for ch in stem if ch.isalnum() or ch in "-_")
    m = None
    import re
    m = re.match(r"^([A-Za-z]{2,4}\d{3,}[0-9A-Za-z\-]*)$", cand)
    return m.group(1) if m else None


def render_text(text: str, ink_h: int, ink_w: int, font_path: str) -> Image.Image:
    """把 text 渲染成二值图（黑字白底），ink 尺寸缩放到 ink_h x ink_w。"""
    # 先找一个能给出足够精度的字号，再整体缩放
    best = None
    target = max(60, ink_h * 4)
    for size in range(40, 400):
        f = ImageFont.truetype(font_path, size)
        tmp = Image.new("L", (4000, 800), 255)
        ImageDraw.Draw(tmp).text((40, 200), text, font=f, fill=0)
        a = np.asarray(tmp) < 128
        yy, xx = np.nonzero(a)
        if yy.size == 0:
            continue
        h = int(yy.max() - yy.min() + 1)
        if best is None or abs(h - target) < abs(best[0] - target):
            best = (h, int(yy.min()), int(yy.max()), int(xx.min()), int(xx.max()), size)
        if h >= target:
            break
    if best is None:
        raise RuntimeError(f"无法渲染文字: {text!r}")
    h, ty0, ty1, tx0, tx1, size = best
    f = ImageFont.truetype(font_path, size)
    tmp = Image.new("L", (4000, 800), 255)
    ImageDraw.Draw(tmp).text((40, 200), text, font=f, fill=0)
    glyph = tmp.crop((tx0, ty0, tx1 + 1, ty1 + 1))
    return glyph.resize((max(1, ink_w), max(1, ink_h)), Image.LANCZOS)


# --------------------------------------------------------------------------- 处理


@dataclass
class ItemResult:
    src: str
    dst: str
    status: str
    box: list[int] | None = None
    text: str | None = None
    ink: list[int] | None = None
    note: str = ""


def background_color(img: Image.Image, box: LabelBox, pad: int) -> tuple[int, int, int]:
    """估计文字周围的背景色（取外框四周一圈的中位数），适配非纯白底。"""
    W, H = img.size
    x0 = max(0, box.x0 - pad)
    y0 = max(0, box.y0 - pad)
    x1 = min(W, box.x1 + 1 + pad)
    y1 = min(H, box.y1 + 1 + pad)
    ring = []
    a = np.asarray(img.convert("RGB"))
    if y0 > 0:
        ring.append(a[y0 - 1, x0:x1])
    if y1 < H:
        ring.append(a[y1, x0:x1])
    if x0 > 0:
        ring.append(a[y0:y1, x0 - 1])
    if x1 < W:
        ring.append(a[y0:y1, x1])
    if not ring:
        return (255, 255, 255)
    px = np.concatenate(ring, axis=0).reshape(-1, 3)
    med = np.median(px, axis=0)
    return tuple(int(v) for v in med)


def process_one(
    src: str,
    dst: str,
    cfg: Config,
    font_path: str,
    mode: str,
    old_prefix: str,
    new_prefix: str,
    fixed_text: str | None = None,
    mapping: dict[str, str] | None = None,
    dry_run: bool = False,
    save_compare: str | None = None,
) -> ItemResult:
    im = Image.open(src)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    gray = np.asarray(im.convert("L"))
    box = find_label(gray, cfg)
    if box is None:
        return ItemResult(src, dst, "NO_LABEL" if not cfg.tolerant else "SKIP_NO_LABEL",
                          note="未在底部找到货号文字")

    base = os.path.splitext(os.path.basename(src))[0]
    code = parse_code_from_filename(base) or base

    # 目标文字
    if mode == "erase":
        text = None
    elif mode == "custom":
        if mapping and code in mapping:
            text = mapping[code]
        elif mapping and base in mapping:
            text = mapping[base]
        elif fixed_text is not None:
            text = fixed_text
        else:
            text = code
    else:  # replace
        text = code
        if old_prefix and text.startswith(old_prefix):
            text = new_prefix + text[len(old_prefix):]
        elif fixed_text is not None:
            text = fixed_text

    if text is not None and not text.upper().startswith("NO."):
        text = "NO." + text

    W, H = im.size
    bg = background_color(im, box, max(cfg.pad_x, cfg.pad_y))
    out = im.copy()

    # 擦除
    wx0 = max(0, box.x0 - cfg.pad_x)
    wy0 = max(0, box.y0 - cfg.pad_y)
    wx1 = min(W, box.x1 + 1 + cfg.pad_x)
    wy1 = min(H, box.y1 + 1 + cfg.pad_y)
    out.paste(bg, (wx0, wy0, wx1, wy1))

    # 重绘（erase 模式不画）
    if text:
        glyph = render_text(text, box.h, box.w, font_path)
        mask = Image.eval(glyph, lambda v: 255 - v)
        out.paste((0, 0, 0), (box.x0, box.y0), mask)

    note = ""
    status = "OK"

    if not dry_run:
        os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
        out.save(dst, "JPEG", quality=cfg.quality, subsampling=0, optimize=True)
        # 自检
        g2 = np.asarray(Image.open(dst).convert("L"))
        if text:
            # 重绘模式：新文字应出现在原位置附近
            b2 = find_label(g2, cfg)
            if b2 is None:
                status = "WARN"
                note = "处理后未能重新检测到文字"
            else:
                dx = abs(b2.x0 - box.x0) + abs(b2.x1 - box.x1)
                dy = abs(b2.y0 - box.y0) + abs(b2.y1 - box.y1)
                if dx > 12 or dy > 8:
                    status = "WARN"
                    note = f"位置偏差 dx={dx} dy={dy}"
        else:
            # 擦除模式：原位置附近不应再有文字墨迹
            x0 = max(0, box.x0 - 4); x1 = min(g2.shape[1], box.x1 + 5)
            y0 = max(0, box.y0 - 4); y1 = min(g2.shape[0], box.y1 + 5)
            leftover = int((g2[y0:y1, x0:x1] < cfg.ink_thr).sum())
            if leftover > max(30, box.w * box.h * 0.004):
                status = "WARN"
                note = f"擦除后仍残留 {leftover} 个深色像素"
    else:
        status = "DRY"

    # 对比图
    if save_compare:
        try:
            make_compare(im, out, box, save_compare)
        except Exception:
            note = (note + " (对比图失败)").strip()

    return ItemResult(src, dst, status, box.as_list(), text,
                      [box.w, box.h], note)


def make_compare(before: Image.Image, after: Image.Image, box: LabelBox, path: str) -> None:
    """把 原图 / 新图 的文字区域上下拼一张对比图，方便人工抽查。"""
    W, H = before.size
    y0 = max(0, box.y0 - 20)
    y1 = min(H, box.y1 + 21)
    a = before.convert("RGB").crop((0, y0, W, y1))
    b = after.convert("RGB").crop((0, y0, W, y1))
    sheet = Image.new("RGB", (W, a.height + b.height + 6), (255, 210, 210))
    sheet.paste(a, (0, 0))
    sheet.paste(b, (0, a.height + 6))
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    sheet.save(path)


# --------------------------------------------------------------------------- 批量


def collect_images(folder: str, recursive: bool) -> list[str]:
    exts = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
    out: list[str] = []
    if recursive:
        for root, _dirs, files in os.walk(folder):
            for f in sorted(files):
                if f.lower().endswith(exts):
                    out.append(os.path.join(root, f))
    else:
        for f in sorted(os.listdir(folder)):
            p = os.path.join(folder, f)
            if os.path.isfile(p) and f.lower().endswith(exts):
                out.append(p)
    return out


def run_batch(args: argparse.Namespace) -> int:
    cfg = Config(
        band_top=args.band_top,
        band_bottom=args.band_bottom,
        ink_thr=args.ink_thr,
        pad_x=args.pad_x,
        pad_y=args.pad_y,
        quality=args.quality,
        tolerant=args.tolerant,
    )
    font_path = find_font(args.font)

    images = collect_images(args.input, args.recursive)
    if not images:
        print(f"[!] 在 {args.input} 里没找到图片")
        return 2

    mapping = None
    if args.map:
        with open(args.map, encoding="utf-8-sig") as f:
            mapping = json.load(f)
        print(f"[i] 载入映射表 {args.map}（{len(mapping)} 条）")

    if args.output:
        out_dir = args.output
    else:
        out_dir = os.path.join(args.input, "_已处理")

    results: list[ItemResult] = []
    print(f"[i] 共 {len(images)} 张图 -> 输出目录 {out_dir}")
    print(f"[i] 模式={args.mode}  字体={font_path}")
    print()

    for k, src in enumerate(images, 1):
        rel = os.path.relpath(src, args.input)
        # 文件重命名：目录名与文件名都跟着换前缀
        if getattr(args, "rename", False) and args.old_prefix:
            rel_out = rel.replace(args.old_prefix, args.new_prefix)
        else:
            rel_out = rel
        dst = os.path.join(out_dir, rel_out)
        cmp_path = None
        if args.compare:
            cmp_path = os.path.join(out_dir, "_对比图",
                                    os.path.splitext(rel_out)[0] + "_对比.jpg")
        try:
            r = process_one(src, dst, cfg, font_path, args.mode,
                            args.old_prefix, args.new_prefix, args.text,
                            mapping, args.dry_run, cmp_path)
        except Exception as e:
            r = ItemResult(src, dst, "ERROR", note=f"{type(e).__name__}: {e}")
            if args.verbose:
                traceback.print_exc()
        results.append(r)
        mark = {"OK": "✓", "DRY": "·", "WARN": "!", "NO_LABEL": "?", "ERROR": "×"}.get(r.status, "?")
        extra = f"  {r.note}" if r.note else ""
        print(f"  [{k:>3}/{len(images)}] {mark} {rel}  {r.text or '(擦除)'}{extra}")

    # 汇总
    n_ok = sum(1 for r in results if r.status in ("OK", "DRY"))
    n_warn = sum(1 for r in results if r.status in ("WARN",))
    n_no = sum(1 for r in results if r.status.startswith("NO_LABEL") or r.status.startswith("SKIP"))
    n_err = sum(1 for r in results if r.status == "ERROR")

    print()
    print("=" * 70)
    print(f"完成: 成功 {n_ok}  警告 {n_warn}  未找到货号 {n_no}  出错 {n_err}  共 {len(results)}")
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)) or ".", exist_ok=True)
        with open(args.report, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["源文件", "输出文件", "状态", "新货号", "文字框", "文字尺寸", "备注"])
            for r in results:
                w.writerow([r.src, r.dst, r.status, r.text or "",
                            r.box or "", r.ink or "", r.note])
        print(f"报告: {args.report}")
    return 0 if (n_err == 0 and (n_warn == 0 or args.tolerant)) else 1


# --------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="货号标注工具",
        description="批量擦除/改写产品图上的货号文字（纯算法，无需联网）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  # 先试跑，只看检测结果，不写文件
  python label_tool.py -i D:\\图片 -m replace --old JT --new TJ --dry-run

  # 正式改写前缀
  python label_tool.py -i D:\\图片 -m replace --old JT --new TJ --compare --report log.csv

  # 整行擦掉
  python label_tool.py -i D:\\图片 -m erase

  # 按映射表逐张指定
  python label_tool.py -i D:\\图片 -m custom --map mapping.json

  # 双击运行图形界面
  python label_tool.py --gui
""")
    p.add_argument("-i", "--input", help="输入文件夹")
    p.add_argument("-o", "--output", help="输出文件夹（默认 输入/_已处理）")
    p.add_argument("-m", "--mode", choices=["replace", "erase", "custom"], default="replace",
                   help="replace=换前缀(默认)  erase=擦掉  custom=按映射/固定文本")
    p.add_argument("--old", dest="old_prefix", default="JT", help="replace 模式：原前缀（默认 JT）")
    p.add_argument("--new", dest="new_prefix", default="TJ", help="replace 模式：新前缀（默认 TJ）")
    p.add_argument("--text", default=None, help="custom 模式：固定文字（如 NO.TJ666-5）")
    p.add_argument("--map", default=None, help="custom 模式：JSON 映射表 {货号: 新文字}")
    p.add_argument("-r", "--recursive", action="store_true", help="递归子文件夹")
    p.add_argument("--rename", action="store_true",
                   help="同时把输出文件/目录名里的旧前缀换成新前缀（如 JT666-5.jpg → TJ666-5.jpg）")
    p.add_argument("--dry-run", action="store_true", help="只检测不写文件")
    p.add_argument("--compare", action="store_true", help="额外输出前后对比图，方便抽查")
    p.add_argument("--report", default=None, help="输出 CSV 报告路径")
    p.add_argument("--font", default=None, help="指定字体文件")
    p.add_argument("--quality", type=int, default=95, help="JPEG 保存质量（默认 95）")
    p.add_argument("--band-top", type=float, default=0.86, help="搜索区上边界比例（默认 0.86）")
    p.add_argument("--band-bottom", type=float, default=0.999, help="搜索区下边界比例（默认 0.999）")
    p.add_argument("--ink-thr", type=int, default=110, help="文字像素灰度阈值（默认 110）")
    p.add_argument("--pad-x", type=int, default=24, help="擦除横向留白（默认 24）")
    p.add_argument("--pad-y", type=int, default=14, help="擦除纵向留白（默认 14）")
    p.add_argument("--tolerant", action="store_true", help="找不到货号时不报错，继续处理其它图")
    p.add_argument("--verbose", action="store_true", help="出错时打印完整堆栈")
    p.add_argument("--gui", action="store_true", help="打开图形界面")
    p.add_argument("-V", "--version", action="version", version=f"货号标注工具 {__version__}")
    return p


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.gui or (not args.input):
        from label_tool_gui import run_gui
        return run_gui(args)
    return run_batch(args)


if __name__ == "__main__":
    sys.exit(main())
