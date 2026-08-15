import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { engine } from './audio/AudioEngine';

// Dev-only handle for driving the audio graph from the console. Audio bugs are
// far easier to chase when you can poke the engine directly.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.engine = engine;
  void import('./audio/jamFactory').then((m) => {
    w.renderJam = m.renderJam;
    w.JAMS = m.JAMS;
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
