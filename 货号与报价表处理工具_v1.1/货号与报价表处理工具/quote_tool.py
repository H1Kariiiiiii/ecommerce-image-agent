# -*- coding: utf-8 -*-
"""
报价表图片/货号批量替换 —— 纯算法，不依赖 Office、不调用 AI 模型
====================================================================

直接改 .xlsx 这个 zip 包里的三个部分，**其它部件一个字节不碰**，
所以列宽、行高、字体、边框、对齐、合并单元格、下拉筛选、图片锚点全部原样保留：

  1. xl/media/*.jpeg    —— 换成新图（新图会按原图尺寸缩放后再编码，排版不变）
  2. xl/drawings/drawing*.xml
                        —— 图片名称/描述里的旧货号改成新货号
  3. xl/sharedStrings.xml
                        —— 货号列的文字改掉

不支持老式 .xls（OLE2 二进制）。请先在 Excel/WPS 里「另存为 .xlsx」再用本工具。
"""

from __future__ import annotations

import argparse
import io
import os
import re
import shutil
import sys
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

import numpy as np
from PIL import Image

__version__ = "1.0.0"

NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships"

DRAWING_RE = re.compile(r"^xl/drawings/drawing\d+\.xml$")
SHEET_RE = re.compile(r"^xl/worksheets/sheet\d+\.xml$")
CONTENT_TYPES = "[Content_Types].xml"
REL_EXT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def looks_like_xlsx(path: str) -> tuple[bool, str]:
    """判断是不是真正的 xlsx。

    注意：老式 .xls（OLE2）内部也含有一个小的 zip（主题文件），
    所以不能只用 zipfile.is_zipfile() 判断，必须看有没有工作表。
    """
    if not zipfile.is_zipfile(path):
        return False, "不是 zip 结构（老式 .xls 或已损坏）"
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except Exception as e:
        return False, f"zip 打不开: {e}"
    if not any(SHEET_RE.match(n) for n in names):
        if any("/media/" in n for n in names) or len(names) < 20:
            return False, ("里面没有工作表，这是老式 .xls 被改了扩展名"
                           "（.xls 内部含一个小 zip，容易误判）")
        return False, "里面没有工作表，可能不是 Excel 文件"
    return True, ""


# --------------------------------------------------------------------------- 结构解析


@dataclass
class Picture:
    drawing: str          # 绘图部件路径
    media: str            # 图片部件路径
    code: str             # 货号（来自 descr 或 name）
    kind: str             # 'descr' 或 'name'
    ext: str              # 原图片扩展名（小写）
    size: tuple[int, int] | None = None


