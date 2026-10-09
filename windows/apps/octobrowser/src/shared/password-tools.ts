/**
 * Password helpers for the password manager.
 *
 * The generator draws every character from the platform CSPRNG (`crypto`), with
 * rejection sampling so no character is favoured by modulo bias. The strength
 * estimate is a plain heuristic that runs on text the user is typing; it never
 * stores or sends anything. Both are pure functions, so the renderer and the tests
 * share the same behaviour.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';

/** Uniform random integer in [0, n), drawn from the CSPRNG without modulo bias. */
export function randomIndex(n: number, fill: (buf: Uint32Array) => Uint32Array = (buf) => crypto.getRandomValues(buf)): number {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError(`randomIndex: invalid range ${n}`);
  // Accept only values below the largest multiple of n that fits in 32 bits.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    fill(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export interface GenerateOptions {
  /** Characters in the result. Clamped to 8..128, default 20. */
  length?: number;
  /** Include symbols (default true). Upper, lower and digits are always used. */
  symbols?: boolean;
}

/**
 * A random password that always contains a lowercase letter, an uppercase letter,
 * a digit and (unless disabled) a symbol. The guaranteed characters are shuffled
 * in, so they are not always at the start.
 */
export function generatePassword(options: GenerateOptions = {}): string {
  const requested = typeof options.length === 'number' && Number.isFinite(options.length) ? Math.floor(options.length) : 20;
  const length = Math.min(128, Math.max(8, requested));
  const sets = [LOWER, UPPER, DIGITS, ...(options.symbols === false ? [] : [SYMBOLS])];
  const alphabet = sets.join('');
  const out: string[] = sets.map((set) => set[randomIndex(set.length)]);
  while (out.length < length) out.push(alphabet[randomIndex(alphabet.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

/** 0 = weak, 1 = fair, 2 = good, 3 = strong. */
export type PasswordStrengthLevel = 0 | 1 | 2 | 3;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '123456', '12345678', '123456789', '111111', '000000',
  'qwerty', 'qwerty123', 'abc123', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey',
  'dragon', 'football', 'baseball', 'sunshine', 'master', 'login', 'princess', 'secret',
]);

/**
 * Estimate how hard a password is to guess. Length matters most, then how many
 * character classes it mixes. Repeats, keyboard or number runs and well-known
 * passwords pull the score down. Under 8 characters is always weak.
 */
export function passwordStrength(password: string): { level: PasswordStrengthLevel; score: number } {
  const chars = [...password];
  if (chars.length < 8 || COMMON_PASSWORDS.has(password.toLowerCase())) return { level: 0, score: 0 };

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = Math.min(chars.length, 16) * 4 + Math.min(Math.max(chars.length - 16, 0), 8);
  score += [0, 0, 10, 20, 30][classes];
  if (new Set(chars).size / chars.length < 0.5) score -= 15;
  if (/(.)\1\1/.test(password)) score -= 10;
  if (/(012|123|234|345|456|567|678|789|890|abc|bcd|cde|def|efg|fgh|qwe|asd|zxc)/i.test(password)) score -= 10;
  score = Math.max(0, Math.min(100, score));

  const level: PasswordStrengthLevel = score < 40 ? 0 : score < 60 ? 1 : score < 75 ? 2 : 3;
  return { level, score };
}
