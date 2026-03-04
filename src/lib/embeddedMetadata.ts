export interface ParsedEmbeddedArtwork {
  blob: Blob;
  mimeType: string;
}

export interface ParsedAudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  year?: number;
  genres?: string[];
  durationSec?: number;
  artwork?: ParsedEmbeddedArtwork;
}

const MAX_EMBEDDED_TAG_READ_BYTES = 12 * 1024 * 1024;
const AUDIO_DURATION_TIMEOUT_MS = 12_000;

const cleanText = (value?: string): string | undefined => {
  const normalized = value?.replace(/\u0000/g, "").trim();
  return normalized ? normalized : undefined;
};

const parseIntSafe = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const decodeLatin1 = (bytes: Uint8Array): string => {
  return new TextDecoder("iso-8859-1").decode(bytes);
};

const decodeUtf16 = (bytes: Uint8Array, defaultEncoding: "utf-16le" | "utf-16be"): string => {
  if (bytes.length < 2) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2));
  }
  return new TextDecoder(defaultEncoding).decode(bytes);
};

const decodeTextFrame = (frame: Uint8Array): string | undefined => {
  if (frame.length === 0) return undefined;
  const encoding = frame[0];
  const payload = frame.slice(1);
  let decoded = "";

  try {
    if (encoding === 0) {
      decoded = decodeLatin1(payload);
    } else if (encoding === 1) {
      decoded = decodeUtf16(payload, "utf-16le");
    } else if (encoding === 2) {
      decoded = decodeUtf16(payload, "utf-16be");
    } else {
      decoded = new TextDecoder("utf-8").decode(payload);
    }
  } catch {
    decoded = new TextDecoder("utf-8").decode(payload);
  }

  return cleanText(decoded);
};

const decodeSynchsafeInt = (bytes: Uint8Array, offset: number): number => {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
};

const decodeBigEndianInt = (bytes: Uint8Array, offset: number): number => {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
};

const parseApicFrame = (frame: Uint8Array): ParsedEmbeddedArtwork | undefined => {
  if (frame.length <= 4) return undefined;
  const encoding = frame[0];
  let cursor = 1;

  let mimeEnd = cursor;
  while (mimeEnd < frame.length && frame[mimeEnd] !== 0x00) {
    mimeEnd += 1;
  }
  if (mimeEnd >= frame.length) return undefined;

  const mimeType = cleanText(decodeLatin1(frame.slice(cursor, mimeEnd))) ?? "image/jpeg";
  cursor = mimeEnd + 1;

  if (cursor >= frame.length) return undefined;
  cursor += 1; // picture type byte

  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < frame.length) {
      if (frame[cursor] === 0x00 && frame[cursor + 1] === 0x00) {
        cursor += 2;
        break;
      }
      cursor += 2;
    }
  } else {
    while (cursor < frame.length && frame[cursor] !== 0x00) {
      cursor += 1;
    }
    if (cursor < frame.length) cursor += 1;
  }

  if (cursor >= frame.length) return undefined;
  const imageData = frame.slice(cursor);
  if (imageData.length === 0) return undefined;

  return {
    blob: new Blob([imageData], { type: mimeType }),
    mimeType
  };
};

