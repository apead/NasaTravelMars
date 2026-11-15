import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TEXTURES, NASA, PLANET } from './config.js';
import { fbm3, ridged3 } from './noise.js';

const R = PLANET.radius;
const HAZE = new THREE.Color(0xc98a62);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(HAZE.clone(), 0.0);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 60000);
scene.add(camera);

// ---------- helpers ----------
const loader = new THREE.TextureLoader();
// Resolves to null on any failure (missing file, or the dev server's index.html fallback).
const tryLoad = (url) =>
  new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));

const smoothstep = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;

// Photo crop rectangles (px) that exclude the black rover-frame borders.
const CROPS = {
  ground: [60, 20, 1540, 1160],
  sand: [40, 15, 1580, 1165],
};

function cropToCanvas(tex, [sx, sy, sw, sh], size) {
  const c = document.createElement('canvas');
  c.width = size ? size : sw;
  c.height = size ? size : sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tex.image, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function cropTexture(tex, rect) {
  const t = new THREE.CanvasTexture(cropToCanvas(tex, rect));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Average color of a photo crop, in linear space (used to normalise the detail texture).
function meanLinearColor(tex, rect) {
  const c = cropToCanvas(tex, rect, 64);
  const d = c.getContext('2d').getImageData(0, 0, 64, 64).data;
  const col = new THREE.Color(), sum = new THREE.Vector3();
  for (let i = 0; i < d.length; i += 4) {
    col.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, THREE.SRGBColorSpace);
    sum.x += col.r; sum.y += col.g; sum.z += col.b;
  }
  return sum.multiplyScalar(4 / d.length);
}

// Equirectangular image -> sampler(dir) returning [r,g,b] in 0..1 (nearest-ish bilinear).
function equirectSampler(tex, maxW = 2048) {
  const w = Math.min(tex.image.width, maxW), h = Math.round(w / 2);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tex.image, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  return (x, y, z) => {
    const u = (Math.atan2(z, -x) / (2 * Math.PI) + 0.5) * w;
    const v = (0.5 - Math.asin(clamp(y, -1, 1)) / Math.PI) * (h - 1);
    const i = Math.floor(u) % w, j = Math.min(Math.floor(v), h - 2);
    const i2 = (i + 1) % w, fx = u - Math.floor(u), fy = v - j;
    const out = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const a = d[(j * w + i) * 4 + ch], b = d[(j * w + i2) * 4 + ch];
      const e = d[((j + 1) * w + i) * 4 + ch], f = d[((j + 1) * w + i2) * 4 + ch];
      out[ch] = ((a + (b - a) * fx) * (1 - fy) + (e + (f - e) * fx) * fy) / 255;
    }
    return out;
  };
}

