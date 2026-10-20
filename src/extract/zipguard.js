// Refuses zip files (.xlsx, .docx) that expand to far more than they weigh ("zip bombs").
// Each entry is inflated here with a hard output cap, so the declared sizes in the archive
// cannot lie their way past the limit. Runs before exceljs loads the workbook into memory.
const zlib = require('zlib');

const MAX_TOTAL = 25 * 1024 * 1024; // all entries together, uncompressed
const MAX_ENTRIES = 2000;

function tooLarge() {
  const err = new Error('This spreadsheet is too large to read. Save only the SOF sheet and upload that.');
  err.unsupported = true;
  return err;
}
function invalid() {
  const err = new Error('This file is not a valid Excel workbook.');
  err.unsupported = true;
  return err;
}

function assertSafeZip(buf, { maxTotal = MAX_TOTAL, maxEntries = MAX_ENTRIES } = {}) {
  // End of central directory record: last 22 bytes plus an optional comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) throw tooLarge(); // ZIP64: never needed for an SOF
  if (entries > maxEntries) throw tooLarge();

  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw invalid();
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    const budget = maxTotal - total;
    if (method === 0) total += data.length;
    else if (method === 8) {
      try {
        total += zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length;
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw tooLarge();
        throw invalid();
      }
    } else throw invalid();
    if (total > maxTotal) throw tooLarge();
  }
  return total;
}

module.exports = { assertSafeZip, MAX_TOTAL };
