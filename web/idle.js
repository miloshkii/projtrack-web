// Auto-lock after a period without keyboard, pointer or touch activity.
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'];

export function createIdleLock({ onIdle, minutes = 15, target = document }) {
  let timer = null;
  let running = false;
  let delayMs = minutes * 60000;

  const arm = () => {
    clearTimeout(timer);
    if (running) timer = setTimeout(onIdle, delayMs);
  };
  for (const name of ACTIVITY_EVENTS) target.addEventListener(name, arm, { capture: true, passive: true });

  return {
    start() { running = true; arm(); },
    stop() { running = false; clearTimeout(timer); },
    setMinutes(value) { delayMs = value * 60000; arm(); },
  };
}
