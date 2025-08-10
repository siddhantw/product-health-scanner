import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './product_health_scanner_react_pwa_demo.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}
