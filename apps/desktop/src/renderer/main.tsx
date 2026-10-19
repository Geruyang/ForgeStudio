import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import './styles/global.css';
import './styles/chat.css';
import './styles/panel.css';
import './styles/panes.css';
import './styles/diffpanel.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('未找到 #root 挂载点');
}

createRoot(rootEl).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
