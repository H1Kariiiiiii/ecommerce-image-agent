import { describe, expect, it } from 'vitest'
import { formatXDate, signRequest } from '../src/main/api/signer'

const BASE = {
  method: 'POST',
  url: new URL('https://visual.volcengineapi.com/?Action=CVSubmitTask&Version=2022-08-31'),
  body: '{"req_key":"seedream_5_0_lite"}',
  accessKey: 'AK_TEST',
  secretKey: 'SK_TEST',
  region: 'cn-north-1',
  service: 'cv',
  version: 'HMAC-SHA256' as const
}

describe('signRequest 格式', () => {
  it('Authorization 头包含算法、Credential scope、SignedHeaders、Signature', () => {
    const h = signRequest(BASE)
    expect(h.Authorization).toMatch(/^HMAC-SHA256 Credential=AK_TEST\/\d{8}\/cn-north-1\/cv\/request, /)
    expect(h.Authorization).toContain('SignedHeaders=content-type;host;x-content-sha256;x-date')
    expect(h.Authorization).toMatch(/Signature=[0-9a-f]{64}$/)
  })

  it('X-Date 为 ISO8601 basic 格式，X-Content-Sha256 为 body 的 sha256', () => {
    const h = signRequest(BASE)
    expect(h['X-Date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(h['X-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('X-Content-Sha256 与 body 内容一致（改动 body 会变化）', () => {
    const a = signRequest(BASE)
    const b = signRequest({ ...BASE, body: '{"req_key":"other"}' })
    expect(a['X-Content-Sha256']).not.toBe(b['X-Content-Sha256'])
  })
})

describe('signRequest 幂等与敏感', () => {
  it('相同输入产生相同签名', () => {
    const a = signRequest(BASE)
    const b = signRequest({ ...BASE, url: new URL(BASE.url.toString()) })
    expect(b.Authorization).toBe(a.Authorization)
  })

  it('secretKey / region / service / accessKey 任一变化，签名都变化', () => {
    const base = signRequest(BASE)
    const variants = [
      { secretKey: 'SK_OTHER' },
      { region: 'cn-south-1' },
      { service: 'ark' },
      { accessKey: 'AK_OTHER' }
    ]
    for (const v of variants) {
      const s = signRequest({ ...BASE, ...v })
      expect(s.Authorization).not.toBe(base.Authorization)
    }
  })

  it('query 参数乱序不影响签名（canonical query 排序）', () => {
    const a = signRequest(BASE)
    const b = signRequest({
      ...BASE,
      url: new URL('https://visual.volcengineapi.com/?Version=2022-08-31&Action=CVSubmitTask')
    })
    expect(b.Authorization).toBe(a.Authorization)
  })
})

describe('签名算法版本', () => {
  it('新版 VOLCENGINE-HMAC-SHA256 前缀正确且与旧版不同', () => {
    const h = signRequest({ ...BASE, version: 'VOLCENGINE-HMAC-SHA256' })
    expect(h.Authorization).toMatch(/^VOLCENGINE-HMAC-SHA256 Credential=AK_TEST\//)
    const old = signRequest(BASE)
    expect(h.Authorization).not.toBe(old.Authorization)
  })
})

describe('formatXDate', () => {
  it('输出 yyyyMMddTHHmmssZ', () => {
    expect(formatXDate(new Date('2026-08-04T16:44:18.046Z'))).toBe('20260804T164418Z')
  })
})
