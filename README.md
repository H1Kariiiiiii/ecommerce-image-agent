# 🧸 玩具白底图 Agent（Ecommerce Image Agent）

> 面向电商的桌面应用：上传玩具产品图，把背景替换为纯白底图，支持 **AI 生成** 与 **纯算法抠白底（免费）** 两种方式 + **擦除货号文字**（本地 PP-OCRv4 自动定位），支持**批量处理**、前后对比、多种比例与深色模式。
> 内置主流生图模型预设（火山方舟 / OpenAI / 智谱 / 硅基流动 / 阿里百炼），本地额度统计与结果缓存管理。

![Electron](https://img.shields.io/badge/Electron-33-47848F)
![React](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![tests](https://img.shields.io/badge/tests-220%20passed-2f9e63)

<!-- 建议放 3 张截图：主界面（浅色）/ 批量处理 / 深色模式 + API 设置
![主界面](docs/screenshot-main-light.png)
![批量处理](docs/screenshot-batch.png)
![深色模式](docs/screenshot-dark.png)
-->

## 功能亮点

- 🖼️ **批量改图**：一次上传多张（多选 / 拖拽），顺序批量生成，逐张显示状态（待处理 / 处理中 / 成功 / 失败可重试）；**运行中清空/删除列表即中止**剩余付费调用，不会白扣费
- 🔄 **重新生成**：修改 API 参数（提示词 / 比例等）后一键重跑当前图片，无需重新上传
- 🔍 **前后对比**：并排 / 滑动两种对比模式
- ⚡ **主流模型预设**：5 大服务商一键填充（火山方舟 Seedream 5.0 Lite/Pro / OpenAI gpt-image-2 / 智谱 GLM-Image / 硅基流动 Qwen-Image / 阿里百炼 DashScope 原生），也支持任意 OpenAI 兼容服务手动配置
- 🧹 **纯算法抠白底（免费）**：不依赖任何 API，本地像素算法（多色背景建模 + 泛洪填充 + 边缘去污染）秒级抠白底，保留产品真实细节；与 AI 生成两条路径并行，按需切换
- 📐 **无损画布扩展（免费）**：纯算法把原图放到目标比例画布（1:1 / 4:3 / 16:9 等），原图**像素级不变**、四周补纯白边；支持「保持原图大小」与「等比缩放适配」两种放置策略，批量秒级完成——电商上架常用比例一步到位
- 📏 **多比例输出**：1:1、16:9、9:16、4:3、3:4、2:3、3:2、21:9（自动换算为模型支持的 size 档位，如 16:9 → 2560x1440），或自定义像素 `size`（支持 `*` / `×` 自动转 `x`；需 ≥ 3686400 像素）
- 🔀 **三种请求风格**：`images/generations`（方舟 / OpenAI / 智谱 / 硅基流动等）、`images/edits`（multipart）、`chat/completions`（多模态 OpenAI 兼容服务）
- 📖 **应用内使用帮助**：右上角「❓ 使用帮助」内置完整说明书，左侧目录点击跳转对应章节，随时查看
- 🌓 **深色模式**：跟随系统 / 浅色 / 深色三档，原生控件 `color-scheme` 适配
- 🎨 **Claude 风格 UI**：暖米色 + 陶土橙配色，浅色 / 深色双主题
- 📊 **额度统计**：本地每月额度上限与已用张数统计，超限自动拦截，跨月重置
- 💰 **余额查询**：OpenAI 官方 / 支持 billing 端点的兼容服务可一键查询账户余额
- 💧 **AI 水印开关**：显式控制生成图的可见 AI 水印（`watermark` 参数）
- 🧹 **缓存管理**：启动自动清理 7 天前的结果图片，设置面板可视化显示占用并可一键清理
- 🔤 **内置 emoji 字体**：打包 Noto Color Emoji，精简版/字体缺失的 Windows 系统上图标也不会变方块
- 🔐 **安全基线**：`contextIsolation` + 白名单 preload API + 本地图片经授权校验的自定义 `asset://` 协议，外部链接一律系统浏览器打开

## 技术栈

- **Electron + electron-vite + React 18 + TypeScript**
- 主进程分层：API 适配层（OpenAI 兼容客户端，含 generations / edits / chat 三种风格）、IPC、配置持久化、额度与缓存管理
- 自定义 `asset://` 协议安全预览本地图片；路径授权集模型（对话框 / 拖拽登记授权）
- **vitest 单元测试 220 个**，覆盖 API 客户端（三种请求风格 / 余额）、IPC、设置 / 缓存持久化、React 组件、纯算法抠白底 / 本地擦除 / OCR 定位

## 快速开始

```bash
npm install
npm run dev         # 开发模式（HMR）
npm run typecheck   # 类型检查（node / web / tests 三项目）
npm test            # 运行全部单测
npm run build       # 构建产物到 out/
npm run dist        # 打包安装包（electron-builder）
```

> 国内网络下 electron 二进制未下载时：
> ```bash
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
> ```

## 配置 API

启动后点右上角「⚙️ API 设置」→「+ 添加 OpenAI 兼容模型」。顶部**预设模板**下拉可直接选择主流服务商，自动填充 `baseUrl` / `model` / 请求风格（均可再改）：

| 预设 | baseUrl / 接入 | model | 请求风格 | 参考价（每张） |
| --- | --- | --- | --- | --- |
| 火山方舟 Ark（Lite） | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seedream-5-0-260128` | images/generations | ≈¥0.22 |
| 火山方舟 Ark（Pro） | 同上 | `doubao-seedream-5-0-pro-*`（以控制台为准） | images/generations | 输出 ≈¥0.30 + 输入 ≈¥0.02 |
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-image-2` | images/generations | ≈$0.05（medium）≈¥0.38 |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-image` | images/generations | ≈¥0.1 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen-Image` | images/generations | ≈¥0.1~0.35 |
| 阿里云百炼（DashScope 原生） | API 设置「阿里云百炼」类型添加 | `qwen-image-3.0-pro`（另有 3.0 / 2.0-pro / 2.0） | 原生接口（input.messages） | 以百炼计费页为准 |

> ⚠️ 国内平台（方舟 / 智谱 / 硅基流动）**首次创建 API Key 前需完成实名认证**（控制台 → 账号管理 → 实名认证，个人认证几分钟通过）。
> ⚠️ 价格为**官方公开参考价**（2026-08 查询），以各服务商计费页为准；OpenAI gpt-image-2 按输出 token 计费，不同质量/尺寸档价格差异可达几十倍。
> 阿里云百炼 qwen-image 官方不支持 OpenAI 兼容协议，应用内置「阿里云百炼 DashScope」provider 走原生接口（不在 OpenAI 兼容预设下拉里）。

也可不选预设，手动填 `baseUrl` / `apiKey` / `model` 接入任意 OpenAI 兼容服务。

### 请求风格

- **`json`**：`POST {baseUrl}/images/generations`，`image` 字段传 data URI（方舟 Ark / OpenAI / 硅基流动等）
- **`edits`**：`POST {baseUrl}/images/edits`（multipart，OpenAI 标准）
- **`chat`**：`POST {baseUrl}/chat/completions` 多模态（部分 OpenAI 兼容图像模型）

支持参数：`watermark` 水印开关、自定义 `size`（`*` / `×` 自动归一化为 `x`）；「生成比例」自动换算为模型支持的像素档位发送（各服务商规则见下表），自定义尺寸会按模型校验像素上下限 / 边长倍数 / 宽高比。

| 预设 | 尺寸参数 | 比例换算档位（示例） | 限制 |
| --- | --- | --- | --- |
| 方舟 seedream 5.0 | `size` | 16:9 → 2560x1440、4:3 → 2304x1728 | ≥ 3,686,400 像素 |
| OpenAI gpt-image-2 | `size` | 16:9 → 2560x1440、21:9 → 2688x1152 | 16 倍数、比例 1:3~3:1、像素 65.5万~829万 |
| OpenAI gpt-image-1 | `size` | 全部 → 1024x1024 / 1536x1024 / 1024x1536 | 固定三档 |
| 智谱 GLM-Image | `size` | 4:3 → 1472x1088、16:9 → 1728x960 | 边长 1024~2048、32 倍数、≤ 4194304 |
| 智谱 CogView-4 | `size` | 16:9 → 1440x720、1:1 → 1024x1024 | 边长 512~2048、16 倍数、≤ 2097152 |
| 阿里百炼 qwen-image-2.0 | `size` | 16:9 → 2048x1152、1:1 → 2048x2048 | 像素 26万~419万（不经 OpenAI 兼容） |
| 硅基流动 Qwen-Image | `image_size` | 16:9 → 1664x928、4:3 → 1472x1140 | 官方推荐档位 |
| 硅基流动 FLUX.1-dev | `image_size` | 16:9 → 1280x720、1:1 → 1024x1024 | ≤ 2,359,296 像素 |

## 目录结构

```
src/
├── shared/types.ts        # 三端共享类型（ProviderConfig、IPC 通道、接口定义）
├── main/
│   ├── index.ts           # 主进程入口（窗口、asset:// 协议、启动清理）
│   ├── ipc.ts             # IPC handlers + 路径授权模型
│   ├── providers.ts       # providers.json 持久化与默认模板
│   ├── settings.ts        # 应用设置 + 每月额度统计（跨月重置）
│   ├── cache.ts           # 结果缓存统计与清理
│   └── api/
│       ├── signer.ts      # 火山引擎 HMAC-SHA256 签名（已从 UI 移除，代码保留）
│       ├── volcanoCv.ts   # 旧视觉智能异步任务客户端（已从 UI 移除，代码保留）
│       ├── openaiCompat.ts# OpenAI 兼容客户端（generations / edits / chat / 余额查询）
│       ├── dashscope.ts   # 阿里云百炼 DashScope 原生客户端（qwen-image 系列）
│       ├── whiteBgLocal.ts# 纯算法抠白底（多色背景建模 + 泛洪填充 + 边缘去污染）
│       ├── localErase.ts  # 本地擦除货号（OCR 定位 → 羽化擦除）
│       ├── ocr.ts         # OCR 纯函数（候选筛选/同行拼接/主色提取）
│       ├── ppocrDetect.ts # PP-OCRv4 自动定位（全图条带扫描）
│       ├── ppocrRec.ts    # PP-OCRv4 识别（onnxruntime-node 推理）
│       ├── mask.ts        # inpainting mask 生成
│       ├── textOverlay.ts # 文字叠加
│       ├── util.ts        # base64、点分路径、模板、安全下载（魔数校验）等
│       └── index.ts       # provider 工厂
├── preload/index.ts       # contextBridge 白名单 API
└── renderer/src/          # React UI（批量列表、上传、对比、导出、设置面板）
```

## 测试

```bash
npm test          # vitest run，220 个用例
npm run typecheck # tsc --noEmit × 3（node / web / tests）
```

覆盖范围：OpenAI 兼容客户端（data URI / size 换算与像素校验 / watermark / chat 多模态 / 余额）、provider 持久化、IPC 授权模型、额度 / 缓存持久化（跨重启）、React 组件（批量流程 / 设置面板 / 预设模板 / 帮助窗口 / 主题 / 竞态回归）。

## 安全与隐私

- 图片通过你配置的 API 服务商处理，结果下载到本地
- 配置（含密钥）明文保存在本机用户数据目录（`userData/providers.json`），请妥善保管本机访问权限
- 不做任何遥测与网络上报（除你配置的 API 外）
- `asset://` 协议仅放行「对话框 / 拖拽登记授权」的路径与结果目录

## License

[MIT](LICENSE)