const parseId3Tags = (bytes: Uint8Array): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = {};
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return metadata;
  }

  const version = bytes[3];
  const tagSize = decodeSynchsafeInt(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  while (offset + 10 <= tagEnd) {
    const frameId = decodeLatin1(bytes.slice(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    const frameSize = version === 4 ? decodeSynchsafeInt(bytes, offset + 4) : decodeBigEndianInt(bytes, offset + 4);
    if (frameSize <= 0) break;

    const frameDataStart = offset + 10;
    const frameDataEnd = frameDataStart + frameSize;
    if (frameDataEnd > tagEnd) break;

    const frameData = bytes.slice(frameDataStart, frameDataEnd);
    if (frameId.startsWith("T") && frameId !== "TXXX") {
      const text = decodeTextFrame(frameData);
      if (!text) {
        offset = frameDataEnd;
        continue;
      }
      if (frameId === "TIT2") metadata.title = text;
      if (frameId === "TPE1") metadata.artist = text;
      if (frameId === "TALB") metadata.album = text;
      if (frameId === "TRCK") metadata.trackNumber = parseIntSafe(text.split("/")[0]);
      if (frameId === "TYER" || frameId === "TDRC") metadata.year = parseIntSafe(text.slice(0, 4));
      if (frameId === "TCON") {
        metadata.genres = text
          .split(/[;,/]/g)
          .map((genre) => cleanText(genre))
          .filter((genre): genre is string => Boolean(genre));
      }
    } else if (frameId === "APIC") {
      const artwork = parseApicFrame(frameData);
      if (artwork) metadata.artwork = artwork;
    }

    offset = frameDataEnd;
  }

  return metadata;
};

const readUInt32LE = (view: DataView, offset: number): number => view.getUint32(offset, true);
const readUInt32BE = (view: DataView, offset: number): number => view.getUint32(offset, false);

const parseVorbisCommentBlock = (block: Uint8Array, metadata: ParsedAudioMetadata): void => {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  let cursor = 0;
  if (block.byteLength < 8) return;

  const vendorLength = readUInt32LE(view, cursor);
  cursor += 4 + vendorLength;
  if (cursor + 4 > block.byteLength) return;

  const commentCount = readUInt32LE(view, cursor);
  cursor += 4;

  const genres: string[] = [];
  for (let index = 0; index < commentCount; index += 1) {
    if (cursor + 4 > block.byteLength) break;
    const commentLength = readUInt32LE(view, cursor);
    cursor += 4;
    if (cursor + commentLength > block.byteLength) break;

    const text = cleanText(new TextDecoder("utf-8").decode(block.slice(cursor, cursor + commentLength)));
    cursor += commentLength;
    if (!text) continue;

    const separator = text.indexOf("=");
    if (separator <= 0) continue;
    const key = text.slice(0, separator).toUpperCase();
    const value = cleanText(text.slice(separator + 1));
    if (!value) continue;

    if (key === "TITLE") metadata.title = metadata.title ?? value;
    if (key === "ARTIST") metadata.artist = metadata.artist ?? value;
    if (key === "ALBUM") metadata.album = metadata.album ?? value;
    if (key === "TRACKNUMBER") metadata.trackNumber = metadata.trackNumber ?? parseIntSafe(value);
    if (key === "DATE") metadata.year = metadata.year ?? parseIntSafe(value.slice(0, 4));
    if (key === "GENRE") genres.push(value);
  }

  if (genres.length > 0 && (!metadata.genres || metadata.genres.length === 0)) {
    metadata.genres = genres;
  }
};

const parseFlacPictureBlock = (block: Uint8Array): ParsedEmbeddedArtwork | undefined => {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  let cursor = 0;
  if (block.byteLength < 32) return undefined;

  cursor += 4; // picture type
  const mimeLength = readUInt32BE(view, cursor);
  cursor += 4;
  if (cursor + mimeLength > block.byteLength) return undefined;
  const mimeType = cleanText(new TextDecoder("utf-8").decode(block.slice(cursor, cursor + mimeLength))) ?? "image/jpeg";
  cursor += mimeLength;

  const descriptionLength = readUInt32BE(view, cursor);
  cursor += 4 + descriptionLength;
  if (cursor + 20 > block.byteLength) return undefined;

  cursor += 16; // width, height, depth, indexed-color count
  const dataLength = readUInt32BE(view, cursor);
  cursor += 4;

  if (cursor + dataLength > block.byteLength) return undefined;
  const imageData = block.slice(cursor, cursor + dataLength);
  if (imageData.length === 0) return undefined;

  return {
    blob: new Blob([imageData], { type: mimeType }),
    mimeType
  };
};

const parseFlacMetadata = (bytes: Uint8Array): ParsedAudioMetadata => {
  const metadata: ParsedAudioMetadata = {};
  if (bytes.length < 4 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    return metadata;
  }

  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockLength = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    if (offset + blockLength > bytes.length) break;

    const block = bytes.slice(offset, offset + blockLength);
    if (blockType === 4) {
      parseVorbisCommentBlock(block, metadata);
    } else if (blockType === 6 && !metadata.artwork) {
      metadata.artwork = parseFlacPictureBlock(block);
    }

    offset += blockLength;
    if (isLast) break;
  }

  return metadata;
};

const mergeMetadata = (base: ParsedAudioMetadata, incoming: ParsedAudioMetadata): ParsedAudioMetadata => {
  return {
    title: incoming.title ?? base.title,
    artist: incoming.artist ?? base.artist,
    album: incoming.album ?? base.album,
    trackNumber: incoming.trackNumber ?? base.trackNumber,
    year: incoming.year ?? base.year,
    genres: incoming.genres && incoming.genres.length > 0 ? incoming.genres : base.genres,
    artwork: incoming.artwork ?? base.artwork
  };
};

const readLikelyTagBytes = async (file: File): Promise<Uint8Array> => {
  const initialRead = Math.min(file.size, 1024 * 1024);
  let bytes = new Uint8Array(await file.slice(0, initialRead).arrayBuffer());

  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const tagSize = decodeSynchsafeInt(bytes, 6) + 10;
    if (tagSize > bytes.length) {
      const expandedRead = Math.min(file.size, Math.min(tagSize, MAX_EMBEDDED_TAG_READ_BYTES));
      bytes = new Uint8Array(await file.slice(0, expandedRead).arrayBuffer());
    }
  }

  return bytes;
};

const readAudioDurationSeconds = async (file: File): Promise<number | undefined> => {
  const objectUrl = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = objectUrl;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(undefined);
    }, AUDIO_DURATION_TIMEOUT_MS);

    const cleanup = (): void => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const onLoadedMetadata = (): void => {
      if (settled) return;
      settled = true;
      const duration = audio.duration;
      cleanup();
      if (Number.isFinite(duration) && duration > 0) {
        resolve(Math.round(duration));
        return;
      }
      resolve(undefined);
    };

    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(undefined);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);
  });
};

export const parseAudioFileMetadata = async (file: File): Promise<ParsedAudioMetadata> => {
  const bytes = await readLikelyTagBytes(file);

  let metadata: ParsedAudioMetadata = {};
  metadata = mergeMetadata(metadata, parseId3Tags(bytes));
  metadata = mergeMetadata(metadata, parseFlacMetadata(bytes));
  metadata.durationSec = await readAudioDurationSeconds(file);

  return metadata;
};
