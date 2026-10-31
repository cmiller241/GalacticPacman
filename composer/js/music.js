'use strict';
// Music theory helpers: note names, scales, frequencies, drum names.
const Music = (() => {
  const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const ROOTS = ['C', 'C♯ / D♭', 'D', 'E♭', 'E', 'F', 'F♯ / G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

  const SCALES = {
    major: { name: 'Major (bright)', steps: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: 'Minor (dark)', steps: [0, 2, 3, 5, 7, 8, 10] },
    harmonicMinor: { name: 'Harmonic minor (epic)', steps: [0, 2, 3, 5, 7, 8, 11] },
    dorian: { name: 'Dorian (spacey minor)', steps: [0, 2, 3, 5, 7, 9, 10] },
    lydian: { name: 'Lydian (dreamy)', steps: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
    phrygian: { name: 'Phrygian (alien)', steps: [0, 1, 3, 5, 7, 8, 10] },
    pentatonic: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    minorPentatonic: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    wholeTone: { name: 'Whole tone (sci-fi)', steps: [0, 2, 4, 6, 8, 10] },
    chromatic: { name: 'Chromatic (all notes)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  };

  // Offset from a scale's root to its relative major root (decides sharps vs flats).
  const REL_MAJOR = { minor: 3, harmonicMinor: 3, minorPentatonic: 3, dorian: 10, phrygian: 8, mixolydian: 5, lydian: 7 };

  function prefersFlats(key) {
    const maj = (key.root + (REL_MAJOR[key.scale] || 0)) % 12;
    return [5, 10, 3, 8, 1, 6].includes(maj); // F, B♭, E♭, A♭, D♭, G♭
  }

  function pitchClassName(pc, key) {
    return (key && prefersFlats(key) ? FLAT : SHARP)[((pc % 12) + 12) % 12];
  }

  function noteName(p, key) {
    return pitchClassName(p, key) + (Math.floor(p / 12) - 1);
  }

  function isBlack(p) {
    return [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
  }

  function inScale(p, key) {
    const steps = (SCALES[key.scale] || SCALES.major).steps;
    return steps.includes((((p - key.root) % 12) + 12) % 12);
  }

  function freq(p) {
    return 440 * Math.pow(2, (p - 69) / 12);
  }

  // Parallel major <-> minor: lower (or raise) the 3rd, 6th and 7th.
  function majorToMinor(p, root) {
    const deg = (((p - root) % 12) + 12) % 12;
    return [4, 9, 11].includes(deg) ? p - 1 : p;
  }
  function minorToMajor(p, root) {
    const deg = (((p - root) % 12) + 12) % 12;
    return [3, 8, 10].includes(deg) ? p + 1 : p;
  }

  // General MIDI drum map (what each row means on a drum track).
  const DRUMS = {
    35: 'Kick 2', 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare 2',
    41: 'Low Tom', 42: 'Closed Hat', 43: 'Low Tom 2', 44: 'Pedal Hat', 45: 'Mid Tom',
    46: 'Open Hat', 47: 'Mid Tom 2', 48: 'High Tom', 49: 'Crash', 50: 'High Tom 2',
    51: 'Ride', 52: 'China', 53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash',
    56: 'Cowbell', 57: 'Crash 2', 60: 'Zap Hi', 61: 'Zap', 62: 'Zap Lo', 63: 'Warp',
    64: 'Blip', 65: 'Laser',
  };

  function drumName(p) {
    return DRUMS[p] || '';
  }

  return { SHARP, FLAT, ROOTS, SCALES, noteName, pitchClassName, isBlack, inScale, freq, majorToMinor, minorToMajor, DRUMS, drumName, prefersFlats };
})();
