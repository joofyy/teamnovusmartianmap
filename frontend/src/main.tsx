import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './tailwind.css';
import './styles.css';
import './modern-ui.css';
import './liquid-glass.css';
import './mission-intelligence.css';
import './marscope-experience.css';
import './ux-polish.css';
import './ui-refresh.css';
import './workspace-cleanup.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("MARSCOPE offline shell registration failed", error);
    });
  });
}
