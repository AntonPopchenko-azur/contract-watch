// Byte-aligned Ethereum Keccak-256, used only for public address checksums.
// Keccak-f[1600]: https://keccak.team/keccak_specs_summary.html
const MASK64 = (1n << 64n) - 1n;
const RATE = 136; // 1088-bit rate, 512-bit capacity, 256-bit output.
// Lanes are indexed x + 5*y; offsets are listed by row y.
const ROTATIONS = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14
].map(BigInt);
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const rotate = (lane, shift) => ((lane << shift) | (lane >> (64n - shift))) & MASK64;

function permute(state) {
  const columns = new Array(5);
  const moved = new Array(25);
  for (const constant of ROUND_CONSTANTS) {
    // Theta: mix the parity of adjacent columns into each lane.
    for (let x = 0; x < 5; x++) {
      columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const delta = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= delta;
    }
    // Rho and pi: rotate each lane and move (x,y) to (y,2*x+3*y).
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], ROTATIONS[x + 5 * y]);
      }
    }
    // Chi, then iota. AND with a 64-bit lane bounds the BigInt complement.
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = moved[x + 5 * y] ^
          (~moved[(x + 1) % 5 + 5 * y] & moved[(x + 2) % 5 + 5 * y]);
      }
    }
    state[0] ^= constant;
  }
}

function absorb(state, block) {
  // Keccak's lane bytes are little-endian.
  for (let i = 0; i < block.length; i++) {
    state[Math.floor(i / 8)] ^= BigInt(block[i]) << BigInt(8 * (i % 8));
  }
  permute(state);
}

export function keccak256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Keccak input must be bytes.');
  const state = new Array(25).fill(0n);
  let offset = 0;
  for (; offset + RATE <= bytes.length; offset += RATE) {
    absorb(state, bytes.subarray(offset, offset + RATE));
  }
  const last = new Uint8Array(RATE);
  last.set(bytes.subarray(offset));
  // Legacy Keccak pad10*1: suffix 0x01, NOT SHA3-256's 0x06.
  // An exact-rate input needs a new block; at RATE-1 bytes both bits share a byte.
  last[bytes.length - offset] ^= 0x01;
  last[RATE - 1] ^= 0x80;
  absorb(state, last);
  const digest = Buffer.alloc(32);
  for (let i = 0; i < digest.length; i++) {
    digest[i] = Number((state[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 0xffn);
  }
  return digest.toString('hex');
}
