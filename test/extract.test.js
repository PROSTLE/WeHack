// Extractor unit tests: the container parsing, not the corpus.
const zlib = require('zlib');
const E = require('../src/main/classify/extract.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

console.log('-- XML text --');
ok('reads a docx run', E.textFromXml('<w:p><w:t>Hello</w:t></w:p>', ['w:t']).join('') === 'Hello');
ok('reads an attributed run',
  E.textFromXml('<w:t xml:space="preserve">A B</w:t>', ['w:t']).join('') === 'A B');
ok('decodes entities',
  E.textFromXml('<t>a &amp; b &lt;c&gt;</t>', ['t']).join('') === 'a & b <c>');

console.log('-- PDF strings --');
ok('literal string', E.decodePdfLiteral('Hello') === 'Hello');
ok('escaped parenthesis', E.decodePdfLiteral('a\(b\)') === 'a(b)');
ok('octal escape', E.decodePdfLiteral('\101') === 'A');
ok('hex string', E.decodePdfHex('48656C6C6F') === 'Hello');

console.log('-- text operators --');
ok('Tj', E.textFromContentStream('BT (Hello) Tj ET').includes('Hello'));
ok('TJ array joins pieces',
  E.textFromContentStream('BT [(Hel) -20 (lo)] TJ ET').replace(/\s/g, '') === 'Hello');

console.log('-- the printability guard --');
ok('accepts prose', E.isMostlyPrintable('The quick brown fox jumps over the lazy dog'));
ok('rejects binary noise',
  !E.isMostlyPrintable(Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x02,0x03]).toString('latin1').repeat(20)));
ok('rejects symbol soup with no letters', !E.isMostlyPrintable('### $$$ %%% ^^^ &&& *** ((( ))) '.repeat(10)));

console.log('-- ZIP reader --');
// Build a real ZIP in memory: one stored entry.
const name = Buffer.from('a.txt');
const data = Buffer.from('hello zip');
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const crc = crc32(data);
const loc = Buffer.alloc(30);
loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0, 8);
loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22);
loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
const localPart = Buffer.concat([loc, name, data]);
const cen = Buffer.alloc(46);
cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 10);
cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
const cenPart = Buffer.concat([cen, name]);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
eocd.writeUInt32LE(cenPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
const zip = Buffer.concat([localPart, cenPart, eocd]);

const entries = E.readZipDirectory(zip);
ok('finds the entry', entries.length === 1 && entries[0].name === 'a.txt');
ok('reads its bytes', E.readZipEntry(zip, entries[0]).toString() === 'hello zip');
let threw = false;
try { E.readZipDirectory(Buffer.from('not a zip at all')); } catch { threw = true; }
ok('rejects a non-archive', threw);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