@dataclass
class Plan:
    pictures: list[Picture] = field(default_factory=list)
    code_strings: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _norm_media(drawing: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    base = os.path.dirname(drawing)
    return os.path.normpath(os.path.join(base, target)).replace("\\", "/")


def read_pictures(z: zipfile.ZipFile) -> list[Picture]:
    """从每个 drawing 部件读出「图片部件 -> 货号」的对应关系。"""
    out: list[Picture] = []
    for name in z.namelist():
        if not DRAWING_RE.match(name):
            continue
        rels = name.replace("drawings/", "drawings/_rels/") + ".rels"
        rel_map: dict[str, str] = {}
        if rels in z.namelist():
            for r in ET.fromstring(z.read(rels)):
                if r.get("Type", "").endswith("/image"):
                    rel_map[r.get("Id")] = r.get("Target", "")
        root = ET.fromstring(z.read(name))
        for pic in root.iter(f"{{{NS_XDR}}}pic"):
            nv = pic.find(f"{{{NS_XDR}}}nvPicPr/{{{NS_XDR}}}cNvPr")
            blip = pic.find(f".//{{{NS_A}}}blip")
            if nv is None or blip is None:
                continue
            rid = blip.get(f"{{{NS_R}}}embed")
            target = rel_map.get(rid)
            if not target:
                continue
            media = _norm_media(name, target)
            descr = nv.get("descr")
            name_attr = nv.get("name")
            if descr:
                code, kind = descr.strip(), "descr"
            elif name_attr:
                code, kind = name_attr.strip(), "name"
            else:
                continue
            out.append(Picture(name, media, code, kind, os.path.splitext(media)[1].lower().lstrip(".")))
    return out


def mapping_candidates(code: str, old: str, new: str) -> list[str]:
    """给一个货号，列出可能的新货号（按优先级）。"""
    c = code.strip()
    out = []
    if old and c.startswith(old):
        out.append(new + c[len(old):])
    out.append(c)
    # 去掉 "NO." 前缀再试
    if c.upper().startswith("NO."):
        body = c[3:]
        if old and body.startswith(old):
            out.append(new + body[len(old):])
    return out


def build_plan(
    z: zipfile.ZipFile,
    img_dir: str,
    old: str,
    new: str,
    recursive: bool,
) -> Plan:
    plan = Plan()
    plan.pictures = read_pictures(z)
    if not plan.pictures:
        plan.warnings.append("这个 xlsx 里没有找到浮动图片（drawing 引用）")

    # 建立图片库：货号 -> 文件路径（文件名去扩展名）
    lib: dict[str, str] = {}
    exts = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
    walker = os.walk(img_dir) if recursive else [(img_dir, [], os.listdir(img_dir))]
    for root, _dirs, files in walker:
        for f in files:
            if f.lower().endswith(exts):
                lib.setdefault(os.path.splitext(f)[0], os.path.join(root, f))

    for p in plan.pictures:
        hit = None
        for cand in mapping_candidates(p.code, old, new):
            if cand in lib:
                hit = lib[cand]
                break
        if hit is None:
            plan.warnings.append(f"找不到图片: 货号 {p.code!r}（图片文件夹里没有对应文件）")
            continue
        p.new_file = hit  # type: ignore[attr-defined]
        try:
            with Image.open(hit) as im:
                p.size = im.size
        except Exception as e:
            plan.warnings.append(f"图片打不开 {hit}: {e}")

    # 货号文字
    if "xl/sharedStrings.xml" in z.namelist():
        txt = z.read("xl/sharedStrings.xml").decode("utf-8")
        seen = set()
        for m in re.finditer(r"<t(?:\s[^>]*)?>([^<]*)</t>", txt):
            s = m.group(1)
            body = s.strip()
            if not body or body in seen:
                continue
            if old and body.startswith(old):
                seen.add(body)
                plan.code_strings.append((s, new + s.strip()[len(old):]))
            elif body.upper().startswith("NO." + old):
                seen.add(body)
                plan.code_strings.append((s, s.replace(old, new, 1)))
    else:
        plan.warnings.append("没有 sharedStrings.xml，跳过货号文字替换")

    return plan


# --------------------------------------------------------------------------- 图片编码


def encode_like(source_new: str, target_size: tuple[int, int], target_fmt: str,
                orig_bytes: bytes, quality: int = 92) -> bytes:
    """把新图缩放到 target_size，按原格式编码。"""
    with Image.open(source_new) as im:
        im = im.convert("RGB")
        if target_size and im.size != target_size:
            im = im.resize(target_size, Image.LANCZOS)
        buf = io.BytesIO()
        if target_fmt in ("jpg", "jpeg"):
            im.save(buf, "JPEG", quality=quality, subsampling=0, optimize=True)
        elif target_fmt == "png":
            im.save(buf, "PNG", optimize=True)
        else:
            im.save(buf, target_fmt.upper() if target_fmt else "JPEG", quality=quality)
        return buf.getvalue()


# --------------------------------------------------------------------------- 打补丁


def patch_xlsx(
    src: str,
    dst: str,
    img_dir: str,
    old: str,
    new: str,
    recursive: bool = False,
    quality: int = 92,
    dry_run: bool = False,
) -> tuple[Plan, dict]:
    z = zipfile.ZipFile(src)
    plan = build_plan(z, img_dir, old, new, recursive)

    stats = {"pictures_planned": 0, "pictures_done": 0, "codes_done": 0, "media_new": 0}

    pics = [p for p in plan.pictures if getattr(p, "new_file", None)]
    stats["pictures_planned"] = len(pics)

    # 新的 media 字节
    media_new: dict[str, bytes] = {}
    for p in pics:
        orig = z.read(p.media)
        try:
            with Image.open(io.BytesIO(orig)) as oim:
                target_size = oim.size
        except Exception:
            target_size = p.size
        data = encode_like(p.new_file, target_size, p.ext or "jpeg", orig, quality)
        media_new[p.media] = data

    # drawing XML：改 descr / name 里的货号
    draw_new: dict[str, bytes] = {}
    touched_drawings = set(p.drawing for p in pics)
    for dname in touched_drawings:
        raw = z.read(dname)
        out = raw
        for p in pics:
            if p.drawing != dname:
                continue
            nc = new + p.code[len(old):] if old and p.code.startswith(old) else p.code
            if p.kind == "descr":
                out = out.replace(f'descr="{p.code}"'.encode(), f'descr="{nc}"'.encode())
            else:
                out = out.replace(f'name="{p.code}"'.encode(), f'name="{nc}"'.encode())
        draw_new[dname] = out

    # sharedStrings
    ss_new = None
    if plan.code_strings and "xl/sharedStrings.xml" in z.namelist():
        raw = z.read("xl/sharedStrings.xml").decode("utf-8")
        for old_s, new_s in plan.code_strings:
            raw = raw.replace(f"<t>{old_s}</t>", f"<t>{new_s}</t>")
            raw = raw.replace(f'<t xml:space="preserve">{old_s}</t>',
                              f'<t xml:space="preserve">{new_s}</t>')
        ss_new = raw.encode("utf-8")
        stats["codes_done"] = len(plan.code_strings)

    stats["media_new"] = len(media_new)
    if dry_run:
        z.close()
        return plan, stats

    # 写新包
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    tmp = dst + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as out:
        for info in z.infolist():
            n = info.filename
            if n in media_new:
                data = media_new[n]
            elif n in draw_new:
                data = draw_new[n]
            elif n == "xl/sharedStrings.xml" and ss_new is not None:
                data = ss_new
            else:
                data = z.read(n)
            ni = zipfile.ZipInfo(filename=n, date_time=info.date_time)
            ni.compress_type = zipfile.ZIP_DEFLATED
            ni.external_attr = info.external_attr
            ni.create_system = info.create_system
            out.writestr(ni, data)
    z.close()
    os.replace(tmp, dst)
    stats["pictures_done"] = len(media_new)
    return plan, stats


# --------------------------------------------------------------------------- 校验


def verify_xlsx(path: str, old: str, new: str) -> list[str]:
    """打开结果文件做一致性检查，返回问题列表（空 = 通过）。"""
    issues: list[str] = []
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        return [f"打不开: {e}"]
    bad = z.testzip()
    if bad:
        issues.append(f"zip 损坏于 {bad}")

    for n in z.namelist():
        if n.endswith((".xml", ".rels")):
            try:
                ET.fromstring(z.read(n))
            except Exception as e:
                issues.append(f"{n} XML 解析失败: {e}")

    # 关系目标都必须存在
    for n in list(z.namelist()):
        if not n.endswith(".rels"):
            continue
        base = os.path.dirname(os.path.dirname(n))
        for r in ET.fromstring(z.read(n)):
            if r.get("TargetMode") == "External":
                continue
            import posixpath
            t = posixpath.normpath(posixpath.join(base, r.get("Target", "")))
            if t not in z.namelist():
                issues.append(f"{n} 指向不存在的部件 {t}")

    pics = read_pictures(z)
    left = [p.code for p in pics if old and p.code.startswith(old)]
    if left:
        issues.append(f"图片名称里仍有旧前缀 {old}: {left[:5]}")

    if "xl/sharedStrings.xml" in z.namelist():
        txt = z.read("xl/sharedStrings.xml").decode("utf-8")
        codes = re.findall(r"<t(?:\s[^>]*)?>([^<]*)</t>", txt)
        residual = [c for c in codes if old and c.strip().startswith(old)]
        if residual:
            issues.append(f"货号文字里仍有旧前缀 {old}: {residual[:5]}")

    # 内容类型覆盖
    if CONTENT_TYPES in z.namelist():
        ct = ET.fromstring(z.read(CONTENT_TYPES))
        defaults = {d.get("Extension", "").lower() for d in ct.findall(f"{{{NS_CT}}}Default")}
        overrides = {o.get("PartName") for o in ct.findall(f"{{{NS_CT}}}Override")}
        for n in z.namelist():
            if n == CONTENT_TYPES:
                continue
            # 扩展名 = 最后一个点之后的部分。"xl/a.xml.rels" -> "rels"，
            # "_rels/.rels" 这种以点开头的名字也要取到 "rels"。
            base = os.path.basename(n)
            ext = base.rsplit(".", 1)[1].lower() if "." in base else ""
            if "/" + n in overrides or ext in defaults:
                continue
            issues.append(f"缺少内容类型声明: {n}")
    z.close()
    return issues


# --------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="报价表替换工具",
        description="把报价表里的旧图换成新图，并把货号列的前缀改掉（纯算法，不用 Office）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  # 试跑，只看计划
  python quote_tool.py -q 报价表.xlsx -d 新产品图片 --old JT --new TJ --dry-run

  # 输出到新文件
  python quote_tool.py -q 报价表.xlsx -d 新产品图片 --old JT --new TJ -o 报价表_TJ.xlsx

  # 就地替换（会先自动备份）
  python quote_tool.py -q 报价表.xlsx -d 新产品图片 --old JT --new TJ --inplace
""")
    p.add_argument("-q", "--quote", required=True, help="报价表 .xlsx")
    p.add_argument("-d", "--img-dir", required=True, help="新图片所在文件夹（文件名=新货号）")
    p.add_argument("-o", "--output", help="输出 xlsx（默认 报价表_新.xlsx）")
    p.add_argument("--inplace", action="store_true", help="直接覆盖原报价表（自动备份）")
    p.add_argument("--old", default="JT", help="旧前缀（默认 JT）")
    p.add_argument("--new", default="TJ", help="新前缀（默认 TJ）")
    p.add_argument("-r", "--recursive", action="store_true", help="图片文件夹递归子目录")
    p.add_argument("--quality", type=int, default=92, help="图片重编码质量（默认 92）")
    p.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("-V", "--version", action="version", version=f"报价表替换工具 {__version__}")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    src = args.quote
    if not os.path.exists(src):
        print(f"[!] 找不到报价表: {src}")
        return 2
    ok, why = looks_like_xlsx(src)
    if not ok:
        print(f"[!] {why}")
        print("    请用 Excel/WPS 打开它，「另存为」→ 选「Excel 工作簿 (*.xlsx)」，再用本工具。")
        print("    （只是把 .xls 改名成 .xlsx 是不行的，内部结构没变）")
        return 3
    if not os.path.isdir(args.img_dir):
        print(f"[!] 找不到图片文件夹: {args.img_dir}")
        return 2

    if args.inplace:
        bk = src + ".bak"
        if not os.path.exists(bk):
            shutil.copy2(src, bk)
            print(f"[备份] {os.path.basename(bk)}")
        dst = src
    else:
        dst = args.output or os.path.splitext(src)[0] + "_新.xlsx"

    print(f"[i] 报价表: {os.path.basename(src)}  ({os.path.getsize(src):,} B)")
    print(f"[i] 新图片: {args.img_dir}")
    print(f"[i] 货号前缀: {args.old} -> {args.new}")
    print()

    plan, stats = patch_xlsx(src, dst, args.img_dir, args.old, args.new,
                             args.recursive, args.quality, args.dry_run)

    print(f"计划: 替换图片 {stats['pictures_planned']} 张, 改货号文字 {stats['codes_done']} 处")
    if plan.warnings:
        print()
        print("注意:")
        for w in plan.warnings:
            print(f"  - {w}")
    print()
    print(f"{'货号（旧 -> 新）':<42} {'图片部件':<24} {'新图文件'}")
    print("-" * 110)
    for p in plan.pictures:
        nf = getattr(p, "new_file", None)
        nc = (args.new + p.code[len(args.old):]) if (args.old and p.code.startswith(args.old)) else p.code
        print(f"{p.code + ' -> ' + nc:<42} {p.media:<24} {os.path.basename(nf) if nf else '(缺失)'}")

    if args.dry_run:
        print()
        print("[试跑] 没有写任何文件。")
        return 0

    print()
    print(f"[完成] 已写出 {dst}  ({os.path.getsize(dst):,} B)")
    issues = verify_xlsx(dst, args.old, args.new)
    if issues:
        print()
        print("[校验] 发现问题:")
        for i in issues:
            print(f"  ✗ {i}")
        return 1
    print("[校验] ✓ zip 完整、XML 可解析、关系与内容类型齐全、无旧前缀残留")
    return 0


if __name__ == "__main__":
    sys.exit(main())
