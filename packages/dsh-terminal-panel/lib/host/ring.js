/**
 * Bounded UTF-8 tail buffers.
 *
 * Terminal sessions keep a bounded plain-text tail for model-facing reads and
 * for the interactive-shell marker parser. The bound is expressed in UTF-8
 * bytes (the same unit the model-facing output budget uses); trimming never
 * splits a multi-byte code point, so the retained text is always valid.
 */

const CONTINUATION = 0b1000_0000
const CONTINUATION_MASK = 0b1100_0000

/**
 * @param {string} text candidate text.
 * @returns {number} UTF-8 byte length.
 */
export function utf8ByteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Keep at most `maxBytes` UTF-8 bytes from the tail of `text`, never cutting a
 * multi-byte code point in half.
 * @param {string} text source text.
 * @param {number} maxBytes positive byte bound.
 * @returns {{ text: string, truncated: boolean }} tail and whether bytes were dropped.
 */
export function tailByBytes(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', truncated: false }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let start = bytes.length - maxBytes
  // Skip UTF-8 continuation bytes so the slice starts on a code-point boundary.
  while (start < bytes.length && (bytes[start] & CONTINUATION_MASK) === CONTINUATION) start += 1
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/**
 * A bounded tail buffer over strings, bounded by UTF-8 bytes rather than code
 * units. Appends are amortised O(1); trimming only happens when the bound is
 * exceeded.
 */
export class ByteTail {
  /** @type {{ text: string, bytes: number }[]} */
  #parts = []
  /** @type {number} */
  #bytes = 0
  /** @type {number} */
  #maxBytes

  /**
   * @param {number} maxBytes positive byte bound.
   */
  constructor(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('ByteTail: maxBytes must be a positive safe integer')
    }
    this.#maxBytes = maxBytes
  }

  /** Current retained UTF-8 byte length. */
  get byteLength() {
    return this.#bytes
  }

  /** Configured byte bound. */
  get maxBytes() {
    return this.#maxBytes
  }

  /**
   * Append text and trim the oldest bytes when the bound is exceeded.
   * @param {string} text chunk to append.
   * @returns {void}
   */
  append(text) {
    if (typeof text !== 'string' || text.length === 0) return
    const bytes = utf8ByteLength(text)
    this.#parts.push({ text, bytes })
    this.#bytes += bytes
    this.#trim()
  }

  /** Replace all retained text with `text` (still bounded). @param {string} text new content. */
  reset(text = '') {
    this.#parts = []
    this.#bytes = 0
    this.append(text)
  }

  /** Drop every retained byte. */
  clear() {
    this.#parts = []
    this.#bytes = 0
  }

  /**
   * @returns {string} the retained tail, oldest first.
   */
  text() {
    if (this.#parts.length === 0) return ''
    if (this.#parts.length === 1) return this.#parts[0].text
    let out = ''
    for (const part of this.#parts) out += part.text
    return out
  }

  #trim() {
    const max = this.#maxBytes
    // Drop whole chunks from the head while they are entirely outside the bound.
    while (this.#bytes > max && this.#parts.length > 1) {
      const first = this.#parts[0]
      if (first.bytes <= this.#bytes - max) {
        this.#parts.shift()
        this.#bytes -= first.bytes
        continue
      }
      break
    }
    if (this.#bytes > max) {
      // A single chunk (or the head chunk) still exceeds the bound: keep its tail.
      const first = this.#parts[0]
      const targetBytes = Math.max(0, first.bytes - (this.#bytes - max))
      const kept = targetBytes === 0 ? { text: '' } : tailByBytes(first.text, targetBytes)
      const keptBytes = utf8ByteLength(kept.text)
      this.#bytes -= first.bytes - keptBytes
      this.#parts[0] = { text: kept.text, bytes: keptBytes }
    }
  }
}