// ---------- procedural planet shape ----------
function seededRandom(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const CRATERS = (() => {
  const rnd = seededRandom(1234);
  const list = [];
  for (let i = 0; i < 90; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const r = 0.012 + Math.pow(rnd(), 3) * 0.13; // angular radius, radians
    list.push({ v, r, cosCut: Math.cos(r * 1.7) });
  }
  return list;
})();

// Procedural height (world units) for a unit direction.
function proceduralHeight(x, y, z) {
  const base = fbm3(x * 2.4 + 10, y * 2.4, z * 2.4, 5, 3);
  const rid = ridged3(x * 5, y * 5, z * 5, 4, 11);
  let h = (base * 0.75 + rid * 0.22 - y * 0.1 - 0.5) * PLANET.relief;
  for (const c of CRATERS) {
    const dot = x * c.v.x + y * c.v.y + z * c.v.z;
    if (dot < c.cosCut) continue;
    const t = Math.acos(Math.min(dot, 1)) / c.r;
    if (t < 1) h -= (1 - t * t) * (1.5 + c.r * 50);
    else h += Math.exp(-((t - 1) ** 2) * 18) * (0.5 + c.r * 12);
  }
  return h;
}

// Cube-sphere (no pole pinching) welded into a single indexed mesh.
function cubeSphereDirections(N) {
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const verts = (N + 1) * (N + 1);
  const pos = new Float32Array(faces.length * verts * 3);
  const index = new Uint32Array(faces.length * N * N * 6);
  let p = 0, ii = 0;
  const v = new THREE.Vector3();
  faces.forEach(([a, u, w], f) => {
    const base = f * verts;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const s = Math.tan(((i / N) * 2 - 1) * Math.PI / 4);
        const t = Math.tan(((j / N) * 2 - 1) * Math.PI / 4);
        v.set(a[0] + u[0] * s + w[0] * t, a[1] + u[1] * s + w[1] * t, a[2] + u[2] * s + w[2] * t).normalize();
        pos[p++] = v.x; pos[p++] = v.y; pos[p++] = v.z;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const A = base + j * (N + 1) + i, B = A + 1, C = A + N + 1, D = C + 1;
        index[ii++] = A; index[ii++] = B; index[ii++] = C;
        index[ii++] = B; index[ii++] = D; index[ii++] = C;
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return mergeVertices(g, 1e-5);
}

// ---------- lighting / sun ----------
const sunDir = new THREE.Vector3(); // set after the start position is chosen
const sun = new THREE.DirectionalLight(0xffe2c4, 3.4);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xe0a77f, 0x3a1c10, 0.35));

// ---------- planet build ----------
let heightAtDir = (x, y, z) => proceduralHeight(x, y, z);

async function buildPlanet() {
  const [colorTex, heightTex, ground, sand, rock, sunTex] = await Promise.all([
    tryLoad(TEXTURES.color), tryLoad(TEXTURES.height),
    tryLoad(NASA.ground), tryLoad(NASA.sand), tryLoad(NASA.rock), tryLoad(NASA.sun),
  ]);

  const heightSample = heightTex ? equirectSampler(heightTex) : null;
  const colorSample = colorTex ? equirectSampler(colorTex) : null;
  if (heightSample) {
    heightAtDir = (x, y, z) =>
      (heightSample(x, y, z)[0] - 0.35) * PLANET.heightScale +
      (fbm3(x * 40, y * 40, z * 40, 3, 5) - 0.5) * 1.2;
  }

  const geo = cubeSphereDirections(PLANET.segments);
  const dirs = geo.attributes.position.array;
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const mixw = new Float32Array(count);
  const heights = new Float32Array(count);

  // Albedo palette (linear), roughly the average tone of the NASA ground photos.
  const dark = new THREE.Color(0x45200f), mid = new THREE.Color(0x9a5a33), light = new THREE.Color(0xc98e62);
  const caps = new THREE.Color(0xe8e0d8), c = new THREE.Color();
  const range = colorSample ? PLANET.heightScale : PLANET.relief;

  for (let k = 0; k < count; k++) {
    const x = dirs[k * 3], y = dirs[k * 3 + 1], z = dirs[k * 3 + 2];
    const h = heightAtDir(x, y, z);
    heights[k] = h;
    const r = R + h;
    dirs[k * 3] = x * r; dirs[k * 3 + 1] = y * r; dirs[k * 3 + 2] = z * r;

    const mottle = fbm3(x * 14, y * 14, z * 14, 4, 7);
    if (colorSample) {
      const [cr, cg, cb] = colorSample(x, y, z);
      c.setRGB(cr, cg, cb, THREE.SRGBColorSpace);
    } else {
      const t = clamp(h / range + 0.5 + (mottle - 0.5) * 0.9, 0, 1);
      if (t < 0.5) c.lerpColors(dark, mid, t * 2); else c.lerpColors(mid, light, (t - 0.5) * 2);
      const cap = smoothstep(Math.abs(y) + (mottle - 0.5) * 0.1, 0.86, 0.93);
      c.lerp(caps, cap);
    }
    colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    mixw[k] = smoothstep(fbm3(x * 4 + 3, y * 4, z * 4, 3, 31) * 0.7 + (0.5 - h / range) * 0.4, 0.45, 0.7);
  }
  geo.attributes.position.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('mixw', new THREE.BufferAttribute(mixw, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  if (ground) {
    const mapG = cropTexture(ground, CROPS.ground);
    const mapS = cropTexture(sand || ground, sand ? CROPS.sand : CROPS.ground);
    const meanG = meanLinearColor(ground, CROPS.ground);
    const meanS = meanLinearColor(sand || ground, sand ? CROPS.sand : CROPS.ground);
    enableGroundDetail(mat, { mapG, mapS, meanG, meanS });
  }
  scene.add(new THREE.Mesh(geo, mat));

  if (rock) scatterBoulders(rock);
  addSunDisc(sunTex);
  console.info('Mars textures:', {
    globalColor: !!colorTex, globalHeight: !!heightTex,
    ground: !!ground, sand: !!sand, rock: !!rock, sun: !!sunTex,
    vertices: count,
  });
}

// Triplanar NASA close-up detail: relative color (photo / photo mean) multiplies the planet albedo,
// and the photo's brightness perturbs the normal as a bump map. Both fade out with distance.
function enableGroundDetail(mat, { mapG, mapS, meanG, meanS }) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      mapG: { value: mapG }, mapS: { value: mapS },
      meanG: { value: meanG }, meanS: { value: meanS },
      tileSize: { value: PLANET.detailTile }, bumpWorld: { value: PLANET.bump },
      detailNear: { value: PLANET.detailNear }, detailFar: { value: PLANET.detailFar },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float mixw;\nvarying float vMix;\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMix = mixw; vObjPos = position; vObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D mapG; uniform sampler2D mapS;
uniform vec3 meanG; uniform vec3 meanS;
uniform float tileSize; uniform float bumpWorld; uniform float detailNear; uniform float detailFar;
varying float vMix; varying vec3 vObjPos; varying vec3 vObjN;
vec4 tri(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
vec3 perturbN(vec3 surfPos, vec3 surfNorm, vec2 dH, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos)); vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm); vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float dd = length(vViewPosition);
float fadeD = 1.0 - smoothstep(detailNear, detailFar, dd);
vec3 w3 = pow(abs(normalize(vObjN)), vec3(4.0)); w3 /= (w3.x + w3.y + w3.z);
vec3 p3 = vObjPos / tileSize;
vec3 relG = tri(mapG, p3, w3).rgb / meanG;
vec3 relS = tri(mapS, p3 * 1.4, w3).rgb / meanS;
vec3 rel = mix(relG, relS, vMix);
vec3 bigG = tri(mapG, p3 * 0.09, w3).rgb / meanG;
rel *= clamp(pow(dot(bigG, vec3(0.3333)), 0.7), 0.6, 1.5);
diffuseColor.rgb *= mix(vec3(1.0), rel, fadeD);
float bumpH = dot(rel, vec3(0.3333)) * fadeD;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
float pixW = length(dFdx(vViewPosition)) + 1e-4;
normal = perturbN(-vViewPosition, normal, vec2(dFdx(bumpH), dFdy(bumpH)) * (bumpWorld / pixW), faceDirection);`);
  };
}

let boulderMesh = null; // hidden from orbit, where they would only show up as specks

// Lumpy boulders scattered over the whole planet, textured with the WATSON rock close-up.
function scatterBoulders(rockTex) {
  rockTex.colorSpace = THREE.SRGBColorSpace;
  rockTex.wrapS = rockTex.wrapT = THREE.MirroredRepeatWrapping;
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 0.75 + fbm3(x * 2 + 5, y * 2, z * 2, 3, 5) * 0.6;
    p.setXYZ(i, x * d, y * d * 0.6, z * d);
  }
  geo.computeVertexNormals();
  const COUNT = PLANET.boulders;
  const mesh = new THREE.InstancedMesh(
    geo, new THREE.MeshStandardMaterial({ map: rockTex, roughness: 1, color: 0xd8b8a0 }), COUNT);
  const rnd = seededRandom(7);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), spin = new THREE.Quaternion();
  const e = new THREE.Euler(), s = new THREE.Vector3(), pos = new THREE.Vector3(), d = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < COUNT; i++) {
    d.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const size = 0.15 + Math.pow(rnd(), 4) * 2.2; // mostly pebbles, a few big rocks
    pos.copy(d).multiplyScalar(R + heightAtDir(d.x, d.y, d.z) + size * 0.15);
    q.setFromUnitVectors(Y, d);
    e.set(rnd() * 0.4, rnd() * Math.PI * 2, rnd() * 0.4);
    spin.setFromEuler(e);
    q.multiply(spin);
    s.set(size * (0.8 + rnd() * 0.6), size, size * (0.8 + rnd() * 0.6));
    mesh.setMatrixAt(i, m.compose(pos, q, s));
  }
  boulderMesh = mesh;
  scene.add(mesh);
}

// Sun disc from the Mastcam-Z Phobos-transit frame: circular crop, feathered into alpha.
function addSunDisc(tex) {
  if (!tex) return;
  const Rr = 64, cx = 445, cy = 405; // sun center in the 768x768 source
  const c = document.createElement('canvas');
  c.width = c.height = Rr * 2;
  const ctx = c.getContext('2d');
  ctx.drawImage(tex.image, cx - Rr, cy - Rr, Rr * 2, Rr * 2, 0, 0, Rr * 2, Rr * 2);
  ctx.globalCompositeOperation = 'destination-in';
  const g = ctx.createRadialGradient(Rr, Rr, Rr * 0.7, Rr, Rr, Rr);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, Rr * 2, Rr * 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: t, fog: false, depthWrite: false, toneMapped: false, color: 0xffe0b8,
  }));
  sprite.position.copy(sunDir).multiplyScalar(9000);
  sprite.scale.setScalar(900);
  scene.add(sprite);
}

// ---------- atmosphere + stars ----------
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(R + PLANET.atmosphere, 96, 48),
  new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { sunDir: { value: sunDir } },
    vertexShader: `varying vec3 vN; varying vec3 vW;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 sunDir; varying vec3 vN; varying vec3 vW;
      void main() {
        vec3 v = normalize(cameraPosition - vW);
        float f = pow(1.0 - max(dot(vN, v), 0.0), 3.0);
        float day = smoothstep(-0.3, 0.4, dot(vN, sunDir));
        gl_FragColor = vec4(vec3(0.85, 0.5, 0.32) * f * day * 1.2, f * day);
      }`,
  }),
);
scene.add(atmosphere);

const starCount = 5000, starPos = new Float32Array(starCount * 3);
{
  const rnd = seededRandom(99), v = new THREE.Vector3();
  for (let i = 0; i < starCount; i++) {
    v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(30000);
    starPos.set([v.x, v.y, v.z], i * 3);
  }
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false,
}));
stars.frustumCulled = false;
scene.add(stars);

// ---------- flight controls ----------
const pos = new THREE.Vector3();
const vel = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up2 = new THREE.Vector3();
const tmp = new THREE.Vector3();
const basis = new THREE.Matrix4();
const keys = new Set();
let boost = false;

function groundRadiusAt(v) {
  const l = v.length();
  return R + heightAtDir(v.x / l, v.y / l, v.z / l);
}

// Start above the surface, looking along the horizon with the sun low ahead.
{
  const d0 = new THREE.Vector3(0.3, 0.1, 1).normalize();
  pos.copy(d0).multiplyScalar(groundRadiusAt(d0) + 28);
  up.copy(pos).normalize();
  const f0 = new THREE.Vector3(-1, 0, 0).addScaledVector(up, up.x).normalize(); // tangent toward -x
  sunDir.copy(f0).multiplyScalar(0.94).addScaledVector(up, 0.34).normalize();
  sun.position.copy(sunDir).multiplyScalar(1000);
  camera.position.copy(pos);
  camera.up.copy(up);
  camera.lookAt(pos.clone().addScaledVector(f0, 10).addScaledVector(up, -1.2));
}

function stabilise() {
  up.copy(pos).normalize();
  camera.getWorldDirection(fwd);
  right.crossVectors(fwd, up);
  if (right.lengthSq() < 1e-6) return;
  right.normalize();
  up2.crossVectors(right, fwd);
  basis.makeBasis(right, up2, tmp.copy(fwd).negate());
  camera.quaternion.setFromRotationMatrix(basis);
}

function look(dx, dy) {
  up.copy(pos).normalize();
  const before = camera.quaternion.clone();
  camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(up, -dx * 0.0022));
  camera.rotateX(-dy * 0.0022);
  camera.getWorldDirection(fwd);
  if (Math.abs(fwd.dot(up)) > 0.995) camera.quaternion.copy(before); // don't flip over the pole
}

const dom = renderer.domElement;
let dragging = false;
dom.addEventListener('click', () => dom.requestPointerLock?.());
dom.addEventListener('mousedown', () => (dragging = true));
addEventListener('mouseup', () => (dragging = false));
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === dom || dragging) look(e.movementX, e.movementY);
});
addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

window.mars = { pos, vel, camera }; // handy for poking around in the console

const hud = document.getElementById('hud');
let hudTimer = 0;
const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);

  stabilise();
  camera.getWorldDirection(fwd);
  right.crossVectors(fwd, up).normalize();

  const alt = pos.length() - groundRadiusAt(pos);
  boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = clamp(alt * 1.0, 6, 500) * (boost ? 4 : 1);

  const wish = tmp.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(right);
  if (keys.has('Space') || keys.has('KeyE')) wish.add(up);
  if (keys.has('KeyC') || keys.has('KeyQ')) wish.sub(up);
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
  vel.lerp(wish, 1 - Math.exp(-dt * 4));
  pos.addScaledVector(vel, dt);

  // Keep above the ground.
  const minR = groundRadiusAt(pos) + PLANET.minAltitude;
  if (pos.length() < minR) {
    pos.setLength(minR);
    const inward = vel.dot(up);
    if (inward < 0) vel.addScaledVector(up, -inward);
  }
  camera.position.copy(pos);

  // Environment: sky haze, fog and stars depend on altitude and time of day.
  const a = clamp((pos.length() - groundRadiusAt(pos)) / 90, 0, 1);
  const dayK = smoothstep(up.copy(pos).normalize().dot(sunDir), -0.15, 0.25);
  const skyK = dayK * (1 - a);
  scene.background.copy(HAZE).multiplyScalar(skyK);
  scene.fog.color.copy(HAZE).multiplyScalar(Math.max(skyK, 0.02));
  scene.fog.density = 0.0065 * (1 - a);
  stars.material.opacity = (1 - skyK) ** 3;
  if (boulderMesh) boulderMesh.visible = alt < 220;

  renderer.render(scene, camera);

  hudTimer -= dt;
  if (hudTimer <= 0 && hud) {
    hudTimer = 0.15;
    hud.textContent = `alt ${alt.toFixed(0)} · speed ${vel.length().toFixed(0)}` +
      ' — click to look · WASD fly · Space/C up/down · Shift boost';
  }
}

buildPlanet();
renderer.setAnimationLoop(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
