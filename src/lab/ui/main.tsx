/**
 * Sound Lab entry (`/lab/`, phase-2c contract L1): mounts the page over a LabModel and the real audio graph,
 * wires the keyboard shortcuts (src/lab/ui/keys.ts) and the browser-only pieces of export: a download through
 * an object URL (the JSON never leaves the browser) and the clipboard. No service worker: the lab is never
 * part of the app's offline cache.
 */
import { render } from 'preact';
import { LabAudio } from './lab-audio';
import { keyCommand, shortcutApplies, targetKind, type KeyTargetLike } from './keys';
import { LabModel } from './model';
import { LabView } from './view';

/** Offers `text` as a download named `fileName`. */
function saveFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return Promise.reject(new Error('no clipboard access'));
  return clipboard.writeText(text);
}

function target(e: KeyboardEvent): KeyTargetLike | null {
  return e.target instanceof Element ? (e.target as KeyTargetLike) : null;
}

const root = document.getElementById('lab');
if (root !== null) {
  const model = new LabModel({ audio: new LabAudio(), saveFile, copyText });
  render(<LabView model={model} />, root);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cmd = keyCommand(e.code, e.key);
    if (cmd === null || !shortcutApplies(cmd, targetKind(target(e)))) return;
    e.preventDefault(); // no page scroll on ↑/↓/Space
    model.key(cmd, e.repeat);
  });
  // A focused button or checkbox activates itself on Space keyup: the shortcut already took the key.
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && targetKind(target(e)) === 'toggle') e.preventDefault();
  });
}
