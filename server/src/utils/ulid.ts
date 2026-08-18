import crypto from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(timestamp: number, length: number): string {
  let result = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = timestamp % 32;
    result = ENCODING[mod] + result;
    timestamp = Math.floor(timestamp / 32);
  }
  return result;
}

function encodeRandom(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ENCODING[bytes[i] % 32];
  }
  return result;
}

export function generateUlid(): string {
  const timestamp = Date.now();
  return encodeTime(timestamp, 10) + encodeRandom(16);
}
