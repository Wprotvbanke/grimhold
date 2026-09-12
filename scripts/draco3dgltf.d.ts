/**
 * У draco3dgltf нет своих типов, а нужен он одному скрипту подготовки модели.
 * Описываем ровно то, чем пользуемся.
 */
declare module 'draco3dgltf' {
  export function createEncoderModule(): Promise<unknown>;
  export function createDecoderModule(): Promise<unknown>;
  const draco3d: {
    createEncoderModule(): Promise<unknown>;
    createDecoderModule(): Promise<unknown>;
  };
  export default draco3d;
}
