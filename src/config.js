// Optional global textures (served from /public). Equirectangular (2:1) maps wrapped around the planet.
// Missing files fall back to a procedural planet.
export const TEXTURES = {
  color: 'textures/mars-color.jpg',   // global color map
  height: 'textures/mars-height.png', // global grayscale heightmap (white = high)
};

// NASA Perseverance image-of-the-week shots (public/textures/nasa).
// They provide the close-up ground detail (color + bump) and the sun disc.
export const NASA = {
  ground: 'textures/nasa/w286-zcam.png',  // Mastcam-Z gravel/rock-slab ground (sol 1939)
  sand: 'textures/nasa/w288-zcam.png',    // Mastcam-Z sand + boulders (sol 1955)
  rock: 'textures/nasa/w289-watson.jpg',  // WATSON rock close-up (sol 1934), used on boulders
  sun: 'textures/nasa/w287-zcam.png',     // Mastcam-Z Phobos transiting the Sun (sol 1948)
};

export const PLANET = {
  radius: 300,        // world units (tiny vs. the real 3390 km, so you can fly around it)
  segments: 320,      // mesh resolution per cube face edge
  relief: 30,         // procedural height range, world units
  heightScale: 20,    // height range when using your own mars-height.png
  detailTile: 14,     // world units per repeat of the NASA close-up texture
  bump: 0.25,         // world-unit height of the photo bump relief
  detailNear: 30,     // photo detail is full strength inside this distance...
  detailFar: 320,     // ...and fades out by this distance
  boulders: 7000,
  minAltitude: 2.5,   // closest you can get to the ground
  atmosphere: 30,     // atmosphere shell thickness
};
