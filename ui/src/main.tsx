import { createRoot } from 'react-dom/client';
import './styles/zb-tokens.css';
import './styles/style.css';
import { App } from './app/App';
import { installGlobals } from './app/globals';

installGlobals();
createRoot(document.getElementById('app')!).render(<App />);
