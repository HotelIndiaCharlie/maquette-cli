// Reads one file out of a zip archive, such as document.json out of a .designcraft file. Only
// what DesignCraft writes: stored or deflated entries, no zip64, no encryption.
import { inflateRawSync } from "node:zlib";
export function readZipEntry(zip, name) {
    // The end-of-central-directory record is in the last 64 KB plus its own 22 bytes.
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        return undefined;
    const entries = zip.readUInt16LE(eocd + 10);
    let at = zip.readUInt32LE(eocd + 16);
    for (let n = 0; n < entries && zip.readUInt32LE(at) === 0x02014b50; n++) {
        const method = zip.readUInt16LE(at + 10);
        const size = zip.readUInt32LE(at + 20);
        const nameLength = zip.readUInt16LE(at + 28);
        const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
        const local = zip.readUInt32LE(at + 42);
        if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
            const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
            const data = zip.subarray(start, start + size);
            if (method === 0)
                return Buffer.from(data);
            if (method === 8)
                return inflateRawSync(data);
            return undefined;
        }
        at += 46 + nameLength + skip;
    }
    return undefined;
}
