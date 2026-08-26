import { createHash, createHmac } from 'node:crypto'
import type { SignVersion } from '../../shared/types'

/**
 * 火山引擎（Volcengine）请求签名，类似 AWS SigV4。
 *
 * 两套算法：
 * - 'HMAC-SHA256'（旧版，官方 SDK 实际实现）：
 *   kDate = HMAC(key=secretKey, msg=date)
 * - 'VOLCENGINE-HMAC-SHA256'（新版，2023-12-01 后的新接口）：
 *   kDate = HMAC(key='volcengine20231201' + secretKey, msg=date)
 *   后续链条相同。新版细节未经官方 SDK 代码验证，如签名失败请对照接口文档。
 *
 * 参与签名的头：content-type / host / x-content-sha256 / x-date（如有 x-security-token 一并加入）。
 */

export interface VolcanoSignOptions {
  method: string
  url: URL
  body: string
  accessKey: string
  secretKey: string
  region: string
  service: string
  version: SignVersion
  securityToken?: string
  /** 额外参与签名的头（键小写） */
  extraSignedHeaders?: Record<string, string>
}

function hmacSha256(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg, 'utf8').digest()
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** RFC3986 编码（AWS/火山签名要求） */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function buildCanonicalQuery(url: URL): string {
  const params = [...url.searchParams.entries()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1
  )
  return params.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&')
}

/** 值压缩：trim 并折叠连续空白（签名规范要求） */
function normalizeHeaderValue(v: string): string {
  return v.trim().replace(/\s+/g, ' ')
}

export function formatXDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function signRequest(opts: VolcanoSignOptions): Record<string, string> {
  const { method, url, body, accessKey, secretKey, region, service, version } = opts
  const algorithm = version === 'VOLCENGINE-HMAC-SHA256' ? 'VOLCENGINE-HMAC-SHA256' : 'HMAC-SHA256'

  const xDate = formatXDate(new Date())
  const date8 = xDate.slice(0, 8)

  const payloadHash = sha256Hex(body)

  // 参与签名的头
  const signedHeadersMap: Record<string, string> = {
    'content-type': 'application/json',
    host: url.host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
    ...(opts.securityToken ? { 'x-security-token': opts.securityToken } : {}),
    ...(opts.extraSignedHeaders ?? {})
  }
  const signedHeaderKeys = Object.keys(signedHeadersMap)
    .filter((k) => k !== 'accept' && k !== 'user-agent')
    .sort()
  const signedHeaders = signedHeaderKeys.join(';')

  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${normalizeHeaderValue(signedHeadersMap[k])}\n`)
    .join('')

  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    buildCanonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const credentialScope = `${date8}/${region}/${service}/request`
  const stringToSign = [
    algorithm,
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n')

  // 密钥链
  let kDate: Buffer
  if (version === 'VOLCENGINE-HMAC-SHA256') {
    kDate = hmacSha256('volcengine20231201' + secretKey, date8)
  } else {
    kDate = hmacSha256(secretKey, date8)
  }
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  const kSigning = hmacSha256(kService, 'request')

  const signature = hmacSha256(kSigning, stringToSign).toString('hex')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
  if (opts.securityToken) headers['X-Security-Token'] = opts.securityToken
  return headers
}
