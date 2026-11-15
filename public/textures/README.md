# Mars textures

Optional global maps (equirectangular, 2:1 aspect), wrapped around the planet.
Any that are missing fall back to a procedural planet. Paths live in `src/config.js`.

| File              | Purpose                                                   |
|-------------------|-----------------------------------------------------------|
| `mars-color.jpg`  | Global color map (vertex colors sampled from it)          |
| `mars-height.png` | Global grayscale heightmap (white = high), drives terrain |

`nasa/` holds the Perseverance image-of-the-week photos used for close-up ground
detail (color + bump), boulders and the sun disc.
