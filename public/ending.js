export function endingSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.seconds ?? 0) || (value.seconds ?? 0) < 0 || (value.seconds ?? 0) > 15) {
    throw Object.assign(new Error('errorEndingOptions'), { code: 'errorEndingOptions', status: 400 });
  }
  // Missing settings keep saved sessions and older API clients unchanged.
  return { seconds: value.seconds ?? 0 };
}

export const hasEnding = value => Boolean(value?.seconds > 0);
export const endingSeconds = (settings, duration) => Math.min(endingSettings(settings).seconds, duration / 2);

export function musicalEndingPrompt(prompt, settings, duration) {
  if (!hasEnding(settings)) return prompt;
  return prompt + '\nFor the final ' + endingSeconds(settings, duration) + ' seconds, create a complete musical outro. Resolve the main phrase, let existing instruments fall away and allow reverb tails to decay naturally. Finish the composition before the audio ends. No abrupt cutoff or new section at the end.';
}
