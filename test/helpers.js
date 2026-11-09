// Generadores de mallas de prueba.

// Caja de w×d×h mm con la esquina en el origen (normales hacia afuera).
export function box(w, d, h, ox = 0, oy = 0, oz = 0) {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ].map(([x, y, z]) => [x + ox, y + oy, z + oz]);
  const f = [
    [0, 2, 1], [0, 3, 2], // abajo
    [4, 5, 6], [4, 6, 7], // arriba
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  return { vertices: v, faces: f, positions: new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i]))) };
}

export function concat(...arrays) {
  const out = new Float32Array(arrays.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

export function binarySTL(positions) {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  view.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let k = 0; k < 9; k++) { view.setFloat32(o, positions[t * 9 + k], true); o += 4; }
    o += 2;
  }
  return buf;
}

export function asciiSTL(positions) {
  let s = 'solid test\n';
  for (let t = 0; t < positions.length; t += 9) {
    s += 'facet normal 0 0 0\nouter loop\n';
    for (let k = 0; k < 9; k += 3) s += `vertex ${positions[t + k]} ${positions[t + k + 1]} ${positions[t + k + 2]}\n`;
    s += 'endloop\nendfacet\n';
  }
  return new TextEncoder().encode(s + 'endsolid test\n').buffer;
}
