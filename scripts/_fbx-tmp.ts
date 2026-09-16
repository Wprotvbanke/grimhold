(globalThis as unknown as { document: unknown }).document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};
import { readFileSync } from 'node:fs';
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const bytes = readFileSync('C:/Users/Wprot/OneDrive/Рабочий стол/Animacija_Sword/SwordAnims.fbx');
const group = new FBXLoader().parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  '',
);
console.log('клипы:');
for (const clip of group.animations)
  console.log(' ', clip.name, clip.duration.toFixed(2), 'с,', clip.tracks.length, 'дорожек');
let bones = 0;
group.traverse((node) => { if ((node as unknown as { isBone: boolean }).isBone) bones++; });
console.log('костей:', bones);
const names: string[] = [];
group.traverse((node) => { if ((node as unknown as { isBone: boolean }).isBone) names.push(node.name); });
console.log('первые кости:', names.slice(0, 12).join(', '));
