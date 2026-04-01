function getAudioContextInstance(current) {
  if (current) return current;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  return new Ctx();
}

export function createInventoryAudio() {
  let enabled = true;
  let audioContext = null;

  function playTone(frequency, durationMs, gain = 0.05, type = 'sine') {
    if (!enabled) return;
    audioContext = getAudioContextInstance(audioContext);
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
      void audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gainNode.gain.value = gain;
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + durationMs / 1000);
  }

  return {
    setEnabled(value) {
      enabled = !!value;
    },
    playSuccessBeeps() {
      playTone(920, 70, 0.04, 'triangle');
      setTimeout(() => playTone(1180, 80, 0.04, 'triangle'), 80);
    },
    playErrorBeep() {
      playTone(280, 180, 0.05, 'sawtooth');
    }
  };
}

