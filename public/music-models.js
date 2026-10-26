export const musicModels = [
  { id: 'acestep-v15-turbo', labelKey: 'modelTurbo' },
  { id: 'acestep-v15-xl-turbo', labelKey: 'modelXlTurbo' },
];

export function musicModel(value = 'acestep-v15-turbo') {
  if (!musicModels.some(model => model.id === value)) {
    throw Object.assign(new Error('errorMusicModel'), { code: 'errorMusicModel', status: 400 });
  }
  return value;
}
