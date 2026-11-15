// Seeded value-noise (2D and 3D) + fbm/ridged helpers for the procedural planet.
const smooth = (t) => t * t * (3 - 2 * t);

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1103515245) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise(x, y, seed = 1) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * xf;
  const bottom = c + (d - c) * xf;
  return top + (bottom - top) * yf;
}

export function valueNoise3(x, y, z, seed = 1) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi, seed), c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  return l(
    l(l(c000, c100, xf), l(c010, c110, xf), yf),
    l(l(c001, c101, xf), l(c011, c111, xf), yf),
    zf,
  );
}

export function fbm(x, y, octaves = 6, seed = 1) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise(x * f, y * f, seed + i);
    f *= 2; amp *= 0.5;
  }
  return v;
}

export function fbm3(x, y, z, octaves = 6, seed = 1) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise3(x * f, y * f, z * f, seed + i);
    f *= 2; amp *= 0.5;
  }
  return v;
}

// Ridged variant gives sharper ridge crests.
export function ridged3(x, y, z, octaves = 5, seed = 1) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * (1 - Math.abs(valueNoise3(x * f, y * f, z * f, seed + i) * 2 - 1));
    f *= 2; amp *= 0.5;
  }
  return v;
}
