/*
 * A .docx is a zip of XML files, so answering one in the browser
 * means opening a zip and writing one back.
 *
 * Only what a .docx needs is here: stored and deflated entries in,
 * stored entries out. Chrome's own DecompressionStream does the
 * inflating, so there is no library to ship, and writing entries
 * uncompressed keeps the writer small and the result valid - Word
 * opens it either way, it is only a little larger on disk.
 */

const CRC_TABLE = (() => {

    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {

        let value = i;

        for (let bit = 0; bit < 8; bit++) {

            value = (value & 1)
                ? (0xEDB88320 ^ (value >>> 1))
                : (value >>> 1);
        }

        table[i] = value >>> 0;
    }

    return table;
})();


function crc32(bytes) {

    let crc = 0xFFFFFFFF;

    for (let i = 0; i < bytes.length; i++) {

        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}


async function inflateRaw(bytes) {

    const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}


/*
 * Reads every entry of a zip, using the central directory rather
 * than scanning for local headers - that is the part a zip is
 * meant to be read from, and the only part that is reliable when
 * entries carry data descriptors.
 */
async function unzip(buffer) {

    const bytes = new Uint8Array(buffer);

    const view = new DataView(buffer);

    let end = -1;

    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {

        if (view.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    }

    if (end === -1) {
        throw new Error("That file is not a Word document.");
    }

    const count = view.getUint16(end + 10, true);

    let at = view.getUint32(end + 16, true);

    const entries = new Map();

    for (let n = 0; n < count; n++) {

        if (view.getUint32(at, true) !== 0x02014b50) {
            break;
        }

        const method = view.getUint16(at + 10, true);
        const compressedSize = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localAt = view.getUint32(at + 42, true);

        const name = new TextDecoder().decode(
            bytes.subarray(at + 46, at + 46 + nameLength)
        );

        /* The local header repeats the name and may carry extra. */
        const localNameLength = view.getUint16(localAt + 26, true);
        const localExtraLength = view.getUint16(localAt + 28, true);

        const dataAt = localAt + 30 + localNameLength + localExtraLength;

        const raw = bytes.subarray(dataAt, dataAt + compressedSize);

        entries.set(name, {
            method: method,
            bytes: raw
        });

        at += 46 + nameLength + extraLength + commentLength;
    }

    return {
        names: () => Array.from(entries.keys()),

        async read(name) {

            const entry = entries.get(name);

            if (!entry) {
                return null;
            }

            return entry.method === 0
                ? entry.bytes
                : await inflateRaw(entry.bytes);
        },

        entries: entries
    };
}


/*
 * Writes a zip with every entry stored, not compressed. The parts
 * that were not touched are copied back in their original form -
 * inflated first, because a stored entry cannot hold deflated
 * bytes.
 */
async function zip(files) {

    const chunks = [];

    const directory = [];

    let offset = 0;

    const encoder = new TextEncoder();

    for (const [name, data] of files) {

        const nameBytes = encoder.encode(name);

        const sum = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);

        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);       /* version */
        localView.setUint16(6, 0, true);        /* flags */
        localView.setUint16(8, 0, true);        /* stored */
        localView.setUint16(10, 0, true);       /* time */
        localView.setUint16(12, 0, true);       /* date */
        localView.setUint32(14, sum, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, nameBytes.length, true);
        localView.setUint16(28, 0, true);

        local.set(nameBytes, 30);

        chunks.push(local, data);

        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);

        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0, true);
        centralView.setUint16(10, 0, true);
        centralView.setUint16(12, 0, true);
        centralView.setUint16(14, 0, true);
        centralView.setUint32(16, sum, true);
        centralView.setUint32(20, data.length, true);
        centralView.setUint32(24, data.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint16(30, 0, true);
        centralView.setUint16(32, 0, true);
        centralView.setUint16(34, 0, true);
        centralView.setUint16(36, 0, true);
        centralView.setUint32(38, 0, true);
        centralView.setUint32(42, offset, true);

        central.set(nameBytes, 46);

        directory.push(central);

        offset += local.length + data.length;
    }

    const directoryStart = offset;

    let directorySize = 0;

    directory.forEach((entry) => {
        chunks.push(entry);
        directorySize += entry.length;
    });

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);

    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, directory.length, true);
    endView.setUint16(10, directory.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, directoryStart, true);
    endView.setUint16(20, 0, true);

    chunks.push(end);

    let total = 0;

    chunks.forEach(chunk => { total += chunk.length; });

    const out = new Uint8Array(total);

    let at = 0;

    chunks.forEach((chunk) => {
        out.set(chunk, at);
        at += chunk.length;
    });

    return out;
}


if (typeof module !== "undefined") {
    module.exports = { unzip, zip, crc32, inflateRaw };
}
