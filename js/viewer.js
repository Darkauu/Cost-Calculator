// Visor 3D con three.js. Las caras que necesitan soporte se pintan en otro color.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
  camera.up.set(0, 0, 1); // Z hacia arriba, igual que en el slicer
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(sun);

  let mesh = null;
  let grid = null;
  let needsRender = true;

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  new ResizeObserver(resize).observe(container);
  resize();

  controls.addEventListener('change', () => { needsRender = true; });
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    if (needsRender) {
      sun.position.copy(camera.position);
      renderer.render(scene, camera);
      needsRender = false;
    }
  })();

  function show(positions, overhangMask, colors) {
    clear();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const base = new THREE.Color(colors.base);
    const warn = new THREE.Color(colors.overhang);
    const col = new Float32Array(positions.length);
    const triCount = positions.length / 9;
    for (let t = 0; t < triCount; t++) {
      const c = overhangMask && overhangMask[t] ? warn : base;
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], t * 9 + k * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const center = bb.getCenter(new THREE.Vector3());
    geo.translate(-center.x, -center.y, -bb.min.z); // apoyar en la cama

    mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, flatShading: true }));
    scene.add(mesh);

    const size = bb.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 10;
    grid = new THREE.GridHelper(Math.ceil(radius * 2 / 10) * 10, 10, colors.grid, colors.grid);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const target = new THREE.Vector3(0, 0, size.z / 2);
    controls.target.copy(target);
    camera.position.set(radius * 1.4, -radius * 1.8, size.z / 2 + radius * 1.2);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  function clear() {
    for (const obj of [mesh, grid]) {
      if (!obj) continue;
      scene.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose?.();
    }
    mesh = grid = null;
    needsRender = true;
  }

  return { show, clear };
}
