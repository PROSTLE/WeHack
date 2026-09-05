// Replays the exact extractPdf loop with logging, to find where real content
// streams are being lost.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const os = require('os');

const file = path.join(os.homedir(), 'Documents', '25BCE2378.pdf');
const buf = fs.readFileSync(file);
const latin = buf.toString('latin1');

let streams = 0, inflated = 0, skippedImage = 0, noBT = 0, failed = 0;
const re = /(?<!end)stream\r?\n/g;
let m;
while ((m = re.exec(latin)) !== null && streams < 12) {
  const start = m.index + m[0].length;
  const end = latin.indexOf('endstream', start);
  if (end === -1) break;
  streams++;

  const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
  const dict = latin.slice(dictStart, m.index);
  re.lastIndex = end;

  let data = buf.subarray(start, end);
  const isImage = /\/Subtype\s*\/Image/.test(dict) ||
                  /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict);
  const isFlate = /\/FlateDecode/.test(dict);

  let status = 'raw';
  if (isImage) { skippedImage++; status = 'IMAGE-SKIP'; }
  else if (isFlate) {
    try { data = zlib.inflateSync(data); inflated++; status = 'inflated'; }
    catch (e1) {
      try { data = zlib.inflateRawSync(data); inflated++; status = 'inflatedRaw'; }
      catch (e2) { failed++; status = 'INFLATE-FAIL: ' + e1.message.slice(0, 40); }
    }
  }

  const decoded = status.startsWith('inflat') ? data.toString('latin1') : '';
  const hasBT = /BT/.test(decoded);
  if (status.startsWith('inflat') && !hasBT) noBT++;

  console.log(`#${String(streams).padStart(2)} ${status.padEnd(22)} bytes=${String(data.length).padStart(8)} hasBT=${hasBT}`);
  console.log(`     dict: ${dict.replace(/\s+/g, ' ').slice(0, 110)}`);
  if (status.startsWith('inflat')) {
    console.log(`     head: ${JSON.stringify(decoded.slice(0, 90))}`);
  }
}
console.log(`\nstreams=${streams} inflated=${inflated} images=${skippedImage} noBT=${noBT} failed=${failed}`);
