export function sceneAtTime(scenes, seconds) {
  return scenes.findIndex((scene) => seconds >= scene.start && seconds < scene.end);
}

export function seekPlayer(video, seconds) {
  video.currentTime = Math.max(0, seconds);
}

function wordAtTime(words, seconds) {
  return words.findIndex((word) => seconds >= word.start && seconds < word.end);
}

export function synchronizePlayer({
  video,
  playhead,
  duration,
  scenes,
  words,
  onPosition,
}) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let animationFrame = 0;

  function paint() {
    const seconds = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const progress = duration > 0 ? Math.min(100, Math.max(0, (seconds / duration) * 100)) : 0;
    playhead.dataset.time = String(Number(seconds.toFixed(3)));
    playhead.style.setProperty('--playhead-position', `${progress}%`);
    onPosition({
      seconds,
      sceneIndex: sceneAtTime(scenes, seconds),
      wordIndex: wordAtTime(words, seconds),
    });
  }

  function tick() {
    paint();
    if (!video.paused && !video.ended && !reducedMotion.matches) {
      animationFrame = window.requestAnimationFrame(tick);
    }
  }

  function start() {
    window.cancelAnimationFrame(animationFrame);
    paint();
    if (!reducedMotion.matches) animationFrame = window.requestAnimationFrame(tick);
  }

  function stop() {
    window.cancelAnimationFrame(animationFrame);
    paint();
  }

  video.addEventListener('playing', start);
  video.addEventListener('pause', stop);
  video.addEventListener('ended', stop);
  video.addEventListener('timeupdate', paint);
  video.addEventListener('seeked', paint);
  reducedMotion.addEventListener('change', stop);
  paint();

  return () => {
    window.cancelAnimationFrame(animationFrame);
    video.removeEventListener('playing', start);
    video.removeEventListener('pause', stop);
    video.removeEventListener('ended', stop);
    video.removeEventListener('timeupdate', paint);
    video.removeEventListener('seeked', paint);
    reducedMotion.removeEventListener('change', stop);
  };
}
