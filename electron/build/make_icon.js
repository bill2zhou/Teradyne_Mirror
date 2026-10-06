// 将 256x256 的 PNG 图标封装为 ICO 文件（现代 Windows 支持 ICO 内嵌 PNG 数据）
// 用法: node make_icon.js <input.png> <output.ico>
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('用法: node make_icon.js <input.png> <output.ico>');
  process.exit(1);
}

const png = fs.readFileSync(input);

// ICONDIR (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

// ICONDIRENTRY (16 bytes)，256x256 -> width/height 字段填 0
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width (0 = 256)
entry.writeUInt8(0, 1); // height (0 = 256)
entry.writeUInt8(0, 2); // color count
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // size of image data
entry.writeUInt32LE(6 + 16, 12); // offset of image data

fs.writeFileSync(output, Buffer.concat([header, entry, png]));
console.log(`已生成 ${path.resolve(output)} (${(6 + 16 + png.length) / 1024 | 0} KB)`);
