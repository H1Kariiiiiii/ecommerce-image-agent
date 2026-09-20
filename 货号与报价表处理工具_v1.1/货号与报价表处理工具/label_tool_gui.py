# -*- coding: utf-8 -*-
"""货号标注工具 —— 图形界面（tkinter，Python 自带，无需额外安装）

两个页签就是完整流水线：
  页签一「图片文件」  —— 改写/擦除图片上的货号，并重命名文件（JT -> TJ）
  页签二「报价表」    —— 把报价表里的旧图换成新图，并改货号列
"""

from __future__ import annotations

import csv
import json
import os
import queue
import re
import threading
import traceback
from argparse import Namespace

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


# --------------------------------------------------------------------------- 页签一


class ImagesTab:
    """图片文件夹：底部货号改写/擦除 + 文件重命名。"""

    def __init__(self, parent: ttk.Frame, app: "App"):
        self.app = app
        f = parent

        box1 = ttk.LabelFrame(f, text="1. 图片位置", padding=8)
        box1.pack(fill="x", padx=8, pady=6)
        box1.columnconfigure(1, weight=1)

        ttk.Label(box1, text="输入文件夹：").grid(row=0, column=0, sticky="w")
        self.in_var = tk.StringVar()
        ttk.Entry(box1, textvariable=self.in_var).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(box1, text="选择…", command=self.pick_in, width=8).grid(row=0, column=2)

        ttk.Label(box1, text="输出文件夹：").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.out_var = tk.StringVar()
        ttk.Entry(box1, textvariable=self.out_var).grid(row=1, column=1, sticky="ew", padx=4, pady=(6, 0))
        ttk.Button(box1, text="选择…", command=self.pick_out, width=8).grid(row=1, column=2, pady=(6, 0))

        self.recursive = tk.BooleanVar(value=False)
        ttk.Checkbutton(box1, text="包含子文件夹", variable=self.recursive).grid(
            row=2, column=1, sticky="w", pady=(6, 0))

        box2 = ttk.LabelFrame(f, text="2. 处理方式", padding=8)
        box2.pack(fill="x", padx=8, pady=6)
        box2.columnconfigure(1, weight=1)

        self.mode = tk.StringVar(value="replace")
        ttk.Radiobutton(box2, text="只换前缀（推荐）", variable=self.mode, value="replace").grid(
            row=0, column=0, sticky="w")
        sub = ttk.Frame(box2)
        sub.grid(row=0, column=1, sticky="w")
        ttk.Label(sub, text="把　").pack(side="left")
        self.old_var = tk.StringVar(value="JT")
        ttk.Entry(sub, textvariable=self.old_var, width=8).pack(side="left")
        ttk.Label(sub, text="　改成　").pack(side="left")
        self.new_var = tk.StringVar(value="TJ")
        ttk.Entry(sub, textvariable=self.new_var, width=8).pack(side="left")

        ttk.Radiobutton(box2, text="整行擦掉（不留货号）", variable=self.mode, value="erase").grid(
            row=1, column=0, sticky="w", pady=(6, 0))

        ttk.Radiobutton(box2, text="按映射表逐张指定", variable=self.mode, value="custom").grid(
            row=2, column=0, sticky="w", pady=(6, 0))
        sub2 = ttk.Frame(box2)
        sub2.grid(row=2, column=1, sticky="ew", pady=(6, 0))
        sub2.columnconfigure(0, weight=1)
        self.map_var = tk.StringVar()
        ttk.Entry(sub2, textvariable=self.map_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(sub2, text="选择…", command=self.pick_map, width=8).grid(row=0, column=1, padx=(4, 0))

        self.rename = tk.BooleanVar(value=True)
        ttk.Checkbutton(box2, text="同时把文件名里的货号也改名（如 JT666-5.jpg → TJ666-5.jpg）",
                        variable=self.rename).grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
        self.compare = tk.BooleanVar(value=True)
        ttk.Checkbutton(box2, text="生成前后对比图（放在 输出目录\\_对比图，方便抽查）",
                        variable=self.compare).grid(row=4, column=0, columnspan=2, sticky="w", pady=(4, 0))

        box3 = ttk.LabelFrame(f, text="3. 高级选项（一般不用改）", padding=8)
        box3.pack(fill="x", padx=8, pady=6)
        self.adv = {}
        specs = [("搜索区上边界", "band_top", "0.86"), ("搜索区下边界", "band_bottom", "0.999"),
                 ("文字灰度阈值", "ink_thr", "110"), ("JPEG 质量", "quality", "95")]
        for i, (label, key, val) in enumerate(specs):
            ttk.Label(box3, text=label + "：").grid(row=i // 2, column=(i % 2) * 2, sticky="w", pady=2)
            v = tk.StringVar(value=val)
            ttk.Entry(box3, textvariable=v, width=7).grid(
                row=i // 2, column=(i % 2) * 2 + 1, sticky="w", padx=(0, 20))
            self.adv[key] = v
        self.font_var = tk.StringVar()
        ttk.Label(box3, text="字体文件：").grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(box3, textvariable=self.font_var, width=36).grid(
            row=2, column=1, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(box3, text="（留空自动选 Arial Bold）", foreground="#666").grid(
            row=3, column=1, columnspan=3, sticky="w")

    def pick_in(self):
        d = filedialog.askdirectory(title="选择图片文件夹")
        if d:
            self.in_var.set(d)
            if not self.out_var.get():
                self.out_var.set(os.path.join(d, "_已处理"))

    def pick_out(self):
        d = filedialog.askdirectory(title="选择输出文件夹")
        if d:
            self.out_var.set(d)

    def pick_map(self):
        f = filedialog.askopenfilename(title="选择映射表（JSON）",
                                       filetypes=[("JSON", "*.json"), ("所有文件", "*.*")])
        if f:
            self.map_var.set(f)

    def build_args(self, dry: bool) -> Namespace:
        indir = self.in_var.get().strip()
        outdir = self.out_var.get().strip() or os.path.join(indir, "_已处理")
        return Namespace(
            input=indir, output=outdir, mode=self.mode.get(),
            old_prefix=self.old_var.get(), new_prefix=self.new_var.get(),
            text=None, map=(self.map_var.get().strip() or None),
            recursive=self.recursive.get(), dry_run=dry, compare=self.compare.get(),
            report=None, font=(self.font_var.get().strip() or None),
            quality=int(self.adv["quality"].get()),
            band_top=float(self.adv["band_top"].get()),
            band_bottom=float(self.adv["band_bottom"].get()),
            ink_thr=int(self.adv["ink_thr"].get()),
            pad_x=24, pad_y=14, tolerant=True, verbose=True, gui=False, version=False,
            rename=self.rename.get(),
        )


# --------------------------------------------------------------------------- 页签二


class QuoteTab:
    """报价表：换图 + 改货号列。"""

    def __init__(self, parent: ttk.Frame, app: "App"):
        self.app = app
        f = parent

        box1 = ttk.LabelFrame(f, text="1. 报价表", padding=8)
        box1.pack(fill="x", padx=8, pady=6)
        box1.columnconfigure(1, weight=1)
        ttk.Label(box1, text="报价表文件：").grid(row=0, column=0, sticky="w")
        self.quote_var = tk.StringVar()
        ttk.Entry(box1, textvariable=self.quote_var).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(box1, text="选择…", command=self.pick_quote, width=8).grid(row=0, column=2)
        ttk.Label(box1, text="必须选 .xlsx；如果是老式 .xls，请先在 Excel/WPS 里「另存为」→ Excel 工作簿(*.xlsx)",
                  foreground="#a00").grid(row=1, column=0, columnspan=3, sticky="w", pady=(4, 0))

        box2 = ttk.LabelFrame(f, text="2. 新图片文件夹（文件名就是新货号，如 TJ666-5.jpg）", padding=8)
        box2.pack(fill="x", padx=8, pady=6)
        box2.columnconfigure(1, weight=1)
        self.img_var = tk.StringVar()
        ttk.Entry(box2, textvariable=self.img_var).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(box2, text="选择…", command=self.pick_imgs, width=8).grid(row=0, column=2)
        self.recursive = tk.BooleanVar(value=False)
        ttk.Checkbutton(box2, text="图片在子文件夹里", variable=self.recursive).grid(
            row=1, column=1, sticky="w", pady=(6, 0))

        box3 = ttk.LabelFrame(f, text="3. 货号前缀", padding=8)
        box3.pack(fill="x", padx=8, pady=6)
        ttk.Label(box3, text="把　").grid(row=0, column=0, sticky="w")
        self.old_var = tk.StringVar(value="JT")
        ttk.Entry(box3, textvariable=self.old_var, width=8).grid(row=0, column=1, sticky="w")
        ttk.Label(box3, text="　改成　").grid(row=0, column=2, sticky="w")
        self.new_var = tk.StringVar(value="TJ")
        ttk.Entry(box3, textvariable=self.new_var, width=8).grid(row=0, column=3, sticky="w")
        ttk.Label(box3, text="　（报价表里的图片名称和货号列都会一起改）",
                  foreground="#666").grid(row=0, column=4, sticky="w")

        box4 = ttk.LabelFrame(f, text="4. 输出", padding=8)
        box4.pack(fill="x", padx=8, pady=6)
        box4.columnconfigure(1, weight=1)
        ttk.Label(box4, text="输出文件：").grid(row=0, column=0, sticky="w")
        self.out_var = tk.StringVar()
        ttk.Entry(box4, textvariable=self.out_var).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(box4, text="选择…", command=self.pick_out, width=8).grid(row=0, column=2)
        self.inplace = tk.BooleanVar(value=False)
        ttk.Checkbutton(box4, text="直接覆盖原报价表（会先自动备份成 同名.xlsx.bak）",
                        variable=self.inplace).grid(row=1, column=1, sticky="w", pady=(6, 0))
        ttk.Label(box4, text="图片重编码质量：").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.quality = tk.StringVar(value="92")
        ttk.Entry(box4, textvariable=self.quality, width=7).grid(row=2, column=1, sticky="w", pady=(6, 0))

    def pick_quote(self):
        f = filedialog.askopenfilename(title="选择报价表",
                                       filetypes=[("Excel 工作簿", "*.xlsx"), ("所有文件", "*.*")])
        if f:
            self.quote_var.set(f)
            if not self.out_var.get():
                self.out_var.set(os.path.splitext(f)[0] + "_新.xlsx")

    def pick_imgs(self):
        d = filedialog.askdirectory(title="选择新图片文件夹")
        if d:
            self.img_var.set(d)

    def pick_out(self):
        f = filedialog.asksaveasfilename(title="输出为", defaultextension=".xlsx",
                                         filetypes=[("Excel 工作簿", "*.xlsx")])
        if f:
            self.out_var.set(f)


# --------------------------------------------------------------------------- 主窗口


class App:
    def __init__(self, root: tk.Tk, defaults: Namespace | None = None):
        self.root = root
        self.q: queue.Queue[str] = queue.Queue()
        self.worker: threading.Thread | None = None
        self.stop_flag = threading.Event()

        root.title("货号与报价表批量处理工具 v1.1 —— 纯算法，不联网")
        root.geometry("960x700")
        root.minsize(860, 620)

        nb = ttk.Notebook(root)
        nb.pack(fill="both", expand=True, padx=8, pady=(8, 4))

        tab1 = ttk.Frame(nb)
        nb.add(tab1, text="  ① 图片文件  ")
        self.images = ImagesTab(tab1, self)

        tab2 = ttk.Frame(nb)
        nb.add(tab2, text="  ② 报价表  ")
        self.quote = QuoteTab(tab2, self)

        # 共用按钮条
        bar = ttk.Frame(root, padding=(8, 2))
        bar.pack(fill="x")
        self.btn_dry = ttk.Button(bar, text="① 先试跑（只看计划，不改文件）", command=lambda: self.start(True))
        self.btn_dry.pack(side="left")
        self.btn_run = ttk.Button(bar, text="② 开始处理", command=lambda: self.start(False))
        self.btn_run.pack(side="left", padx=8)
        self.btn_stop = ttk.Button(bar, text="停止", command=self.stop, state="disabled")
        self.btn_stop.pack(side="left")
        ttk.Button(bar, text="打开输出位置", command=self.open_out).pack(side="right")
        self.which = tk.StringVar(value="images")
        ttk.Label(bar, text="当前页签：").pack(side="right", padx=(0, 12))
        nb.bind("<<NotebookTabChanged>>", lambda e: self.which.set("images" if nb.index("current") == 0 else "quote"))

        # 日志
        box = ttk.LabelFrame(root, text="运行记录", padding=4)
        box.pack(fill="both", expand=True, padx=8, pady=(4, 8))
        self.log = tk.Text(box, height=13, wrap="none", font=("Consolas", 9))
        self.log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(box, orient="vertical", command=self.log.yview)
        sb.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=sb.set)

        self.write("货号与报价表批量处理工具 v1.1\n")
        self.write("两个页签 = 一条流水线：\n")
        self.write("  ① 图片文件：改图片上的货号文字（换前缀 / 擦除 / 按表指定）+ 文件改名\n")
        self.write("  ② 报价表  ：把报价表里的旧图换新图 + 货号列改前缀（.xlsx 专用，格式零改动）\n")
        self.write("每步都建议先点「① 先试跑」看清楚计划，再点「② 开始处理」。\n\n")
        self.root.after(120, self.drain)

    # ---------------------------------------------------------------- helpers
    def write(self, s: str) -> None:
        self.log.insert("end", s)
        self.log.see("end")

    def drain(self) -> None:
        try:
            while True:
                self.write(self.q.get_nowait())
        except queue.Empty:
            pass
        self.root.after(120, self.drain)

    def open_out(self) -> None:
        if self.which.get() == "quote":
            p = self.quote.out_var.get() or self.quote.quote_var.get()
            d = os.path.dirname(p) if os.path.isfile(p) else p
        else:
            d = self.images.out_var.get() or self.images.in_var.get()
        if d and os.path.isdir(d):
            os.startfile(d)  # type: ignore[attr-defined]
        else:
            messagebox.showinfo("提示", "输出位置还不存在，先跑一次吧。")

    # ---------------------------------------------------------------- run
    def start(self, dry: bool) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showinfo("提示", "正在处理中，请稍候…")
            return
        if self.which.get() == "quote":
            tab, fn = self.quote, self._work_quote
            q = tab.quote_var.get().strip()
            if not q or not os.path.isfile(q):
                messagebox.showerror("出错了", "请先选一个有效的报价表 .xlsx 文件。")
                return
            if not q.lower().endswith(".xlsx"):
                messagebox.showerror("出错了", "只支持 .xlsx。\n老式 .xls 请先另存为 .xlsx。")
                return
            if not tab.img_var.get().strip() or not os.path.isdir(tab.img_var.get().strip()):
                messagebox.showerror("出错了", "请先选「新图片文件夹」。")
                return
        else:
            tab, fn = self.images, self._work_images
            if not tab.in_var.get().strip() or not os.path.isdir(tab.in_var.get().strip()):
                messagebox.showerror("出错了", "请先选一个有效的「输入文件夹」。")
                return
            outdir = tab.out_var.get().strip() or os.path.join(tab.in_var.get().strip(), "_已处理")
            if not dry and os.path.abspath(outdir) == os.path.abspath(tab.in_var.get().strip()):
                if not messagebox.askyesno("确认", "输出文件夹和输入文件夹相同，会覆盖原图。\n确定要继续吗？"):
                    return
        self.stop_flag.clear()
        self.btn_run.configure(state="disabled")
        self.btn_dry.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.write("\n" + "=" * 62 + "\n")
        self.write(("【试跑，不写文件】" if dry else "【正式处理】") +
                   ("报价表" if self.which.get() == "quote" else "图片文件") + "\n")
        self.worker = threading.Thread(target=fn, args=(dry,), daemon=True)
        self.worker.start()

    def stop(self) -> None:
        self.stop_flag.set()
        self.write("\n[已请求停止，当前文件处理完后会停下]\n")

    def _done(self) -> None:
        self.btn_run.configure(state="normal")
        self.btn_dry.configure(state="normal")
        self.btn_stop.configure(state="disabled")

    # ---------------------------------------------------------------- workers
    def _work_quote(self, dry: bool) -> None:
        try:
            import quote_tool as QT
            t = self.quote
            src = t.quote_var.get().strip()
            imgdir = t.img_var.get().strip()
            out = t.out_var.get().strip() or os.path.splitext(src)[0] + "_新.xlsx"
            self.q.put(f"报价表: {os.path.basename(src)}\n新图片: {imgdir}\n前缀: {t.old_var.get()} -> {t.new_var.get()}\n\n")
            target = src if (t.inplace.get() and not dry) else out
            if t.inplace.get() and not dry:
                import shutil
                bk = src + ".bak"
                if not os.path.exists(bk):
                    shutil.copy2(src, bk)
                    self.q.put(f"[备份] {os.path.basename(bk)}\n")
            plan, stats = QT.patch_xlsx(src, target, imgdir, t.old_var.get(), t.new_var.get(),
                                        t.recursive.get(), int(t.quality.get()), dry)
            self.q.put(f"计划: 替换图片 {stats['pictures_planned']} 张，改货号文字 {stats['codes_done']} 处\n")
            if plan.warnings:
                self.q.put("\n注意:\n")
                for w in plan.warnings:
                    self.q.put(f"  - {w}\n")
            self.q.put("\n逐条对应:\n")
            for p in plan.pictures:
                nf = getattr(p, "new_file", None)
                nc = (t.new_var.get() + p.code[len(t.old_var.get()):]
                      if (t.old_var.get() and p.code.startswith(t.old_var.get())) else p.code)
                self.q.put(f"  {p.code} -> {nc:<18} {p.media:<22} {os.path.basename(nf) if nf else '(缺失)'}\n")
            if dry:
                self.q.put("\n[试跑] 没有写任何文件。\n")
            else:
                self.q.put(f"\n[完成] {target}  ({os.path.getsize(target):,} B)\n")
                issues = QT.verify_xlsx(target, t.old_var.get(), t.new_var.get())
                if issues:
                    self.q.put("[校验] 发现问题:\n")
                    for i in issues:
                        self.q.put(f"  ✗ {i}\n")
                else:
                    self.q.put("[校验] ✓ 包完整、XML 正常、关系与内容类型齐全、无旧前缀残留\n")
                    self.q.put("       列宽/行高/合并单元格/图片锚点全部保持原样（只动了图片和货号文字）\n")
        except Exception as e:
            self.q.put(f"[严重错误] {type(e).__name__}: {e}\n{traceback.format_exc()}\n")
        finally:
            self.root.after(0, self._done)

    def _work_images(self, dry: bool) -> None:
        try:
            import label_tool as LT
            t = self.images
            args = t.build_args(dry)
            cfg = LT.Config(band_top=args.band_top, band_bottom=args.band_bottom,
                            ink_thr=args.ink_thr, quality=args.quality, tolerant=True)
            font_path = LT.find_font(args.font)
            images = LT.collect_images(args.input, args.recursive)
            if not images:
                self.q.put(f"[!] {args.input} 里没有找到图片\n")
                return
            self.q.put(f"共 {len(images)} 张图，输出到 {args.output}\n")
            mapping = None
            if args.map:
                with open(args.map, encoding="utf-8-sig") as f:
                    mapping = json.load(f)
                self.q.put(f"映射表 {args.map}（{len(mapping)} 条）\n")
            if args.rename:
                self.q.put(f"同时重命名文件：{args.old_prefix} -> {args.new_prefix}\n")
            self.q.put("\n")
            stats = {"OK": 0, "WARN": 0, "NO": 0, "ERR": 0, "DRY": 0, "REN": 0}
            rows = []
            for k, src in enumerate(images, 1):
                if self.stop_flag.is_set():
                    self.q.put("已停止。\n")
                    break
                rel = os.path.relpath(src, args.input)
                # 文件重命名：目录 + 文件名都跟着换前缀
                if args.rename and args.old_prefix:
                    mid = rel.replace(args.old_prefix, args.new_prefix)
                    dst = os.path.join(args.output, mid)
                else:
                    dst = os.path.join(args.output, rel)
                if rel != os.path.relpath(dst, args.output):
                    stats["REN"] += 1
                cmp_path = (os.path.join(args.output, "_对比图",
                                         os.path.splitext(os.path.relpath(dst, args.output))[0] + "_对比.jpg")
                            if args.compare else None)
                try:
                    r = LT.process_one(src, dst, cfg, font_path, args.mode,
                                       args.old_prefix, args.new_prefix, None,
                                       mapping, dry, cmp_path)
                except Exception as e:
                    r = LT.ItemResult(src, dst, "ERROR", note=f"{type(e).__name__}: {e}")
                    self.q.put(traceback.format_exc() + "\n")
                rows.append(r)
                key = {"OK": "OK", "DRY": "DRY", "WARN": "WARN", "ERROR": "ERR"}.get(r.status, "NO")
                stats[key] += 1
                sym = {"OK": "✓", "DRY": "·", "WARN": "!", "ERROR": "×"}.get(r.status, "?")
                extra = f"   {r.note}" if r.note else ""
                self.q.put(f"  [{k:>3}/{len(images)}] {sym} {rel}  {r.text or '(擦除)'}{extra}\n")
            self.q.put("\n" + "-" * 62 + "\n")
            self.q.put(f"完成：成功 {stats['OK'] + stats['DRY']}  警告 {stats['WARN']}  "
                       f"未检测到 {stats['NO']}  出错 {stats['ERR']}   加文件名改名 {stats['REN']} 张\n")
            if not dry and rows:
                os.makedirs(args.output, exist_ok=True)
                with open(os.path.join(args.output, "处理报告.csv"), "w",
                          encoding="utf-8-sig", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["源文件", "输出文件", "状态", "新货号", "文字框", "文字尺寸", "备注"])
                    for r in rows:
                        w.writerow([r.src, r.dst, r.status, r.text or "", r.box or "", r.ink or "", r.note])
                self.q.put("报告已写入 输出目录\\处理报告.csv\n")
                self.q.put("建议抽查 输出目录\\_对比图 里的几张。\n")
        except Exception as e:
            self.q.put(f"[严重错误] {type(e).__name__}: {e}\n{traceback.format_exc()}\n")
        finally:
            self.root.after(0, self._done)


def run_gui(defaults: Namespace | None = None) -> int:
    root = tk.Tk()
    try:
        root.call("tk", "scaling", 1.25)
    except Exception:
        pass
    App(root, defaults)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(run_gui())
