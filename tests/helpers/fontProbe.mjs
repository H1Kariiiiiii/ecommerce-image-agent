/**
 * 子进程字体探针：fontconfig 每进程只初始化一次，
 * 所以「配好 fonts.conf 后字体是否真的换了」必须在全新进程里验证。
 * 用法：node fontProbe.mjs <fonts.conf 路径>
 * 输出：JSON { arial, lib, miss } —— 各自渲染同一串货号的墨迹尺寸
 */
process.env.FONTCONFIG_FILE = process.argv[2]

const sharp = (await import('sharp')).default

const SVG = (family) =>
  '<svg width="1600" height="300" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="1600" height="300" fill="#ffffff"/>' +
  '<text x="20" y="200" font-family="' + family + '" font-size="160"' +
  ' font-weight="bold" fill="#000000">NO.JT888-11Z-1</text></svg>'

async function ink(family) {
  const png = await sharp(Buffer.from(SVG(family))).png().toBuffer()
  const t = await sharp(png).trim({ threshold: 127 }).toBuffer({ resolveWithObject: true })
  return t.info.width + 'x' + t.info.height
}

console.log(
  JSON.stringify({
    arial: await ink('Arial'),
    lib: await ink('Liberation Sans'),
    miss: await ink('NoSuchFontXYZ')
  })
)
