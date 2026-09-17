import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const doc = await io.read('C:/Users/Wprot/OneDrive/Рабочий стол/Village/house_village.glb');
function walk(node: Node, depth: number): void {
  const mesh = node.getMesh();
  let tris = 0;
  if (mesh) for (const p of mesh.listPrimitives()) {
    const i = p.getIndices();
    tris += (i ? i.getCount() : p.getAttribute('POSITION')!.getCount()) / 3;
  }
  console.log('  '.repeat(depth) + '- ' + (node.getName() || '(без имени)') + (mesh ? ` [меш ${mesh.getName() || '?'}, ${Math.round(tris)} тр]` : ''));
  for (const child of node.listChildren()) walk(child, depth + 1);
}
for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, 0);
