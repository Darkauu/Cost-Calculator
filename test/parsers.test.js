import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseSTL, parseOBJ, parse3MF, parseGcode } from '../js/parsers.js';
import { analyzeMesh } from '../js/geometry.js';
import { box, binarySTL, asciiSTL } from './helpers.js';

const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test('STL binario y ASCII', () => {
  const { positions } = box(10, 20, 30);
  for (const buf of [binarySTL(positions), asciiSTL(positions)]) {
    const p = parseSTL(buf);
    assert.equal(p.length, positions.length);
    close(analyzeMesh(p).volumeMm3, 6000);
  }
});

test('OBJ con caras cuadradas e índices v/vt/vn', () => {
  const obj = `
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
v 0 0 10
v 10 0 10
v 10 10 10
v 0 10 10
f 1/1/1 4/1/1 3/1/1 2/1/1
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;
  const p = parseOBJ(obj);
  assert.equal(p.length / 9, 12);
  close(analyzeMesh(p).volumeMm3, 1000);
});

function modelXml(objects, build) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>${objects}</resources>
 <build>${build}</build>
</model>`;
}
function meshXml(id, { vertices, faces }) {
  return `<object id="${id}" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
  <triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`;
}

test('3MF simple con transformación de escala ×2', () => {
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(modelXml(meshXml(1, box(10, 10, 10)), '<item objectid="1" transform="2 0 0 0 2 0 0 0 2 5 5 0"/>')),
  });
  const r = parse3MF(zip.buffer);
  assert.equal(r.sliced, null);
  const a = analyzeMesh(r.positions);
  close(a.volumeMm3, 8000);
  close(a.min[0], 5);
});

test('3MF estilo Bambu Studio: componentes en archivos separados + slice_info multicolor', () => {
  const main = modelXml(
    `<object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>`,
    '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/>',
  );
  const obj = modelXml(meshXml(1, box(20, 20, 20)), '');
  const slice = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="5400"/>
    <metadata key="weight" value="42.50"/>
    <filament id="1" type="PLA" color="#FFFFFF" used_m="10" used_g="30.00"/>
    <filament id="2" type="PLA" color="#FF0000" used_m="4" used_g="12.50"/>
  </plate>
</config>`;
  const zip = zipSync({
    '3D/3dmodel.model': strToU8(main),
    '3D/Objects/object_1.model': strToU8(obj),
    'Metadata/slice_info.config': strToU8(slice),
  });
  const r = parse3MF(zip.buffer);
  close(analyzeMesh(r.positions).volumeMm3, 8000);
  close(r.sliced.grams, 42.5);
  close(r.sliced.hours, 1.5);
  assert.equal(r.sliced.filaments.length, 2);
  assert.equal(r.sliced.plates, 1);
});

test('G-code de Bambu Studio: tiempo y peso del encabezado', () => {
  const g = `; HEADER_BLOCK_START
; BambuStudio 02.03.00
; model printing time: 2h 10m 5s; total estimated time: 2h 16m 40s
; total layer number: 150
; total filament weight [g] : 37.21
; HEADER_BLOCK_END
; filament_type = PLA;PETG
; filament_colour = #FFFFFF;#000000
G28
; filament used [g] = 30.01, 7.20
`;
  const r = parseGcode(g);
  close(r.grams, 37.21);
  close(r.hours, (2 * 3600 + 16 * 60 + 40) / 3600);
  assert.equal(r.filaments.length, 2);
  assert.equal(r.filaments[1].type, 'PETG');
});

test('G-code sin resumen lanza error claro', () => {
  assert.throws(() => parseGcode('G28\nG1 X10\n'), /G-code/);
});
