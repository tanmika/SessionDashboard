import { randomBytes } from 'node:crypto'

// Crockford-style Base32 alphabet (no i / l / o / u — visually unambiguous).
const ALPHABET = 'abcdefghjkmnpqrstvwxyz0123456789'
const ID_LENGTH = 8
const PREFIX = 'chain_'

export function generateChainId(): string {
  // One random byte per output character, taken modulo the alphabet length.
  // 8 chars × log2(32) = 40 bits of entropy; collision risk is negligible
  // for the expected volume (~10^4 chains/year per user).
  const bytes = randomBytes(ID_LENGTH)
  let out = ''
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return PREFIX + out
}

const CHAIN_ID_RE = new RegExp(`^${PREFIX}[${ALPHABET}]{${ID_LENGTH}}$`)

export function isChainId(value: string | undefined | null): value is string {
  return typeof value === 'string' && CHAIN_ID_RE.test(value)
}
