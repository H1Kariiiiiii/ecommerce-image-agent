import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PP-OCRv4 文字识别（rec）模块。
 * 只移植识别部分（det 定位仍由手动框选 / 前端逻辑负责），
 * 因此无 OpenCV 依赖，纯 onnxruntime-node + sharp + 数组运算。
 */

const REC_IMG_H = 48
const REC_MAX_W = 320
const REC_CHANNELS = 3

interface RecResult {
  text: string
  confidence: number
}

let recSession: ort.InferenceSession | null = null
let characterList: string[] | null = null

/** 定位模型/字典目录：打包后 resources/ocr-models，开发时项目 resources/ocr-models */
function modelsDir(): string {
  const candidates: string[] = []
  // 打包后：electron-builder extraResources → <resources>/ocr-models
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'ocr-models'))
  }
  // 开发/测试：项目根/resources/ocr-models（源码 __dirname=src/main/api → 上溯 3 层）
  candidates.push(join(__dirname, '..', '..', '..', 'resources', 'ocr-models'))
  // 兜底：沿 __dirname 向上找 resources/ocr-models
  let cur = __dirname
  for (let i = 0; i < 6; i++) {
    const p = join(cur, 'resources', 'ocr-models')
    if (existsSync(p)) return p
    cur = join(cur, '..')
  }
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(`找不到 ocr-models 目录（模型文件缺失）。已尝试：${candidates.join(', ')}`)
}

async function getSession(): Promise<ort.InferenceSession> {
  if (!recSession) {
    const dir = modelsDir()
    recSession = await ort.InferenceSession.create(join(dir, 'ch_PP-OCRv4_rec_infer.onnx'), {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    })
  }
  return recSession
}

function getCharacterList(): string[] {
  if (characterList) return characterList
  const dir = modelsDir()
  const raw = readFileSync(join(dir, 'rec_keys.txt'), 'utf8')
  // 字典文件：每行一字（不含 blank / space，需要按 PP-OCR 约定补齐）
  const chars = raw.split('\n')
  // 去掉可能的空行
  const cleaned = chars.filter((c) => c !== '')
  // 与 Python 版一致：开头插入 blank(索引0)，末尾插入空格
  const list = ['blank', ...cleaned]
  if (!list.includes(' ')) list.push(' ')
  characterList = list
  return list
}

/** 裁剪区域并缩放到 rec 输入尺寸（高 48，宽按比例最大 320），返回归一化 CHW float32 */
async function cropNormalize(inputPath: string, region: { x: number; y: number; width: number; height: number }): Promise<Float32Array> {
  const meta = await sharp(inputPath).metadata()
  const w = meta.width!
  const h = meta.height!

  // 区域加少量 padding（5%），避免文字贴边被裁掉
  const padX = region.width * w * 0.1
  const padY = region.height * h * 0.1
  const sx = Math.max(0, Math.round(region.x * w - padX))
  const sy = Math.max(0, Math.round(region.y * h - padY))
  const sw = Math.min(w - sx, Math.round(region.width * w + padX * 2))
  const sh = Math.min(h - sy, Math.round(region.height * h + padY * 2))

  const { data, info } = await sharp(inputPath)
    .extract({ left: sx, top: sy, width: Math.max(1, sw), height: Math.max(1, sh) })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const imgH = info.height
  const imgW = info.width
  const channels = info.channels // 3（removeAlpha 后）

  // 等比例缩放到高 48，宽按宽高比（不超过 MAX_W）
  const ratio = imgW / imgH
  let resizedW = Math.min(REC_MAX_W, Math.ceil(REC_IMG_H * ratio))
  if (resizedW < 1) resizedW = 1

  const resized = await sharp(data, { raw: { width: imgW, height: imgH, channels } })
    .resize(resizedW, REC_IMG_H, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer()

  // 归一化: (x/255 - 0.5) / 0.5；CHW 布局 + 右填充 0 到 maxW
  const out = new Float32Array(REC_CHANNELS * REC_IMG_H * REC_MAX_W)
  const step = REC_IMG_H * REC_MAX_W
  for (let y = 0; y < REC_IMG_H; y++) {
    for (let x = 0; x < resizedW; x++) {
      const src = (y * resizedW + x) * channels
      for (let c = 0; c < REC_CHANNELS; c++) {
        const v = resized[src + c] / 255
        out[c * step + y * REC_MAX_W + x] = (v - 0.5) / 0.5
      }
    }
  }
  return out
}

/** CTC 解码：argmax → 去连续重复 → 去 blank → 拼文本 */
function ctcDecode(preds: Float32Array, timeSteps: number, numClasses: number, chars: string[]): RecResult {
  const argmax = new Int32Array(timeSteps)
  const maxProb = new Float32Array(timeSteps)
  for (let t = 0; t < timeSteps; t++) {
    let best = 0
    let bp = -Infinity
    for (let c = 0; c < numClasses; c++) {
      const v = preds[t * numClasses + c]
      if (v > bp) {
        bp = v
        best = c
      }
    }
    argmax[t] = best
    maxProb[t] = bp
  }

  const textParts: string[] = []
  const confs: number[] = []
  let prev = -1
  for (let t = 0; t < timeSteps; t++) {
    const id = argmax[t]
    if (id === prev) continue // 去连续重复
    prev = id
    if (id === 0) continue // blank
    if (id >= chars.length) continue
    textParts.push(chars[id])
    confs.push(maxProb[t])
  }

  const text = textParts.join('')
  const confidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0
  return { text, confidence }
}

/**
 * 识别图片指定区域内的文字（PP-OCRv4 rec）。
 * @param inputPath 原图路径
 * @param region 归一化区域（0~1）
 */
export async function recognizeRegionText(
  inputPath: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<RecResult> {
  const [session, chars] = await Promise.all([getSession(), Promise.resolve(getCharacterList())])
  const input = await cropNormalize(inputPath, region)

  const feeds: Record<string, ort.Tensor> = {
    x: new ort.Tensor('float32', input, [1, REC_CHANNELS, REC_IMG_H, REC_MAX_W])
  }
  const results = await session.run(feeds)
  const out = results[session.outputNames[0]]
  const data = out.data as Float32Array
  const [, timeSteps, numClasses] = out.dims

  return ctcDecode(data, timeSteps, numClasses, chars)
}
