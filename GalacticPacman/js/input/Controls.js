// js/input/Controls.js
//
// Hold-to-move controls, from the keyboard or from on-screen touch buttons.
//
//   input.left / input.right — true while held (arrow keys, A/D, or the
//                              ◀ ▶ pad). Left walks Pac-Man counter-
//                              clockwise round his planet, right clockwise.
//   onJump()                 — Space / W / Up arrow, or the jump button
//   onContinue()             — Enter, the jump button, or a tap on the
//                              screen (only used on the Game Over / level
//                              complete screens; returns true if it did
//                              something)
//
// The touch buttons only appear on touch screens: they show after a touch
// and hide again as soon as a key is pressed, so a keyboard player never
// sees them. (Styles: .touch-controls in css/styles.css.)

export const input = { left: false, right: false };

// Each source tracked separately, so letting go of a key doesn't cancel a
// thumb still on the pad (or the other way round).
const keysHeld = { left: false, right: false };
const padHeld = { left: false, right: false };
function refresh() {
  input.left = keysHeld.left || padHeld.left;
  input.right = keysHeld.right || padHeld.right;
}

const LEFT_KEYS = new Set(['ArrowLeft', 'a', 'A']);
const RIGHT_KEYS = new Set(['ArrowRight', 'd', 'D']);
const JUMP_KEYS = new Set([' ', 'ArrowUp', 'w', 'W']);

export function initControls(canvas, { onJump, onContinue }) {
  // ---- Keyboard ----
  window.addEventListener('keydown', (e) => {
    showTouchButtons(false);
    if (LEFT_KEYS.has(e.key)) keysHeld.left = true;
    else if (RIGHT_KEYS.has(e.key)) keysHeld.right = true;
    else if (JUMP_KEYS.has(e.key)) { if (!e.repeat) onJump(); }
    else if (e.key === 'Enter') onContinue();
    else return;
    refresh();
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (LEFT_KEYS.has(e.key)) keysHeld.left = false;
    else if (RIGHT_KEYS.has(e.key)) keysHeld.right = false;
    refresh();
  });
  // Switching away mid-press never delivers the keyup — let go of everything.
  window.addEventListener('blur', () => {
    keysHeld.left = keysHeld.right = padHeld.left = padHeld.right = false;
    refresh();
  });

  // ---- Touch buttons ----
  const root = document.createElement('div');
  root.className = 'touch-controls';
  root.innerHTML = `
    <div class="touch-pad" aria-label="Move">
      <div class="touch-btn" data-side="left" aria-label="Left">${ARROW_LEFT}</div>
      <div class="touch-btn" data-side="right" aria-label="Right">${ARROW_RIGHT}</div>
    </div>
    <div class="touch-btn touch-jump" aria-label="Jump">${CHEVRON_UP}</div>`;
  document.body.appendChild(root);

  const pad = root.querySelector('.touch-pad');
  const leftBtn = pad.querySelector('[data-side="left"]');
  const rightBtn = pad.querySelector('[data-side="right"]');
  const jumpBtn = root.querySelector('.touch-jump');

  // The pad: each finger on it counts for whichever half it's over, so a
  // thumb can slide from ◀ to ▶ without lifting.
  const padFingers = new Map(); // pointerId -> 'left' | 'right'
  function padUpdate() {
    let l = false, r = false;
    for (const side of padFingers.values()) { if (side === 'left') l = true; else r = true; }
    padHeld.left = l; padHeld.right = r;
    leftBtn.classList.toggle('pressed', l);
    rightBtn.classList.toggle('pressed', r);
    refresh();
  }
  function padSide(e) {
    const box = pad.getBoundingClientRect();
    return e.clientX < box.left + box.width / 2 ? 'left' : 'right';
  }
  pad.addEventListener('pointerdown', (e) => {
    try { pad.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    padFingers.set(e.pointerId, padSide(e));
    padUpdate();
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!padFingers.has(e.pointerId)) return;
    padFingers.set(e.pointerId, padSide(e));
    padUpdate();
  });
  const padRelease = (e) => { if (padFingers.delete(e.pointerId)) padUpdate(); };
  pad.addEventListener('pointerup', padRelease);
  pad.addEventListener('pointercancel', padRelease);
  pad.addEventListener('lostpointercapture', padRelease);

  // Jump: fires on press (not release) so it feels instant.
  jumpBtn.addEventListener('pointerdown', (e) => {
    jumpBtn.classList.add('pressed');
    if (!onContinue()) onJump();
    e.preventDefault();
  });
  const jumpRelease = () => jumpBtn.classList.remove('pressed');
  jumpBtn.addEventListener('pointerup', jumpRelease);
  jumpBtn.addEventListener('pointercancel', jumpRelease);
  jumpBtn.addEventListener('pointerleave', jumpRelease);

  // A tap anywhere on the game itself only continues from the Game Over /
  // level-complete screens (moving and jumping are the buttons' job).
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') showTouchButtons(true);
    onContinue();
  });

  // No long-press menus, text selection or double-tap zoom on the controls.
  for (const el of [root, canvas]) el.addEventListener('contextmenu', (e) => e.preventDefault());
  blockZoomGestures();

  // Any touch anywhere shows the buttons; start with them showing on
  // devices whose main pointer is a finger.
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') showTouchButtons(true); }, { capture: true });
  showTouchButtons(window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

// Stops the page zooming when the jump button (or anything) is tapped
// twice quickly, or pinched. iPhones ignore the viewport's "no zoom"
// setting; what actually stops their double-tap zoom is cancelling the
// touchend. (The game itself listens to pointer events, which still
// arrive — and the audio unlock still counts the touch as a tap.)
function blockZoomGestures() {
  const block = (e) => { if (e.cancelable) e.preventDefault(); };
  document.addEventListener('touchend', block, { passive: false });
  document.addEventListener('dblclick', block, { passive: false });
  // Safari's own pinch-zoom events.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, block, { passive: false });
  }
}

function showTouchButtons(show) {
  document.body.classList.toggle('touch-mode', show);
}

// Icons: simple strokes in the buttons' own color (currentColor).
const svg = (path) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_LEFT = svg('M14.5 6 L8.5 12 L14.5 18');
const ARROW_RIGHT = svg('M9.5 6 L15.5 12 L9.5 18');
const CHEVRON_UP = svg('M6 14.5 L12 8.5 L18 14.5');
